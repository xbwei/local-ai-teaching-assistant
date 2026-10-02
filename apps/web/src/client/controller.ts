import {
  conversationLimits,
  validConversation,
  inputLimits,
  isShortSpokenAnswer,
  type ConversationMessage,
  type InputJob,
  type InputChoices,
  type InputBuild,
  type ProviderRunRequest,
  type CourseSourceReference,
} from "@laita/contracts/browser";
import {
  courseGroundingNoticeText,
  providerFailureText,
  speechFailureText,
} from "./presentation.ts";
import { InputApi, ClientError } from "./api.ts";
import type { AnswerAudioRef } from "./audio.ts";
export type Mode = ProviderRunRequest["mode"];
export type Phase =
  | "connecting"
  | "idle"
  | "switching"
  | "listening"
  | "transcribing"
  | "review"
  | "waiting"
  | "success"
  | "error"
  | "cancelled";
export type Message = {
  history?: import("@laita/contracts/browser").HistoryRef;
  leg?: string;
  role: "question" | "answer";
  text: string;
  provider?: string;
  provenance?: string;
  error?: boolean;
  audio?: AnswerAudioRef;
  sources?: readonly CourseSourceReference[];
};
export class LearningClient {
  phase: Phase = "connecting";
  status = "Connecting…";
  recordingIncomplete = false;
  private currentHistory:
    import("@laita/contracts/browser").HistoryRef | undefined;
  connected = false;
  messages: Message[] = [];
  transcript = "";
  localModel = "gemma4:12b-mlx";
  private history: ConversationMessage[] = [];
  mode: Mode | null = "LOCAL";
  choices: InputChoices | undefined;
  build: InputBuild | undefined;
  private transcriptRef = "";
  private sessionReady = false;
  private generation = 0;
  private abort = new AbortController();
  private choiceAbort: AbortController | undefined;
  private choicesRevision = 0;
  private notify: () => void;
  private api: InputApi;
  private pollMs: number;
  constructor(notify: () => void, api = new InputApi(), pollMs = 1000) {
    this.notify = notify;
    this.api = api;
    this.pollMs = pollMs;
  }
  get active() {
    return [
      "connecting",
      "switching",
      "listening",
      "transcribing",
      "review",
      "waiting",
    ].includes(this.phase);
  }
  private emit(phase: Phase, status = "") {
    this.phase = phase;
    this.status = status;
    this.notify();
  }
  private invalidate() {
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
    this.choiceAbort?.abort();
    this.choicesRevision++;
  }
  private clear() {
    this.currentHistory = undefined;
    this.history = [];
    this.messages = [];
    this.transcript = "";
    this.transcriptRef = "";
    this.choices = undefined;
    this.build = undefined;
    this.sessionReady = false;
  }
  private failed(error: unknown) {
    const history =
      error instanceof ClientError
        ? (error.history ?? this.currentHistory)
        : this.currentHistory;
    if (history)
      this.messages.push({
        role: "answer",
        provider: "Request",
        text: "The request did not finish. Review the recorded stages or report a problem.",
        error: true,
        history,
      });
    if (!history || history.recording === "INCOMPLETE")
      this.recordingIncomplete = true;
    this.emit(
      "error",
      error instanceof ClientError && error.status === 429
        ? "A little busy right now. Please try again shortly."
        : "We couldn’t finish that request. Please try again when you’re ready.",
    );
  }
  async boot() {
    this.invalidate();
    const g = this.generation;
    this.emit("connecting", "Connecting…");
    try {
      this.connected = true;
      await this.ensure();
      if (g === this.generation) this.emit("idle");
    } catch (e) {
      if (g === this.generation) this.failed(e);
    }
  }
  private async ensure() {
    if (this.sessionReady) return;
    const g = this.generation;
    await this.api.start(this.abort.signal);
    if (g !== this.generation) throw new ClientError();
    this.build = await this.api.build(this.abort.signal);
    if (g !== this.generation) throw new ClientError();
    this.sessionReady = true;
    await this.refreshChoices("");
  }
  async refreshChoices(text: string) {
    if (
      !this.sessionReady ||
      ["listening", "transcribing", "waiting"].includes(this.phase)
    )
      return;
    this.choiceAbort?.abort();
    const controller = new AbortController();
    this.choiceAbort = controller;
    const revision = ++this.choicesRevision;
    try {
      const choices = await this.api.choices(
        text,
        AbortSignal.any([controller.signal, this.abort.signal]),
      );
      if (revision !== this.choicesRevision) return;
      this.choices = choices;
      if (choices.local) this.localModel = choices.local.selectedModel;
      this.notify();
    } catch (e) {
      if (
        !controller.signal.aborted &&
        !this.abort.signal.aborted &&
        revision === this.choicesRevision
      ) {
        this.choices = undefined;
        this.failed(e);
      }
    }
  }
  select(mode: Mode) {
    if (
      (!this.active || this.phase === "review") &&
      this.choices?.providers.modes.some((m) => m.id === mode)
    ) {
      this.mode = mode;
      this.notify();
      if (this.phase === "review" && this.transcriptRef)
        void this.send(this.transcript, true);
    }
  }
  private request(text: string): ProviderRunRequest | undefined {
    const c = this.choices?.providers,
      mode = c?.modes.find((m) => m.id === this.mode);
    if (!c || !mode) return;
    const local = c.providers.find((p) => p.id === "LOCAL"),
      openai = c.providers.find((p) => p.id === "OPENAI");
    if (
      mode.providers.includes("LOCAL") &&
      (!local ||
        local.state === "UNAVAILABLE" ||
        local.state === "BUSY" ||
        !local.models.some((m) => m.id === this.localModel))
    )
      return;
    if (mode.providers.includes("OPENAI") && !openai?.models[0]) return;
    return {
      contractVersion: "provider-run-request.v1",
      clientRequestId: crypto.randomUUID(),
      mode: mode.id,
      input: {
        text,
        history: this.context(text).filter(
          (m) =>
            mode.id === "COMPARE" ||
            m.role === "USER" ||
            m.provider === mode.id,
        ),
      },
      capabilityIdentity: c.identity,
      ...(mode.providers.includes("LOCAL")
        ? { localModel: this.localModel }
        : {}),
      ...(mode.providers.includes("OPENAI")
        ? { openaiModel: openai!.models[0]!.id }
        : {}),
    };
  }
  async send(text: string, confirmed = false) {
    if (
      !this.connected ||
      !text.trim() ||
      new TextEncoder().encode(text).length > conversationLimits.maxBytes ||
      (this.active && !(confirmed && this.phase === "review"))
    )
      return;
    if (!confirmed) this.currentHistory = undefined;
    const source = confirmed ? "TRANSCRIPT" : "TYPED";
    if (confirmed) this.transcript = text;
    if (confirmed && !this.transcriptRef) return;
    const question: Message = { role: "question", text };
    this.messages.push(question);
    const g = this.generation;
    this.emit("connecting", "Checking available modes…");
    try {
      await this.ensure();
      const captured = await this.api.beginTurn(
        text,
        source,
        confirmed ? this.transcriptRef : undefined,
        this.abort.signal,
      );
      if (g !== this.generation) return;
      this.currentHistory = captured;
      question.history = captured;
      if (this.currentHistory.recording === "INCOMPLETE")
        this.recordingIncomplete = true;
      await this.refreshChoices(text);
      if (g !== this.generation) return;
      const request = this.request(text);
      if (!request) {
        await this.api.unsubmitted(this.currentHistory.turn);
        this.messages.push({
          role: "answer",
          provider: "Request",
          text: "That mode is unavailable for this question. No provider request was submitted.",
          error: true,
          history: this.currentHistory,
        });
        this.emit(
          confirmed ? "review" : "idle",
          "That mode isn’t available for this question. Choose an available mode.",
        );
        return;
      }
      const transcriptRef = this.transcriptRef;
      this.transcript = "";
      this.transcriptRef = "";
      this.emit("waiting", "Thinking… This may take a little while.");
      const job = await this.api.submit(
        {
          turnRef: this.currentHistory.turn,
          contractVersion: "input-submission.v1",
          clientKind: "COMPUTER",
          source,
          ...(confirmed ? { transcriptRef } : {}),
          request,
        },
        this.abort.signal,
      );
      await this.poll(job, g, false, request.mode);
    } catch (e) {
      if (g === this.generation) this.failed(e);
    }
  }
  async selectLocalModel(model: string) {
    if (this.active || !["gemma4:12b-mlx", "llama3.1:8b"].includes(model))
      return;
    const g = this.generation;
    this.emit("switching", `Switching to ${model}…`);
    try {
      await this.ensure();
      if (g !== this.generation) return;
      const result = await this.api.switchLocal(model, this.abort.signal);
      if (g !== this.generation) return;
      this.localModel = result.local.selectedModel;
      if (this.choices) this.choices = { ...this.choices, local: result.local };
      this.emit(
        result.ok ? "idle" : "error",
        result.ok
          ? ""
          : "Model switch failed. Local residency is unavailable; no model was substituted.",
      );
      await this.refreshChoices("");
    } catch (e) {
      if (g === this.generation) {
        this.choices = undefined;
        this.failed(e);
      }
    }
  }
  private context(text: string) {
    const history = [...this.history];
    // Trim whole shared USER turns until both provider projections fit. Independent
    // trimming would silently give the two Compare legs different user context.
    while (history.length && !validConversation(text, history)) {
      const nextTurn = history.findIndex((m, i) => i > 0 && m.role === "USER");
      history.splice(0, nextTurn < 0 ? history.length : nextTurn);
    }
    return history;
  }
  get canListen() {
    return this.connected && !this.active && this.choices?.speech === "READY";
  }
  beginListening() {
    if (!this.canListen) return false;
    this.emit("listening", "Listening… Press Stop when you’re ready.");
    return true;
  }
  microphoneDenied() {
    if (this.phase === "listening")
      this.emit(
        "error",
        "Microphone unavailable. You can still type your question.",
      );
  }
  async upload(bytes: Uint8Array) {
    if (this.phase !== "listening") {
      bytes.fill(0);
      return;
    }
    const g = this.generation;
    this.emit("transcribing", "Turning your words into text…");
    try {
      await this.ensure();
      const job = await this.api.upload(bytes, this.abort.signal);
      bytes.fill(0);
      await this.poll(job, g, true);
    } catch (e) {
      if (g === this.generation) this.failed(e);
    } finally {
      bytes.fill(0);
    }
  }
  private async poll(job: InputJob, g: number, speech: boolean, mode?: Mode) {
    const deadline = Date.now() + inputLimits.observationMs;
    while (g === this.generation) {
      if (job.history) this.currentHistory = job.history;
      if (job.history?.recording === "INCOMPLETE")
        this.recordingIncomplete = true;
      if (
        speech &&
        job.state === "REVIEW" &&
        job.cleanup === "DELETED" &&
        job.transcript
      ) {
        this.transcriptRef = job.transcript.transcriptRef;
        this.transcript = job.transcript.text;
        if (
          new TextEncoder().encode(this.transcript).length >
          conversationLimits.maxBytes
        ) {
          this.emit(
            "error",
            "The transcript is too long. Please record a shorter question.",
          );
          return;
        }
        this.emit("review");
        await this.send(this.transcript, true);
        return;
      }
      if (
        !speech &&
        job.state === "COMPLETED" &&
        job.result &&
        job.result.mode === mode
      ) {
        const grounding = job.result.grounding;
        if (grounding && grounding.status !== "GROUNDED") {
          const question = this.messages.findLast((m) => m.role === "question");
          this.messages.push({
            role: "answer",
            provider: "Course sources",
            ...(job.history ? { history: job.history } : {}),
            text: courseGroundingNoticeText(grounding.status, question?.text),
            error: true,
          });
          this.messages = this.messages.slice(-24);
          this.emit("success");
          return;
        }
        for (const leg of job.result.legs)
          this.messages.push({
            role: "answer",
            provider: leg.provider === "LOCAL" ? "Local" : "OpenAI",
            leg: leg.runRef,
            ...(job.history ? { history: job.history } : {}),
            text:
              leg.status === "COMPLETED"
                ? leg.output!.text
                : providerFailureText(
                    leg.provider,
                    leg.failure!.code,
                    leg.failure!.retryable,
                  ),
            error: leg.status !== "COMPLETED",
            ...(leg.status === "COMPLETED"
              ? {
                  audio: {
                    jobRef: job.jobRef,
                    runRef: leg.runRef,
                    automatic: job.result.mode !== "COMPARE",
                    speechEligible: isShortSpokenAnswer(leg.output!.text),
                  },
                }
              : {}),
            ...(leg.provenance
              ? {
                  provenance: `${leg.provenance.actualProvider} · ${leg.provenance.actualModel}`,
                }
              : {}),
            ...(grounding?.status === "GROUNDED" && leg.provider === "LOCAL"
              ? { sources: grounding.sources }
              : {}),
          });
        const question = this.messages.findLast((m) => m.role === "question");
        if (question) {
          const answers: ConversationMessage[] = job.result.legs
            .filter((l) => l.status === "COMPLETED")
            .map((l) => ({
              role: "ASSISTANT",
              provider: l.provider,
              content: l.output!.text,
            }));
          this.history = [
            ...this.context(question.text),
            { role: "USER", content: question.text },
            ...answers,
          ];
          this.history = this.context("");
        }
        this.messages = this.messages.slice(-24);
        this.emit("success");
        return;
      }
      const speechFailure = speech && speechFailureText(job.state);
      if (speechFailure) {
        if (job.history)
          this.messages.push({
            role: "answer",
            provider: "Speech input",
            text: speechFailure,
            error: true,
            history: job.history,
          });
        this.emit(
          job.state === "CANCELLED" ? "cancelled" : "error",
          speechFailure,
        );
        return;
      }
      if (!["ACCEPTED", "PROCESSING"].includes(job.state))
        throw new ClientError();
      if (Date.now() >= deadline) {
        await this.api.cancel(job.jobRef);
        throw new ClientError();
      }
      await new Promise<void>((resolve, reject) => {
        const signal = this.abort.signal;
        const stop = () => {
          clearTimeout(timer);
          reject(new ClientError());
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", stop);
          resolve();
        }, this.pollMs);
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop();
      });
      const next = await this.api.job(job.jobRef, this.abort.signal);
      if (next.sequence < job.sequence) throw new ClientError();
      job = next;
    }
  }
  async cancel() {
    if (!this.active) return;
    this.invalidate();
    this.sessionReady = false;
    this.transcript = "";
    this.transcriptRef = "";
    this.emit("connecting", "Cancelling…");
    const g = this.generation;
    try {
      await this.api.reset();
      if (g !== this.generation) return;
      this.emit("cancelled", "Cancelled. Ask whenever you’re ready.");
    } catch (e) {
      if (g === this.generation) this.failed(e);
    }
  }
  async reset(preserveMode = false) {
    this.invalidate();
    this.clear();
    if (!preserveMode) this.mode = "LOCAL";
    this.emit("connecting", "Starting a new conversation…");
    const g = this.generation;
    try {
      await this.api.reset();
      if (g !== this.generation) return;
      await this.ensure();
      if (g === this.generation) this.emit("idle");
    } catch (e) {
      if (g === this.generation) this.failed(e);
    }
  }
  close() {
    this.invalidate();
    this.clear();
    this.connected = false;
    this.emit("connecting", "Connecting…");
  }
}
