import type { InputApi } from "./api.ts";
import { bindTeacherForm } from "./teacher-form.ts";

const get = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

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

function showDraft(
  result: Awaited<ReturnType<InputApi["teacherDraft"]>>,
  draft: HTMLTextAreaElement,
  sources: HTMLElement,
  status: HTMLElement,
) {
  if (!("text" in result)) {
    status.textContent = Object.hasOwn(draftNotices, result.code)
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
  status.textContent = "Draft ready. Check the sources and edit before use.";
}

export function mountTeacherLocal(api: InputApi) {
  const drafting = get("teacher-local-draft");
  drafting.hidden = false;
  const draft = get<HTMLTextAreaElement>("teacher-draft-output");
  const sources = get("teacher-draft-sources");
  const draftStatus = get("teacher-draft-status");
  const course = get<HTMLSelectElement>("teacher-draft-course");
  if (document.body.dataset.demoCourse) {
    course.value = document.body.dataset.demoCourse;
    course.disabled = true;
  }
  window.addEventListener("pagehide", () => {
    draft.value = "";
    sources.replaceChildren();
  });
  bindTeacherForm(
    get<HTMLFormElement>("teacher-draft-form"),
    draftStatus,
    async (signal) => {
      const result = await api.teacherDraft(
        course.value,
        get<HTMLSelectElement>("teacher-draft-kind").value,
        get<HTMLInputElement>("teacher-draft-topic").value,
        signal,
      );
      showDraft(result, draft, sources, draftStatus);
    },
  );
}

export function mountCanvasLocalDraft(
  api: InputApi,
  canvasForm: HTMLFormElement,
  body: HTMLTextAreaElement,
  kind: "PAGE" | "ASSIGNMENT",
) {
  const course = document.body.dataset.demoCourse;
  if (!course) return;
  const template = get<HTMLTemplateElement>("canvas-local-draft-template");
  const form = template.content.firstElementChild!.cloneNode(
    true,
  ) as HTMLFormElement;
  const fields = form.querySelector("fieldset")!;
  const topic = form.querySelector<HTMLInputElement>('input[type="text"]')!;
  const criteria = form.querySelector("select")!;
  if (kind === "PAGE") criteria.closest("label")!.remove();
  const draft = form.querySelector("textarea")!;
  const sources = form.querySelector("ul")!;
  const status = form.querySelector<HTMLParagraphElement>('[role="status"]')!;
  const apply = form.querySelector<HTMLButtonElement>("[data-apply-draft]")!;
  let generating = false;
  const syncApply = () => {
    apply.disabled = generating || !draft.value.trim();
  };
  canvasForm.before(form);
  const stop = bindTeacherForm(
    form,
    status,
    async (signal) => {
      generating = true;
      syncApply();
      try {
        const result = await api.teacherDraft(
          course,
          kind,
          topic.value,
          signal,
          kind === "ASSIGNMENT" && criteria.value === "yes",
        );
        signal.throwIfAborted();
        showDraft(result, draft, sources, status);
      } finally {
        generating = false;
        syncApply();
      }
    },
    {
      signIn: "Reopen the signed Canvas Teacher launch.",
      unavailable: "Draft unavailable. Check the Local model and try again.",
    },
  );
  draft.oninput = syncApply;
  apply.onclick = () => {
    if (form.hidden || body.matches(":disabled") || apply.disabled) return;
    if (draft.value.length > body.maxLength) {
      status.textContent = "Shorten the suggestion to fit the Canvas body.";
      return;
    }
    body.value = draft.value;
    body.dispatchEvent(new Event("input", { bubbles: true }));
    status.textContent = "Suggestion applied. Edit the body and preview again.";
    body.focus();
  };
  window.addEventListener("pagehide", () => {
    sources.replaceChildren();
    syncApply();
  });
  return (show: boolean, locked: boolean) => {
    form.hidden = !show;
    fields.disabled = locked;
    if (!show) stop();
  };
}
