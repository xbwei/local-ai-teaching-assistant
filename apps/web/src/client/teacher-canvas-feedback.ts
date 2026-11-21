import {
  readCanvasFeedbackDraft,
  type CanvasFeedbackPreview,
} from "@laita/contracts/browser";
import { ClientError, type InputApi } from "./api.ts";

const get = <T extends HTMLElement>(id: string) =>
  document.getElementById(`canvas-feedback-${id}`) as T;

export async function mountTeacherCanvasFeedback(api: InputApi) {
  const scope = await api.canvasFeedbackScope();
  const tool = document.getElementById("teacher-canvas-feedback")!;
  const form = get<HTMLFormElement>("form");
  const assignment = get<HTMLSelectElement>("assignment");
  const text = get<HTMLTextAreaElement>("text");
  const review = get<HTMLButtonElement>("review");
  const confirm = get<HTMLButtonElement>("confirm");
  const abort = get<HTMLButtonElement>("abort");
  const preview = get("preview");
  const status = get("status");
  let pending: AbortController | undefined;
  let approved: CanvasFeedbackPreview | undefined;

  assignment.replaceChildren(
    ...scope.assignmentIds.map((id) => new Option(`Assignment ${id}`, id)),
  );

  function show(plan: CanvasFeedbackPreview) {
    const { target, draft, feedbackSubject } = plan;
    const course = document.createElement("bdi");
    course.textContent = target.courseName;
    const name = document.createElement("bdi");
    name.textContent = feedbackSubject.assignmentName;
    get("target").replaceChildren(
      course,
      ` · Course ${target.courseId} · Teacher ${target.teacherId} · ${target.origin}`,
    );
    get("submission").replaceChildren(
      name,
      ` · Assignment ${draft.assignmentId} · Test Student ${feedbackSubject.testStudentId} · Attempt ${feedbackSubject.attempt} · ${feedbackSubject.submittedAt}`,
    );
    get("comment").textContent = draft.text;
    preview.hidden = false;
  }

  function clearPreview() {
    approved = undefined;
    preview.hidden = true;
    for (const field of ["target", "submission", "comment"])
      get(field).textContent = "";
  }

  function syncForm() {
    assignment.disabled =
      text.disabled =
      review.disabled =
      confirm.disabled =
        !!pending;
  }

  form.addEventListener("input", () => {
    if (approved) status.textContent = "Draft changed. Preview again.";
    clearPreview();
  });
  get("cancel").onclick = () => {
    clearPreview();
    status.textContent = "Feedback preview cancelled.";
    review.focus();
  };
  abort.onclick = () => pending?.abort();
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pending) return;
    clearPreview();
    let draft;
    try {
      draft = readCanvasFeedbackDraft({
        kind: "FEEDBACK",
        assignmentId: assignment.value,
        text: text.value.trim(),
      });
    } catch {
      status.textContent =
        "Enter plain-text feedback of up to 1,024 UTF-8 bytes.";
      return;
    }
    const controller = new AbortController();
    pending = controller;
    syncForm();
    abort.hidden = false;
    status.textContent =
      "Checking the Canvas assignment and Test Student submission…";
    try {
      const plan = await api.previewCanvasFeedback(
        draft,
        scope.testStudentId,
        controller.signal,
      );
      if (pending !== controller || controller.signal.aborted) return;
      approved = plan;
      show(plan);
      status.textContent =
        "Review the recipient, attempt and exact text before posting.";
    } catch {
      if (pending === controller)
        status.textContent = controller.signal.aborted
          ? "Feedback preview cancelled."
          : "Preview unavailable. Check the signed Teacher session, approved assignment and Test Student submission in Canvas.";
    } finally {
      if (pending === controller) {
        abort.hidden = true;
        pending = undefined;
        syncForm();
      }
    }
  };

  confirm.onclick = async () => {
    if (pending || !approved || preview.hidden) return;
    const plan = approved;
    clearPreview();
    const controller = new AbortController();
    pending = controller;
    syncForm();
    status.textContent = "Posting and checking the reviewed feedback…";
    const uncertain =
      "The result could not be confirmed. Check the submission in Canvas before trying again.";
    try {
      const result = await api.postCanvasFeedback(plan, controller.signal);
      if (pending !== controller) return;
      if (result.status === "VERIFIED") {
        status.textContent = `Canvas confirmed comment ${result.commentId} on the reviewed submission.`;
        text.value = "";
      } else {
        status.textContent =
          result.status === "UNVERIFIED"
            ? `Canvas returned comment ${result.commentId}, but LAITA could not verify it. Check the submission in Canvas before trying again.`
            : uncertain;
      }
    } catch (error) {
      if (pending === controller)
        status.textContent =
          error instanceof ClientError && error.status === 409
            ? "The preview could not be confirmed. Check the current submission and preview again."
            : uncertain;
    } finally {
      if (pending === controller) {
        pending = undefined;
        syncForm();
      }
    }
  };

  window.addEventListener("pagehide", () => {
    pending?.abort();
    pending = undefined;
    syncForm();
    clearPreview();
    text.value = "";
    abort.hidden = true;
    status.textContent = "";
  });
  tool.hidden = false;
}
