import {
  canvasAssignmentSubmissionTypes,
  readCanvasAssignmentDraft,
  type CanvasAssignmentDraft,
  type CanvasAssignmentPreview,
} from "@laita/contracts/browser";
import { ClientError, type InputApi } from "./api.ts";
import { canvasDraftMarkup } from "./markdown.ts";

const get = <T extends HTMLElement>(id: string) =>
  document.getElementById(`canvas-assignment-${id}`) as T;

export async function mountTeacherCanvasAssignments(api: InputApi) {
  const scope = await api.canvasAssignmentScope();
  const tool = document.getElementById("teacher-canvas-assignments")!;
  const form = get<HTMLFormElement>("form");
  const kind = get<HTMLSelectElement>("kind");
  const assignment = get<HTMLSelectElement>("id");
  const createFields = get<HTMLFieldSetElement>("create");
  const title = get<HTMLInputElement>("title");
  const body = get<HTMLTextAreaElement>("body");
  const points = get<HTMLInputElement>("points");
  const due = get<HTMLInputElement>("due");
  const status = get("status");
  const preview = get("preview");
  const confirm = get<HTMLButtonElement>("confirm");
  const abort = get<HTMLButtonElement>("abort");
  const previewButton = form.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  )!;
  assignment.replaceChildren(
    ...scope.editableIds.map((id) => new Option(`Assignment ${id}`, id)),
  );
  const editChoice = kind.querySelector<HTMLOptionElement>(
    'option[value="TITLE"]',
  )!;
  editChoice.disabled = scope.editableIds.length === 0;
  let pending: AbortController | undefined;
  let approved: CanvasAssignmentPreview | undefined;

  function syncForm() {
    const editing = kind.value === "TITLE";
    createFields.hidden = editing;
    createFields.disabled = editing || !!pending;
    assignment.closest("label")!.hidden = !editing;
    assignment.disabled = !editing || !!pending;
    kind.disabled =
      title.disabled =
      previewButton.disabled =
      confirm.disabled =
        !!pending;
  }
  function clearPreview() {
    approved = undefined;
    preview.hidden = true;
    get("target").textContent = "";
    get("subject").textContent = "";
    get("preview-title").textContent = "";
    get("preview-body").replaceChildren();
    get("html").textContent = "";
  }
  function finish(controller: AbortController) {
    if (pending !== controller) return;
    pending = undefined;
    abort.hidden = true;
    syncForm();
  }
  function show(plan: CanvasAssignmentPreview, markup?: HTMLElement) {
    const { target, subject, draft } = plan;
    const course = document.createElement("bdi");
    course.textContent = target.courseName;
    get("target").replaceChildren(
      course,
      ` · Course ${target.courseId} · Teacher ${target.teacherId} · ${target.origin}`,
    );
    get("preview-title").textContent = draft.title;
    get("exact").hidden = draft.kind !== "CREATE";
    confirm.hidden = draft.kind === "TITLE" && subject.name === draft.title;
    if (draft.kind === "CREATE") {
      get("subject").textContent =
        `Group ${subject.id} · ${subject.name} · Unpublished · ${draft.pointsPossible} points · ${draft.submissionTypes.map((t) => canvasAssignmentSubmissionTypes[t]).join(", ")} · ${draft.dueAt ? `Due ${draft.dueAt}` : "No due date"} · Notifications off`;
      get("preview-body").replaceChildren(...(markup ? [markup] : []));
      get("html").textContent = draft.body;
      confirm.textContent = "Create unpublished assignment";
    } else if (subject.kind === "TITLE") {
      get("subject").textContent =
        `Assignment ${subject.id} · Current title ${subject.name} · ${subject.published ? "Published" : "Unpublished"} · Title-only edit · Notifications off`;
      confirm.textContent = "Save assignment title";
    }
    preview.hidden = false;
  }

  tool.hidden = false;
  syncForm();
  form.addEventListener("input", () => {
    if (approved)
      status.textContent = "Draft changed. Preview the assignment again.";
    clearPreview();
    syncForm();
  });
  get("cancel").onclick = () => {
    clearPreview();
    status.textContent = "Assignment preview cancelled.";
    previewButton.focus();
  };
  abort.onclick = () => pending?.abort();
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pending) return;
    clearPreview();
    let draft: CanvasAssignmentDraft;
    let markup: HTMLElement | undefined;
    try {
      if (kind.value === "TITLE") {
        draft = readCanvasAssignmentDraft({
          kind: "TITLE",
          assignmentId: assignment.value,
          title: title.value.trim(),
        });
      } else {
        markup = canvasDraftMarkup(body.value);
        const dueAt = due.value
          ? new Date(`${due.value}Z`).toISOString()
          : null;
        draft = readCanvasAssignmentDraft({
          kind: "CREATE",
          title: title.value.trim(),
          body: markup.innerHTML,
          pointsPossible: points.valueAsNumber,
          dueAt,
          submissionTypes: new FormData(form).getAll("submission"),
        });
      }
    } catch {
      status.textContent =
        "Check the title and assignment settings, including the supported Markdown and submission types.";
      return;
    }
    const controller = new AbortController();
    pending = controller;
    syncForm();
    abort.hidden = false;
    status.textContent = "Checking the Canvas assignment target…";
    try {
      const plan = await api.previewCanvasAssignment(draft, controller.signal);
      if (pending !== controller || controller.signal.aborted) return;
      approved = plan;
      show(plan, markup);
      status.textContent = confirm.hidden
        ? "The assignment already has this title."
        : "Review the destination and proposed assignment change before saving.";
    } catch {
      if (pending === controller)
        status.textContent = controller.signal.aborted
          ? "Assignment preview cancelled."
          : "Preview unavailable. Check the signed Teacher session and configured assignment scope.";
    } finally {
      finish(controller);
    }
  };

  confirm.onclick = async () => {
    if (pending || !approved || preview.hidden || confirm.hidden) return;
    const plan = approved;
    clearPreview();
    const controller = new AbortController();
    pending = controller;
    syncForm();
    status.textContent =
      "Saving the approved change and checking it in Canvas…";
    const uncertain =
      "The assignment result could not be confirmed. Check Assignments in Canvas before trying again.";
    try {
      const result = await api.saveCanvasAssignment(plan, controller.signal);
      if (pending !== controller) return;
      if (result.status === "VERIFIED") {
        status.textContent = `Canvas verified assignment ${result.assignmentId}.`;
        form.reset();
      } else {
        status.textContent =
          result.status === "UNVERIFIED"
            ? `Canvas returned assignment ${result.assignmentId}, but LAITA could not verify it. Check Canvas before trying again.`
            : uncertain;
      }
    } catch (error) {
      if (pending === controller)
        status.textContent =
          error instanceof ClientError && error.status === 409
            ? "The preview could not be confirmed. Review the current assignment and preview again."
            : uncertain;
    } finally {
      finish(controller);
    }
  };

  window.addEventListener("pagehide", () => {
    pending?.abort();
    pending = undefined;
    clearPreview();
    form.reset();
    abort.hidden = true;
    status.textContent = "";
    syncForm();
  });
}
