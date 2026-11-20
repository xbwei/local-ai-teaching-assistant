import { ClientError, type InputApi } from "./api.ts";

const get = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

function bindForm(
  form: HTMLFormElement,
  status: HTMLElement,
  run: (signal: AbortSignal) => Promise<void>,
) {
  const send = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const cancel = form.querySelector<HTMLButtonElement>(
    'button[type="button"]',
  )!;
  let pending: AbortController | undefined;
  cancel.onclick = () => pending?.abort();
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pending) return;
    const controller = new AbortController();
    pending = controller;
    send.disabled = true;
    cancel.hidden = false;
    status.textContent = "Working…";
    try {
      await run(controller.signal);
    } catch (error) {
      if (pending !== controller) return;
      status.textContent = controller.signal.aborted
        ? "Cancelled."
        : error instanceof ClientError && [401, 403].includes(error.status)
          ? "Sign in again as the local Teacher."
          : "Unavailable. Check the local setup and try again.";
    } finally {
      if (pending === controller) {
        pending = undefined;
        send.disabled = false;
        cancel.hidden = true;
      }
    }
  };
  window.addEventListener("pagehide", () => {
    pending?.abort();
    pending = undefined;
    form.reset();
    send.disabled = false;
    cancel.hidden = true;
    status.textContent = "";
  });
}

const draftNotices = {
  SOURCES_UNAVAILABLE: "Course sources are unavailable.",
  EVIDENCE_NOT_FOUND:
    "No relevant course evidence was found. Try a more specific topic.",
  EVIDENCE_AMBIGUOUS:
    "Clarify the topic for one course and one assignment or week.",
  EVIDENCE_CONFLICTING:
    "Course sources conflict. Check the published course material.",
  EVIDENCE_INPUT_LIMIT: "The source evidence exceeds the Local input limit.",
  LOCAL_UNAVAILABLE:
    "Local drafting is unavailable. Check the selected Local model.",
};

export function mountTeacherLocal(api: InputApi) {
  const drafting = get("teacher-local-draft");
  drafting.hidden = false;
  const draft = get<HTMLTextAreaElement>("teacher-draft-output");
  const sources = get("teacher-draft-sources");
  const draftStatus = get("teacher-draft-status");
  window.addEventListener("pagehide", () => {
    draft.value = "";
    sources.replaceChildren();
  });
  bindForm(
    get<HTMLFormElement>("teacher-draft-form"),
    draftStatus,
    async (signal) => {
      const result = await api.teacherDraft(
        get<HTMLSelectElement>("teacher-draft-course").value,
        get<HTMLSelectElement>("teacher-draft-kind").value,
        get<HTMLInputElement>("teacher-draft-topic").value,
        signal,
      );
      if (!("text" in result)) {
        draftStatus.textContent = Object.hasOwn(draftNotices, result.code)
          ? draftNotices[result.code as keyof typeof draftNotices]
          : "Draft unavailable.";
        return;
      }
      draft.value = result.text;
      sources.replaceChildren(
        ...result.sources.map(({ path, section }) => {
          const row = document.createElement("li");
          row.textContent = path + (section ? ` · ${section}` : "");
          return row;
        }),
      );
      draftStatus.textContent =
        "Draft ready. Check the sources and edit before use.";
    },
  );
  const history = get("teacher-history-plugin");
  const historyStatus = get("teacher-history-status");
  void api
    .teacherHistoryEnabled()
    .then((enabled) => {
      if (enabled) history.hidden = false;
    })
    .catch(() => {
      // An unconfigured plugin leaves standalone Chat available.
    });
  bindForm(
    get<HTMLFormElement>("teacher-history-form"),
    historyStatus,
    async (signal) => {
      historyStatus.textContent = await api.teacherHistory(
        get<HTMLInputElement>("teacher-history-question").value,
        signal,
      );
    },
  );
}
