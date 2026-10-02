import { createHistoryCapture, type HistoryCapture } from "./history.ts";
import { CoursePreparationError } from "./course-execution.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import {
  inputLimits,
  isInputRef,
  isInputClient,
  isInputSubmission,
  isTtsSynthesisRequest,
  isShortSpokenAnswer,
  isProviderRunResult,
  isCapabilityAvailability,
  canonicalJson,
  type InputJob,
  type LocalSelection,
  type ProviderHealthSnapshot,
  type ProviderRunRequest,
} from "@laita/contracts";
import { createPublicError, createCorrelationId } from "@laita/runtime";
import { classifyInput } from "@laita/safety";
import { speechLanguage, validateWav } from "@laita/speech";
import type { createSpeechService } from "@laita/speech";
export interface InputPorts {
  history?: import("@laita/persistence").HistoryRepository;
  buildIdentity?: string;
  health?(): ProviderHealthSnapshot;
  localState?(): LocalSelection;
  switchLocal?(
    model: LocalSelection["selectedModel"],
    signal: AbortSignal,
  ): Promise<boolean>;
  speech: ReturnType<typeof createSpeechService>;
  acquire(): undefined | (() => void);
  capabilities(text?: string): unknown;
  execute(
    request: ProviderRunRequest,
    signal: AbortSignal,
    sessionRef: `session-${string}`,
    trace?: import("@laita/contracts").Trace,
    source?: "TYPED" | "TRANSCRIPT",
  ): Promise<unknown>;
}
interface Job {
  capture?: HistoryCapture;
  value: InputJob;
  digest: string;
  consumed?: boolean;
  controller: AbortController;
}
interface Session {
  conversation: string;
  drafts: Map<
    string,
    { capture: HistoryCapture; text: string; source: string; consumed: boolean }
  >;
  media: Map<string, { capture: HistoryCapture; leg: string }>;
  owner: string;
  providerRef: `session-${string}`;
  jobs: Map<string, Job>;
  pending: Set<AbortController>;
  sequence: number;
  valid: boolean;
}
const ref = () => randomBytes(32).toString("hex");
export function installInputRoutes(
  app: Express,
  ports: InputPorts,
  authenticate: (req: Request, res: Response) => false | { owner: string },
  limits: Readonly<{
    uploadMs: number;
  }> = inputLimits,
) {
  const sessions = new Map<string, Session>();
  function fail(res: Response, status = 400) {
    if (!res.headersSent && res.locals.capture)
      res.setHeader(
        "X-History-Recording",
        (res.locals.capture as HistoryCapture).ref.recording,
      );
    if (!res.headersSent) res.setHeader("Connection", "close");
    return res
      .status(status)
      .json(
        createPublicError(
          status === 404
            ? "NOT_FOUND"
            : status === 503
              ? "SERVICE_UNAVAILABLE"
              : "INVALID_REQUEST",
          createCorrelationId(),
        ),
      );
  }
  function reset(id: string) {
    const s = sessions.get(id);
    if (!s) return true;
    s.valid = false;
    sessions.delete(id);
    for (const draft of s.drafts.values())
      if (!draft.consumed) {
        draft.capture.event("CAPTURE", "RESET");
        draft.capture.outcome("CANCELLED");
      }
    for (const j of s.jobs.values())
      if (
        ["ACCEPTED", "PROCESSING"].includes(j.value.state) ||
        (j.value.state === "REVIEW" && !j.consumed)
      ) {
        j.capture?.event("CAPTURE", "RESET");
        j.capture?.outcome("CANCELLED");
      }
    for (const c of s.pending) c.abort();
    s.pending.clear();
    for (const j of s.jobs.values()) j.controller.abort();
    s.jobs.clear();
    return ports.speech.releaseOwner(id);
  }
  function session(req: Request, res: Response) {
    const b = authenticate(req, res);
    if (!b) return;
    const id = req.get("x-input-session");
    const s = id && sessions.get(id);
    if (!s || s.owner !== b.owner) {
      fail(res, 404);
      return;
    }
    return s;
  }
  function publish(s: Session, j: Job, patch: Partial<InputJob>) {
    if (!s.valid || j.controller.signal.aborted) return;
    j.value = { ...j.value, ...patch, sequence: j.value.sequence + 1 };
  }
  async function body(
    req: Request,
    s: Session,
    max: number,
    observation = false,
  ): Promise<Buffer> {
    if (!observation && s.pending.size >= 1) throw new Error();
    const c = new AbortController();
    if (!observation) s.pending.add(c);
    let size = 0;
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        req.off("data", data);
        req.off("end", end);
        req.off("aborted", error);
        req.off("error", error);
        c.signal.removeEventListener("abort", error);
        s.pending.delete(c);
      };
      const error = () => {
        cleanup();
        for (const b of chunks) b.fill(0);
        req.pause();
        reject(new Error());
      };
      const data = (b: Buffer) => {
        size += b.length;
        if (size > max || chunks.length >= inputLimits.uploadChunks) {
          b.fill(0);
          error();
        } else chunks.push(b);
      };
      const end = () => {
        cleanup();
        const result = Buffer.concat(chunks);
        for (const b of chunks) b.fill(0);
        resolve(result);
      };
      const timer = setTimeout(error, limits.uploadMs);
      req.on("data", data);
      req.once("end", end);
      req.once("aborted", error);
      req.once("error", error);
      c.signal.addEventListener("abort", error, { once: true });
      if (!s.valid || req.aborted) error();
    });
  }
  function newJob(s: Session, key: string, digest: string) {
    if (s.jobs.size >= inputLimits.maxJobs) {
      const oldest = [...s.jobs].find(
        ([, j]) =>
          !["ACCEPTED", "PROCESSING"].includes(j.value.state) &&
          j.value.cleanup !== "PENDING",
      );
      if (!oldest) return;
      s.jobs.delete(oldest[0]);
    }
    const j: Job = {
      value: {
        contractVersion: "input-job.v1",
        jobRef: ref(),
        sequence: 1,
        state: "ACCEPTED",
        cleanup: "NOT_REQUIRED",
      },
      digest,
      controller: new AbortController(),
    };
    s.jobs.set(key, j);
    return j;
  }
  const hash = (v: unknown) =>
    createHash("sha256").update(canonicalJson(v)).digest("hex");
  function replay(
    s: Session,
    key: string,
    digest: string,
    res: Response,
    req: Request,
  ) {
    const j = s.jobs.get(key);
    if (!j) {
      const sequence = Number(req.get("x-input-sequence"));
      if (!Number.isSafeInteger(sequence) || sequence <= s.sequence) {
        fail(res, 409);
        return true;
      }
      s.sequence = sequence;
      return false;
    }
    if (j.digest !== digest) fail(res, 409);
    else res.json(j.value);
    return true;
  }
  app.use("/api/v1/input", (req, res, next) => {
    if (Object.keys(req.query).length || req.get("content-encoding")) {
      fail(res);
      return;
    }
    next();
  });
  app.post("/api/v1/input/sessions", (req, res) => {
    const b = authenticate(req, res);
    if (!b) return;
    if (
      req.get("transfer-encoding") ||
      (req.get("content-length") && req.get("content-length") !== "0")
    ) {
      fail(res);
      return;
    }
    for (const [id, existing] of sessions)
      if (existing.owner === b.owner) reset(id);
    if (sessions.size >= inputLimits.maxSessions) {
      const idle = [...sessions].find(
        ([, s]) =>
          s.pending.size === 0 &&
          [...s.jobs.values()].every(
            (j) =>
              !["ACCEPTED", "PROCESSING"].includes(j.value.state) &&
              j.value.cleanup !== "PENDING",
          ),
      );
      if (idle) reset(idle[0]);
    }
    if (sessions.size >= inputLimits.maxSessions) {
      fail(res, 503);
      return;
    }
    const id = ref();
    sessions.set(id, {
      ...b,
      conversation: id,
      drafts: new Map(),
      media: new Map(),
      providerRef: `session-${randomUUID()}`,
      jobs: new Map(),
      pending: new Set(),
      sequence: 0,
      valid: true,
    });
    res.json({
      contractVersion: "input-session.v1",
      sessionRef: id,
      limits: inputLimits,
    });
  });
  app.delete("/api/v1/input/session", (req, res) => {
    if (!session(req, res)) return;
    const cleaned = reset(req.get("x-input-session")!);
    res.json({
      contractVersion: "input-reset.v1",
      state: "RESET",
      cleanup: !cleaned
        ? "FAILED"
        : ports.speech.status() === "BUSY"
          ? "PENDING"
          : ports.speech.status() === "CLEANUP_FAILED"
            ? "FAILED"
            : "NOT_REQUIRED",
    });
  });
  app.get("/api/v1/input/build", (req, res) => {
    if (!session(req, res)) return;
    res.json({
      contractVersion: "input-build.v1",
      commit: ports.buildIdentity ?? null,
      profileVersion: "demo-profile.v4",
      sttIdentity: ports.speech.identity,
      ttsIdentity: ports.speech.ttsIdentity,
    });
  });
  app.post("/api/v1/input/choices", async (req, res) => {
    const s = session(req, res);
    if (!s) return;
    let b: Buffer | undefined;
    try {
      if (req.get("content-type") !== "application/json") throw new Error();
      b = await body(req, s, 32768);
      const v = JSON.parse(b.toString("utf8"));
      if (
        !v ||
        Object.keys(v).join(",") !== "text" ||
        typeof v.text !== "string" ||
        !s.valid
      )
        throw new Error();
      // Empty/whitespace choices query is readiness discovery, never inference input.
      // Reuse the existing conservative no-input context; submissions still classify text.
      const result = await ports.capabilities(
        v.text.trim() === "" ? undefined : v.text,
      );
      if (req.aborted || res.destroyed) return;
      if (!s.valid) {
        fail(res);
        return;
      }
      if (!isCapabilityAvailability(result)) {
        fail(res, 503);
        return;
      }
      const health = ports.health?.();
      const reason = (id: "LOCAL" | "OPENAI") => {
        if (result.modes.some((m) => m.id === id)) return "READY";
        const status = health?.providers.find((p) => p.provider === id)?.status;
        return status && status !== "READY" ? status : "POLICY_DENIED";
      };
      res.json({
        contractVersion: "input-choices.v1",
        reasons: {
          LOCAL: reason("LOCAL"),
          OPENAI: reason("OPENAI"),
          COMPARE: result.modes.some((m) => m.id === "COMPARE")
            ? "READY"
            : reason("LOCAL") === "READY" && reason("OPENAI") === "READY"
              ? "POLICY_DENIED"
              : "BOTH_PROVIDERS_REQUIRED",
        },
        providers: result,
        ...(ports.localState ? { local: ports.localState() } : {}),
        speech: ports.speech.status(),
        tts: ports.speech.ttsStatus(),
        limits: inputLimits,
      });
    } catch {
      fail(res);
    } finally {
      b?.fill(0);
    }
  });
  app.post("/api/v1/input/model", async (req, res) => {
    const s = session(req, res);
    if (!s) return;
    let bytes: Buffer | undefined;
    let release: (() => void) | undefined;
    const controller = new AbortController();
    const disconnected = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.once("close", disconnected);
    try {
      if (req.get("content-type") !== "application/json") throw new Error();
      bytes = await body(req, s, 256);
      const v = JSON.parse(bytes.toString("utf8"));
      if (
        !v ||
        Object.keys(v).join(",") !== "model" ||
        !["gemma4:12b-mlx", "llama3.1:8b"].includes(v.model) ||
        !s.valid
      )
        throw new Error();
      release = ports.acquire();
      if (!release || !ports.switchLocal || !ports.localState) {
        fail(res, 503);
        return;
      }
      s.pending.add(controller);
      const ok = await ports.switchLocal(v.model, controller.signal);
      if (controller.signal.aborted || res.destroyed || !s.valid) return;
      res.json({ ok, local: ports.localState() });
    } catch {
      if (!res.headersSent && !res.destroyed) fail(res);
    } finally {
      bytes?.fill(0);
      s.pending.delete(controller);
      release?.();
      res.off("close", disconnected);
    }
  });
  app.get("/api/v1/input/jobs/:id", (req, res) => {
    const s = session(req, res);
    if (!s) return;
    const j = [...s.jobs.values()].find(
      (j) => j.value.jobRef === req.params.id,
    );
    if (!j) {
      fail(res, 404);
      return;
    }
    res.json(j.value);
  });
  app.delete("/api/v1/input/jobs/:id", (req, res) => {
    const s = session(req, res);
    if (!s) return;
    const j = [...s.jobs.values()].find(
      (j) => j.value.jobRef === req.params.id,
    );
    if (!j) {
      fail(res, 404);
      return;
    }
    if (
      ["ACCEPTED", "PROCESSING"].includes(j.value.state) ||
      (j.value.state === "REVIEW" && !j.consumed)
    ) {
      j.capture?.event("CAPTURE", "CANCELLED");
      j.capture?.outcome("CANCELLED");
    } else j.capture?.event("CAPTURE", "CANCEL_REQUESTED_AFTER_TERMINAL");
    j.controller.abort();
    j.value = {
      ...(j.capture ? { history: j.capture.ref } : {}),
      contractVersion: "input-job.v1",
      jobRef: j.value.jobRef,
      sequence: j.value.sequence + 1,
      state: "CANCELLED",
      cleanup: j.value.cleanup,
    };
    res.json(j.value);
  });
  app.post("/api/v1/input/synthesis", async (req, res) => {
    const s = session(req, res);
    if (!s) return;
    const owner = req.get("x-input-session")!;
    let capture: HistoryCapture | undefined;
    let legRef: string | undefined;
    const started = Date.now();
    let terminal = false;
    let bytes: Buffer | undefined;
    let release: (() => void) | undefined;
    const controller = new AbortController();
    const disconnected = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.once("close", disconnected);
    try {
      if (req.get("content-type") !== "application/json") throw new Error();
      bytes = await body(req, s, 512);
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!isTtsSynthesisRequest(value) || !s.valid) throw new Error();
      const job = [...s.jobs.values()].find(
        (entry) =>
          entry.value.jobRef === value.jobRef &&
          entry.value.state === "COMPLETED",
      );
      const leg = job?.value.result?.legs.find(
        (entry) =>
          entry.runRef === value.runRef &&
          entry.status === "COMPLETED" &&
          typeof entry.output?.text === "string",
      );
      if (!leg?.output?.text) {
        fail(res, 404);
        return;
      }
      capture = job?.capture;
      res.locals.capture = capture;
      legRef = leg.runRef;
      if (!isShortSpokenAnswer(leg.output.text)) {
        capture?.event("TTS", "SKIPPED_LONG_ANSWER", undefined, legRef);
        terminal = true;
        res.json({ contractVersion: "tts-skipped.v1", reason: "LONG_ANSWER" });
        return;
      }
      capture?.event("TTS", "REQUESTED", undefined, legRef);
      if (ports.speech.ttsStatus() !== "READY") {
        capture?.event("TTS", ports.speech.ttsStatus(), undefined, legRef);
        terminal = true;
        fail(res, 503);
        return;
      }
      release = ports.acquire();
      if (!release) {
        capture?.event("TTS", "BUSY", undefined, legRef);
        terminal = true;
        fail(res, 503);
        return;
      }
      s.pending.add(controller);
      capture?.event("TTS", "STARTED", undefined, legRef);
      const result = await ports.speech.synthesize(
        leg.output.text,
        speechLanguage(leg.output.text),
        owner,
        controller.signal,
      );
      capture?.event("TTS", result.state, Date.now() - started, legRef);
      if (result.state === "FAILED" && result.reason)
        capture?.event("TTS", result.reason, undefined, legRef);
      terminal = true;
      if (controller.signal.aborted || res.destroyed || !s.valid) {
        if (result.state === "READY")
          ports.speech.release(owner, result.mediaRef);
        return;
      }
      if (result.state !== "READY") {
        fail(res, 503);
        return;
      }
      s.media.clear();
      if (capture) s.media.set(result.mediaRef, { capture, leg: leg.runRef });
      res.setHeader(
        "X-History-Recording",
        capture?.ref.recording ?? "INCOMPLETE",
      );
      res.json({
        contractVersion: "tts-media.v1",
        mediaRef: result.mediaRef,
        contentType: result.contentType,
        language: result.language,
        expiresAtEpochSeconds: result.expiresAtEpochSeconds,
      });
    } catch {
      if (!res.headersSent && !res.destroyed) fail(res);
    } finally {
      if (!terminal)
        capture?.event(
          "TTS",
          controller.signal.aborted ? "CANCELLED" : "FAILED",
          Date.now() - started,
          legRef,
        );
      bytes?.fill(0);
      s.pending.delete(controller);
      release?.();
      res.off("close", disconnected);
    }
  });
  app.get("/api/v1/input/media/:id", (req, res) => {
    const s = session(req, res);
    if (!s) return;
    if (!isInputRef(req.params.id)) {
      fail(res, 404);
      return;
    }
    const link = s.media.get(req.params.id);
    s.media.delete(req.params.id);
    const bytes = ports.speech.take(req.get("x-input-session")!, req.params.id);
    link?.capture.event(
      "DELIVERY",
      bytes ? "SERVER_RELEASED" : "UNAVAILABLE",
      undefined,
      link.leg,
    );
    if (!bytes) {
      fail(res, 404);
      return;
    }
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Length", String(bytes.length));
    res.end(bytes, () => bytes.fill(0));
  });
  app.delete("/api/v1/input/media/:id", (req, res) => {
    if (!session(req, res)) return;
    if (
      !isInputRef(req.params.id) ||
      !ports.speech.release(req.get("x-input-session")!, req.params.id)
    ) {
      fail(res, 404);
      return;
    }
    res.status(204).end();
  });
  app.post("/api/v1/input/turns", async (req, res) => {
    const s = session(req, res);
    if (!s) return;
    let bytes: Buffer | undefined;
    try {
      if (!req.is("json")) throw new Error();
      bytes = await body(req, s, 16384);
      const v = JSON.parse(bytes.toString("utf8"));
      if (
        !v ||
        Object.keys(v).some(
          (k) => !["text", "source", "transcriptRef"].includes(k),
        ) ||
        typeof v.text !== "string" ||
        Buffer.byteLength(v.text) > 8192 ||
        !["TYPED", "TRANSCRIPT"].includes(v.source)
      )
        throw new Error();
      const transcript =
        v.source === "TRANSCRIPT"
          ? [...s.jobs.values()].find(
              (j) =>
                !j.consumed &&
                j.value.transcript?.transcriptRef === v.transcriptRef &&
                j.value.transcript?.text === v.text,
            )
          : undefined;
      if (v.source === "TRANSCRIPT" && !transcript) throw new Error();
      for (const [id, draft] of s.drafts)
        if (draft.consumed) s.drafts.delete(id);
      if (s.drafts.size >= 16) throw new Error();
      const safe = !!classifyInput(v.text);
      const capture =
        transcript?.capture ??
        createHistoryCapture(
          ports.history,
          s.conversation,
          "TYPED",
          safe ? v.text : null,
          String(res.getHeader("X-Correlation-ID") ?? "") || null,
        );
      capture.event("INPUT", "SUBMITTED");
      if (!safe) {
        capture.event("SAFETY", "REJECTED_TEXT_WITHHELD");
        capture.safety();
        capture.outcome("NO_ANSWER");
      }
      s.drafts.set(capture.ref.turn, {
        capture,
        text: v.text,
        source: v.source,
        consumed: false,
      });
      res.json(capture.ref);
    } catch {
      if (!res.headersSent && !res.destroyed) fail(res);
    } finally {
      bytes?.fill(0);
    }
  });
  app.post("/api/v1/input/turns/:id/unsubmitted", (req, res) => {
    const s = session(req, res);
    if (!s) return;
    const draft = s.drafts.get(String(req.params.id));
    if (!draft || draft.consumed) {
      fail(res, 404);
      return;
    }
    draft.capture.event(
      "HANDOFF",
      "BROWSER_DID_NOT_SUBMIT",
      undefined,
      undefined,
      "BROWSER",
    );
    draft.capture.outcome("NO_ANSWER");
    draft.consumed = true;
    res.json(draft.capture.ref);
  });
  app.post("/api/v1/input/observation", async (req, res) => {
    const s = session(req, res);
    if (!s) return;
    let bytes: Buffer | undefined;
    try {
      if (!req.is("json")) throw new Error();
      bytes = await body(req, s, 1024, true);
      const v = JSON.parse(bytes.toString("utf8"));
      if (
        !v ||
        Object.keys(v).some(
          (k) => !["jobRef", "runRef", "event"].includes(k),
        ) ||
        ![
          "DISPLAYED",
          "PLAY_STARTED",
          "PLAY_ENDED",
          "PLAY_FAILED",
          "PLAY_BLOCKED",
          "PLAY_STOPPED",
          "TTS_SKIPPED_MUTED",
          "TTS_SKIPPED_COMPARE",
          "TTS_SKIPPED_UNAVAILABLE",
        ].includes(v.event)
      )
        throw new Error();
      const j = [...s.jobs.values()].find((j) => j.value.jobRef === v.jobRef);
      if (!j?.value.result?.legs.some((l) => l.runRef === v.runRef))
        throw new Error();
      j.capture?.event(
        v.event === "DISPLAYED"
          ? "ANSWER"
          : v.event.startsWith("TTS_SKIPPED")
            ? "TTS"
            : "PLAYBACK",
        v.event,
        undefined,
        v.runRef,
        "BROWSER",
      );
      res.json({ recording: j.capture?.ref.recording ?? "INCOMPLETE" });
    } catch {
      if (!res.headersSent && !res.destroyed) fail(res);
    } finally {
      bytes?.fill(0);
    }
  });
  app.post("/api/v1/input/interactions", async (req, res) => {
    const s = session(req, res);
    if (!s) return;
    let b: Buffer | undefined;
    let capture: HistoryCapture | undefined;
    try {
      if (!req.is("json")) throw new Error();
      b = await body(req, s, 32768);
      const v: unknown = JSON.parse(b.toString("utf8"));
      b.fill(0);
      if (!isInputSubmission(v) || !s.valid) throw new Error();
      const key = v.request.clientRequestId,
        digest = hash(v);
      if (replay(s, key, digest, res, req)) return;
      const transcript =
        v.source === "TRANSCRIPT"
          ? [...s.jobs.values()].find(
              (j) =>
                !j.consumed &&
                j.value.state === "REVIEW" &&
                j.value.cleanup === "DELETED" &&
                j.value.transcript?.transcriptRef === v.transcriptRef &&
                j.value.transcript?.text === v.request.input.text,
            )
          : undefined;
      if (v.source === "TRANSCRIPT" && !transcript) {
        fail(res, 404);
        return;
      }
      const safe = !!classifyInput(v.request.input.text);
      const draft = v.turnRef ? s.drafts.get(v.turnRef) : undefined;
      if (
        v.turnRef &&
        (!draft ||
          draft.consumed ||
          draft.text !== v.request.input.text ||
          draft.source !== v.source)
      ) {
        fail(res, 404);
        return;
      }
      capture =
        draft?.capture ??
        transcript?.capture ??
        createHistoryCapture(
          ports.history,
          s.conversation,
          "TYPED",
          safe ? v.request.input.text : null,
          String(res.getHeader("X-Correlation-ID") ?? "") || null,
        );
      res.locals.capture = capture;
      res.setHeader("X-History-Turn", capture.ref.turn);
      res.setHeader("X-History-Conversation", capture.ref.conversation);
      res.setHeader("X-History-Recording", capture.ref.recording);
      capture.event(
        v.source === "TRANSCRIPT" ? "HANDOFF" : "INPUT",
        "RECEIVED",
      );
      if (!safe) {
        capture.event("SAFETY", "REJECTED_TEXT_WITHHELD");
        capture.safety();
        capture.outcome("NO_ANSWER");
        fail(res);
        return;
      }
      if (draft) draft.consumed = true;
      capture.event("SAFETY", "PASSED");
      let request = v.request;
      let history = request.input.history ?? [];
      // Client history is untrusted for every role. Drop the smallest whole
      // oldest prefix that leaves only safe text, including all assistant legs
      // of an offending turn (or an orphan assistant prefix). Never edit text
      // or mutate the browser conversation or retained history records.
      while (history.some((message) => !classifyInput(message.content))) {
        const nextTurn = history.findIndex(
          (m, i) => i > 0 && m.role === "USER",
        );
        history = history.slice(nextTurn < 0 ? history.length : nextTurn);
      }
      if (history.length !== (request.input.history?.length ?? 0)) {
        request = { ...request, input: { ...request.input, history } };
        capture.event("SAFETY", "HISTORY_REDUCED");
      }
      const release = ports.acquire();
      if (!release) {
        capture.event("ADMISSION", "BUSY");
        capture.outcome("NO_ANSWER");
        fail(res, 503);
        return;
      }
      const j = newJob(s, key, digest);
      if (!j) {
        release();
        capture.event("ADMISSION", "JOB_LIMIT");
        capture.outcome("NO_ANSWER");
        fail(res, 503);
        return;
      }
      j.capture = capture;
      j.value.history = capture.ref;
      capture.event("ADMISSION", "ACCEPTED");
      capture.outcome("PENDING");
      if (transcript) transcript.consumed = true;
      res.status(202).json(j.value);
      publish(s, j, { state: "PROCESSING" });
      void (async () => {
        const started = Date.now();
        try {
          const value = await ports.execute(
            request,
            j.controller.signal,
            s.providerRef,
            (stage, outcome, duration, source) => {
              j.capture!.event(
                stage,
                outcome,
                duration,
                undefined,
                "SERVER",
                source?.snapshot,
              );
              if (source)
                j.capture!.source(source.course, source.lab, source.sources);
            },
            v.source,
          );
          if (!s.valid || j.controller.signal.aborted) {
            if (isProviderRunResult(value)) j.capture!.result(value, true);
            return;
          }
          if (isProviderRunResult(value)) {
            j.capture!.result(value);
            for (const leg of value.legs)
              if (
                leg.status === "COMPLETED" &&
                leg.output &&
                !isShortSpokenAnswer(leg.output.text)
              )
                j.capture!.event(
                  "TTS",
                  "SKIPPED_LONG_ANSWER",
                  undefined,
                  leg.runRef,
                );
          } else {
            j.capture!.event("CAPTURE", "INVALID_RESULT");
            j.capture!.outcome("FAILED");
          }
          publish(
            s,
            j,
            isProviderRunResult(value)
              ? { state: "COMPLETED", result: value }
              : { state: "FAILED" },
          );
        } catch (error) {
          if (!j.controller.signal.aborted && s.valid) {
            const outcome =
              error instanceof CoursePreparationError
                ? error.outcome
                : "FAILED";
            j.capture!.event(
              "CAPTURE",
              outcome === "FAILED" ? "EXECUTION_FAILED" : outcome,
              Date.now() - started,
            );
            j.capture!.outcome(outcome);
            publish(s, j, { state: outcome });
          }
        } finally {
          release();
        }
      })();
    } catch {
      capture?.event("CAPTURE", "REQUEST_FAILED");
      capture?.outcome("FAILED");
      if (!res.headersSent && !res.destroyed) fail(res);
    } finally {
      b?.fill(0);
    }
  });
  app.post("/api/v1/input/transcriptions", async (req, res) => {
    const s = session(req, res);
    if (!s) return;
    const key = req.get("idempotency-key"),
      client = req.get("x-input-client");
    if (
      req.get("content-type") !== "audio/wav" ||
      req.get("x-input-consent") !== "press-to-talk" ||
      !isInputRef(key) ||
      !isInputClient(client) ||
      req.get("x-input-language") !== undefined
    ) {
      fail(res);
      return;
    }
    const capture =
      s.jobs.get(key)?.capture ??
      createHistoryCapture(
        ports.history,
        s.conversation,
        "VOICE",
        null,
        String(res.getHeader("X-Correlation-ID") ?? "") || null,
      );
    res.locals.capture = capture;
    if (!s.jobs.has(key)) capture.event("STT_RECEIVE", "REQUESTED");
    res.setHeader("X-History-Turn", capture.ref.turn);
    res.setHeader("X-History-Conversation", capture.ref.conversation);
    res.setHeader("X-History-Recording", capture.ref.recording);
    if (ports.speech.status() !== "READY") {
      if (!s.jobs.has(key)) {
        capture.event("ADMISSION", ports.speech.status());
        capture.outcome("NO_ANSWER");
      }
      fail(res, 503);
      return;
    }
    const release = ports.acquire();
    if (!release) {
      if (!s.jobs.has(key)) {
        capture.event("ADMISSION", "BUSY");
        capture.outcome("NO_ANSWER");
      }
      fail(res, 503);
      return;
    }
    let b: Buffer | undefined;
    let j: Job | undefined;
    try {
      b = await body(req, s, inputLimits.uploadBytes);
      if (!s.valid) throw new Error();
      const digest = createHash("sha256")
        .update(client)
        .update(b)
        .digest("hex");
      if (replay(s, key, digest, res, req)) return;
      j = newJob(s, key, digest);
      if (!j) {
        capture.event("ADMISSION", "JOB_LIMIT");
        capture.outcome("NO_ANSWER");
        fail(res, 503);
        return;
      }
      j.capture = capture;
      j.value.history = capture.ref;
      capture.event("STT_RECEIVE", "RECEIVED");
      j.value.cleanup = "PENDING";
      res.status(202).json(j.value);
      publish(s, j, { state: "PROCESSING" });
      if (!validateWav(b)) {
        capture.event("STT_RECEIVE", "INVALID_AUDIO");
        capture.outcome("NO_ANSWER");
        publish(s, j, { state: "INVALID", cleanup: "DELETED" });
        return;
      }
      capture.event("STT_PROCESS", "STARTED");
      const started = Date.now();
      const result = await ports.speech.transcribe(
        b,
        "auto",
        j.controller.signal,
      );
      capture.event("STT_RESULT", result.state, Date.now() - started);
      if (result.state === "REVIEW") {
        if (classifyInput(result.text)) capture.text(result.text);
        else {
          capture.event("SAFETY", "REJECTED_TEXT_WITHHELD");
          capture.safety();
        }
      }
      if (j.controller.signal.aborted) {
        j.value.cleanup = result.cleanup;
        return;
      }
      capture.outcome(
        result.state === "REVIEW" && classifyInput(result.text)
          ? "TRANSCRIBED"
          : result.state === "TIMEOUT"
            ? "TIMEOUT"
            : result.state === "CANCELLED"
              ? "CANCELLED"
              : "FAILED",
      );
      publish(s, j, {
        state:
          result.state === "REVIEW" && !classifyInput(result.text)
            ? "INVALID"
            : result.state,
        cleanup: result.cleanup,
        ...(result.state === "REVIEW" && classifyInput(result.text)
          ? { transcript: { transcriptRef: ref(), text: result.text } }
          : {}),
      });
    } catch {
      capture.event("STT_RECEIVE", "FAILED");
      capture.outcome(j?.controller.signal.aborted ? "CANCELLED" : "FAILED");
      if (j) {
        publish(s, j, { state: "FAILED", cleanup: "DELETED" });
        if (j.controller.signal.aborted) j.value.cleanup = "DELETED";
      }
      if (!res.headersSent) fail(res);
    } finally {
      b?.fill(0);
      release();
    }
  });
  return {
    close() {
      for (const id of sessions.keys()) reset(id);
      ports.speech.close();
    },
  };
}
