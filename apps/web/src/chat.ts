import { feedbackControls } from "./client/history.ts";
import {
  LearningClient,
  type Mode,
  type Message,
} from "./client/controller.ts";
import { renderMessageText } from "./client/markdown.ts";
import { localResidencyText } from "./client/presentation.ts";
import { Microphone } from "./client/microphone.ts";
import { ClientError, InputApi } from "./client/api.ts";
import {
  teacherChatTools,
  type TeacherChatTool,
} from "./client/teacher-chat.ts";
import {
  isVirtualKeyboardOpen,
  isTouchCapable,
  shouldAutofocusQuestion,
  type InputCapabilities,
} from "./client/viewport.ts";
import {
  AnswerAudioPlayback,
  answerAudioKey,
  claimAutomaticPlayback,
} from "./client/audio.ts";
const get = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const question = get<HTMLTextAreaElement>("question");
const primaryFinePointer = window.matchMedia("(pointer: fine)");
const primaryCoarsePointer = window.matchMedia("(pointer: coarse)");
const anyCoarsePointer = window.matchMedia("(any-pointer: coarse)");
const mic = new Microphone();
let rendered = "",
  previous = "",
  choiceTimer: ReturnType<typeof setTimeout>;
const api = new InputApi();
const client = new LearningClient(render, api);
const toolMode = get<HTMLSelectElement>("teacher-chat-mode");
const toolScope = get("teacher-chat-scope");
const toolAnswer = get("teacher-chat-answer");
const tools = new Map<string, TeacherChatTool>();
let tool: TeacherChatTool | undefined;
let toolRequest: AbortController | undefined;
if (document.body.dataset.ownerRole === "teacher") {
  void teacherChatTools(api, document.body.dataset.ownerSource)
    .then((available) => {
      for (const entry of available) {
        tools.set(entry.id, entry);
        toolMode.add(new Option(entry.label, entry.id));
      }
      get("teacher-chat-routing").hidden = tools.size === 0;
    })
    .catch(() => {
      /* Unavailable Teacher tools leave general Chat usable. */
    });
}
if (
  document.body.dataset.ownerRole === "teacher" &&
  document.body.dataset.ownerSource === "local"
) {
  void import("./client/teacher-local.ts")
    .then(({ mountTeacherLocal }) => mountTeacherLocal(api))
    .catch(() => {
      /* Unavailable Teacher tools leave standalone Chat usable. */
    });
}
if (
  document.body.dataset.ownerRole === "teacher" &&
  document.body.dataset.ownerSource === "canvas"
) {
  void import("./client/teacher-canvas-pages.ts")
    .then(({ mountTeacherCanvasPages }) => mountTeacherCanvasPages(api))
    .catch(() => {
      /* Unavailable Canvas tools leave Chat usable. */
    });
  void import("./client/teacher-canvas-assignments.ts")
    .then(({ mountTeacherCanvasAssignments }) =>
      mountTeacherCanvasAssignments(api),
    )
    .catch(() => {
      /* Unavailable Canvas tools leave Chat usable. */
    });
  void import("./client/teacher-canvas-modules.ts")
    .then(({ mountTeacherCanvasModules }) => mountTeacherCanvasModules(api))
    .catch(() => {
      /* Unavailable Canvas tools leave Chat usable. */
    });
  void import("./client/teacher-canvas-feedback.ts")
    .then(({ mountTeacherCanvasFeedback }) => mountTeacherCanvasFeedback(api))
    .catch(() => {
      /* An unconfigured feedback tool leaves Chat available. */
    });
  void import("./client/teacher-canvas-verification.ts")
    .then(({ mountCanvasVerification }) => mountCanvasVerification(api))
    .catch(() => {
      /* An unconfigured verifier leaves the other tools available. */
    });
}
// Follow message lifetime without retaining old conversations or losing drafts on audio updates.
const messageFeedback = new WeakMap<Message, HTMLElement>();
get("usage-open").addEventListener("click", () =>
  get<HTMLDialogElement>("usage-dialog").showModal(),
);
get("usage-close").addEventListener("click", () =>
  get<HTMLDialogElement>("usage-dialog").close(),
);
const displayed = new Set<string>();
const playback = new AnswerAudioPlayback(api, render);
const autoAttempted = new Set<string>();
let lastVisualHeight: number | undefined;
let lastVisualOffsetTop: number | undefined;
let lastKeyboardOpen = document.documentElement.hasAttribute(
  "data-virtual-keyboard",
);
function inputCapabilities(): InputCapabilities {
  return {
    primaryFine: primaryFinePointer.matches,
    primaryCoarse: primaryCoarsePointer.matches,
    anyCoarse: anyCoarsePointer.matches,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  };
}
function syncInputCapabilities() {
  document.documentElement.toggleAttribute(
    "data-touch-capable",
    isTouchCapable(inputCapabilities()),
  );
}
for (const query of [
  primaryFinePointer,
  primaryCoarsePointer,
  anyCoarsePointer,
]) {
  if (typeof query.addEventListener === "function")
    query.addEventListener("change", syncInputCapabilities);
  else query.addListener(syncInputCapabilities);
}
syncInputCapabilities();
function syncVisualViewport() {
  const viewport = window.visualViewport;
  const height = viewport?.height ?? window.innerHeight;
  const offsetTop = viewport?.offsetTop ?? 0;
  const keyboardOpen = isVirtualKeyboardOpen(
    window.innerHeight,
    height,
    document.activeElement === question,
    lastKeyboardOpen,
    viewport?.scale ?? 1,
  );
  if (keyboardOpen !== lastKeyboardOpen) {
    document.documentElement.toggleAttribute(
      "data-virtual-keyboard",
      keyboardOpen,
    );
    lastKeyboardOpen = keyboardOpen;
  }
  if (height !== lastVisualHeight) {
    document.documentElement.style.setProperty(
      "--visual-viewport-height",
      `${height}px`,
    );
    lastVisualHeight = height;
  }
  if (offsetTop !== lastVisualOffsetTop) {
    document.documentElement.style.setProperty(
      "--visual-viewport-offset-top",
      `${offsetTop}px`,
    );
    lastVisualOffsetTop = offsetTop;
  }
}
window.visualViewport?.addEventListener("resize", syncVisualViewport);
window.visualViewport?.addEventListener("scroll", syncVisualViewport);
question.addEventListener("focus", syncVisualViewport);
question.addEventListener("blur", syncVisualViewport);
syncVisualViewport();
function render() {
  const busy = client.active || !!toolRequest;
  get("recording-status").textContent =
    client.recordingIncomplete ||
    playback.recordingIncomplete ||
    api.recordingIncomplete
      ? "Recording incomplete: some history or browser observations could not be saved."
      : "";
  get("learning").hidden = !client.connected;
  get("connection-status").textContent = client.connected ? "" : client.status;
  const unavailable =
    !client.active &&
    client.choices &&
    !client.choices.providers.modes.some((m) => m.id === client.mode);
  const generalStatus =
    client.status ||
    (!tool && unavailable
      ? "That mode is unavailable. Choose an available mode, or try again later."
      : "");
  const visibleStatus = toolRequest ? "Working…" : generalStatus;
  get("status").textContent = visibleStatus;
  get("status").dataset.phase = client.phase;
  get("activity").hidden = !visibleStatus && !busy;
  get("cancel").hidden = !busy;
  get<HTMLButtonElement>("cancel").disabled =
    !toolRequest && client.phase === "connecting";
  get("reset").hidden = busy || client.messages.length === 0;
  get("welcome").hidden = !!tool || client.messages.length > 0;
  get("transcript-status").textContent = client.transcript
    ? `Recognized: ${client.transcript}`
    : "";
  const messages = get("messages");
  messages.hidden = !!tool;
  toolAnswer.hidden = !tool;
  const messageSnapshot = JSON.stringify([
    client.messages,
    playback.state,
    playback.activeKey,
    playback.muted,
    playback.status,
  ]);
  if (rendered !== messageSnapshot) {
    messages.replaceChildren();
    client.messages.forEach((m, i) => {
      const article = document.createElement("article"),
        title = document.createElement("h3"),
        text = document.createElement("div");
      article.className = m.role + (m.error ? " error" : "");
      title.textContent = m.role === "question" ? "You" : m.provider!;
      renderMessageText(text, m);
      article.append(title, text);
      if (m.role === "answer" && m.history) {
        let controls = messageFeedback.get(m);
        if (!controls) {
          controls = feedbackControls(
            api,
            m.history,
            m.leg ?? "",
            !m.error && !!m.leg,
          );
          messageFeedback.set(m, controls);
        }
        article.append(controls);
      }
      if (m.audio && !displayed.has(m.audio.runRef)) {
        displayed.add(m.audio.runRef);
        const events = [
          "DISPLAYED",
          ...(m.audio.speechEligible === false
            ? []
            : playback.muted
              ? ["TTS_SKIPPED_MUTED"]
              : !m.audio.automatic
                ? ["TTS_SKIPPED_COMPARE"]
                : client.choices?.tts !== "READY"
                  ? ["TTS_SKIPPED_UNAVAILABLE"]
                  : []),
        ];
        for (const event of events)
          void api
            .observation(m.audio.jobRef, m.audio.runRef, event)
            .catch(() => {
              client.recordingIncomplete = true;
              render();
            });
      }
      if (m.sources?.length) {
        const details = document.createElement("details"),
          summary = document.createElement("summary"),
          list = document.createElement("ol");
        details.className = "course-sources";
        summary.textContent = `Course sources (${m.sources.length})`;
        for (const source of m.sources) {
          const item = document.createElement("li"),
            link = document.createElement("a"),
            identity = document.createElement("small"),
            excerpt = document.createElement("blockquote");
          link.href = source.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = `${source.path} — ${source.section}`;
          identity.textContent = `${source.course} · ${source.commit.slice(0, 12)}`;
          excerpt.textContent = source.excerpt;
          item.append(link, identity, excerpt);
          list.append(item);
        }
        details.append(summary, list);
        article.append(details);
      }
      if (m.audio) {
        const audio = document.createElement("button");
        const key = answerAudioKey(m.audio);
        const current = playback.activeKey === key;
        audio.className = "answer-audio quiet";
        audio.type = "button";
        audio.textContent =
          m.audio.speechEligible === false
            ? "Text only: long-answer speech skipped"
            : current && ["loading", "speaking"].includes(playback.state)
              ? "Stop audio"
              : current && playback.state === "ready"
                ? "Replay"
                : "Play answer";
        audio.disabled =
          m.audio.speechEligible === false ||
          (!current && client.choices?.tts !== "READY");
        audio.addEventListener("click", () => {
          if (current && ["loading", "speaking"].includes(playback.state))
            playback.stop();
          else void playback.play(m.audio!);
        });
        article.append(audio);
      }
      if (m.provenance) {
        const details = document.createElement("details"),
          summary = document.createElement("summary"),
          provenance = document.createElement("p");
        summary.textContent = "About this answer";
        provenance.textContent = m.provenance;
        details.append(summary, provenance);
        article.append(details);
      }
      const prior = client.messages[i - 1];
      if (
        m.role === "answer" &&
        prior?.role === "answer" &&
        prior.provider === "Local" &&
        m.provider === "OpenAI"
      ) {
        const last = messages.lastElementChild!,
          comparison = document.createElement("div");
        comparison.className = "comparison";
        last.replaceWith(comparison);
        comparison.append(last, article);
      } else messages.append(article);
    });
    rendered = messageSnapshot;
    const last = messages.lastElementChild as HTMLElement | null;
    if (last) get("conversation").scrollTop = Math.max(0, last.offsetTop - 12);
  }
  const automatic = client.messages.findLast(
    (message) => message.audio?.automatic,
  );
  if (
    automatic?.audio &&
    claimAutomaticPlayback(
      automatic.audio,
      autoAttempted,
      playback.muted,
      client.choices?.tts === "READY",
    )
  )
    queueMicrotask(() => void playback.play(automatic.audio!, true));
  const modes = client.choices?.providers.modes ?? [];
  const providers = get<HTMLFieldSetElement>("providers");
  providers.hidden = !!tool;
  document
    .querySelectorAll<HTMLInputElement>('input[name="provider"]')
    .forEach((input) => {
      const id = input.value.toUpperCase() as Mode;
      input.checked = id === client.mode;
      input.disabled =
        (client.active && client.phase !== "review") ||
        !modes.some((m) => m.id === id);
      input.parentElement!.hidden = false;
      let reason = input.parentElement!.querySelector("small");
      if (!reason) {
        reason = document.createElement("small");
        input.parentElement!.append(reason);
      }
      const code = client.choices?.reasons?.[id] ?? "UNAVAILABLE";
      reason.textContent = modes.some((m) => m.id === id)
        ? ""
        : ` — ${code.toLowerCase().replaceAll("_", " ")}`;
    });
  toolMode.disabled = busy;
  question.disabled = busy;
  get<HTMLButtonElement>("send").disabled = busy || !client.connected;
  get("cloud-disclosure").hidden = !!tool;
  get("mic-disclosure").hidden = !!tool;
  get("transcript-status").hidden = !!tool;
  get("conversation-controls").hidden = !!tool;
  const listening = client.phase === "listening";
  get("mic-label").textContent = listening ? "Stop" : "Mic";
  get("mic-label").toggleAttribute("data-stop", listening);
  get("mic").setAttribute("aria-label", listening ? "Stop" : "Mic");
  const microphone = get<HTMLButtonElement>("mic");
  microphone.hidden = !!tool;
  microphone.disabled = !!tool || (!listening && !client.canListen);
  const model = get<HTMLSelectElement>("local-model");
  model.value = client.localModel;
  model.disabled = busy;
  model.hidden = tool?.localModel === false;
  get("local-model-label").hidden = model.hidden;
  get("model-status").hidden = model.hidden;
  get("model-status").textContent = localResidencyText(
    client.localModel,
    client.choices,
  );
  get("dog").dataset.state =
    playback.state === "speaking"
      ? "speaking"
      : client.phase === "listening"
        ? "listening"
        : toolRequest || client.phase === "waiting"
          ? "thinking"
          : client.phase === "error" || playback.state === "error"
            ? "error"
            : "idle";
  get("audio-status").textContent = playback.status;
  get<HTMLInputElement>("text-only").checked = playback.muted;
  get("stop-audio").hidden = !["loading", "speaking"].includes(playback.state);
  if (previous === "listening" && !listening) mic.cancel();
  if (
    !tool &&
    shouldAutofocusQuestion(
      client.connected,
      client.active,
      client.phase !== previous,
      inputCapabilities(),
    )
  )
    question.focus();
  previous = client.phase;
}
get("local-model").addEventListener(
  "change",
  (e) => void client.selectLocalModel((e.target as HTMLSelectElement).value),
);
function showTool(next: TeacherChatTool | undefined) {
  tool = next;
  toolMode.value = next?.id ?? "conversation";
  clearTimeout(choiceTimer);
  question.value = "";
  question.maxLength = next?.limit ?? 2000;
  toolScope.textContent = next?.scope ?? "";
  toolScope.hidden = !next;
  if (next) question.setAttribute("aria-describedby", toolScope.id);
  else question.removeAttribute("aria-describedby");
  toolAnswer.textContent = "";
  get("conversation").scrollTop = 0;
}
toolMode.addEventListener("change", () => {
  if (client.active || toolRequest) {
    toolMode.value = tool?.id ?? "conversation";
    return;
  }
  playback.stop();
  showTool(tools.get(toolMode.value));
  render();
});
async function askTool(selected: TeacherChatTool, text: string) {
  const controller = new AbortController();
  toolRequest = controller;
  toolAnswer.textContent = "";
  render();
  try {
    const answer = await selected.ask(text, controller.signal);
    controller.signal.throwIfAborted();
    toolAnswer.textContent = answer;
    question.value = "";
  } catch (error) {
    if (toolRequest !== controller) return;
    toolAnswer.textContent = controller.signal.aborted
      ? "Cancelled."
      : error instanceof ClientError && [401, 403].includes(error.status)
        ? selected.signIn
        : selected.unavailable;
  } finally {
    if (toolRequest === controller) {
      toolRequest = undefined;
      render();
    }
  }
}
get("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = question.value;
  if (!text.trim() || client.active || toolRequest) return;
  if (tool) {
    void askTool(tool, text);
    return;
  }
  question.value = "";
  clearTimeout(choiceTimer);
  void client.send(text);
});
question.addEventListener("input", () => {
  clearTimeout(choiceTimer);
  if (tool) return;
  choiceTimer = setTimeout(
    () => void client.refreshChoices(question.value),
    350,
  );
});
get("providers").addEventListener("change", (e) =>
  client.select((e.target as HTMLInputElement).value.toUpperCase() as Mode),
);
async function stop() {
  try {
    const bytes = mic.stop();
    await client.upload(bytes);
  } catch {
    client.microphoneDenied();
  }
}
async function listen() {
  if (!client.beginListening()) return;
  try {
    await mic.start(() => void stop());
  } catch {
    client.microphoneDenied();
  }
}
get("mic").addEventListener(
  "click",
  () => void (client.phase === "listening" ? stop() : listen()),
);
get("cancel").addEventListener("click", () => {
  if (toolRequest) {
    toolRequest.abort();
    return;
  }
  mic.cancel();
  playback.stop();
  void client.cancel();
});
get("reset").addEventListener("click", () => {
  mic.cancel();
  playback.reset();
  autoAttempted.clear();
  question.value = "";
  void client.reset();
});
get("text-only").addEventListener("change", (event) =>
  playback.setMuted((event.target as HTMLInputElement).checked),
);
get("stop-audio").addEventListener("click", () => playback.stop());
document.addEventListener("visibilitychange", () => {
  if (document.hidden && ["listening", "transcribing"].includes(client.phase)) {
    mic.cancel();
    void client.cancel();
  }
});
window.addEventListener("pagehide", () => {
  toolRequest?.abort();
  toolRequest = undefined;
  showTool(undefined);
  mic.cancel();
  playback.reset();
  client.close();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void client.boot();
});
void client.boot();
