import type {
  AssignmentVerificationResult,
  AssignmentVerifier,
  verificationOutcomes,
} from "@laita/contracts/browser";
import { ClientError, type InputApi } from "./api.ts";

const get = <T extends HTMLElement>(name: string) =>
  document.getElementById(`canvas-verification-${name}`) as T;

const checkLabels: Record<(typeof verificationOutcomes)[number], string> = {
  PRESENT: "Present",
  ABSENT: "Absent",
  EMPTY: "Empty",
  MISSING: "Missing",
  UNKNOWN: "Unknown",
  PARTIAL: "Partial",
  DENIED: "Access denied",
  UNAVAILABLE: "Unavailable",
  UNSUPPORTED: "Unsupported",
  UNCHECKED: "Unchecked",
  NOT_REQUIRED: "Not required",
  OPEN: "Open",
  CLOSED: "Closed",
  MERGED: "Merged",
};

function evidenceText(
  provider: AssignmentVerifier,
  result: AssignmentVerificationResult,
) {
  if (result.state === "UNKNOWN")
    return {
      NOT_SUBMITTED: "Unknown — no current submission",
      SOURCE_UNAVAILABLE:
        "Unknown — submission unavailable or outside the approved scope",
      ATTEMPT_CHANGED: "Unknown — the submission attempt changed",
      PROVIDER_UNAVAILABLE: "Unknown — provider evidence unavailable",
    }[result.reason];
  const state = result.state === "PARTIAL" ? "Partial" : "Observed";
  const checks = result.checks.map((outcome, index) => {
    const name =
      provider === "MONGODB"
        ? `MongoDB check ${index + 1}`
        : index === result.checks.length - 1
          ? "GitHub pull request"
          : `GitHub file check ${index + 1}`;
    return `${name} — ${checkLabels[outcome]}`;
  });
  return `${state} · Attempt ${result.attempt} · ${result.submittedAt} · ${checks.join(" · ")}`;
}

export async function mountCanvasVerification(api: InputApi) {
  const { scope, assignments } = await api.canvasVerificationScope();
  const tool = document.getElementById("teacher-canvas-verification")!;
  const form = get<HTMLFormElement>("form");
  const list = get<HTMLUListElement>("results");
  const selection = get<HTMLSelectElement>("assignment");
  const student = get<HTMLSelectElement>("student");
  const start = get<HTMLButtonElement>("start");
  const cancel = get<HTMLButtonElement>("cancel");
  const status = get("status");
  let batch: AbortController | undefined;

  selection.replaceChildren(
    ...assignments.map(
      (entry, index) =>
        new Option(
          `${entry.provider === "GITHUB" ? "GitHub" : "MongoDB"} · Assignment ${entry.assignmentId} · ${entry.studentIds.length} students`,
          String(index),
        ),
    ),
  );
  const clearResults = () => {
    list.replaceChildren();
    status.textContent = "";
    start.textContent =
      student.value === "all"
        ? "Verify configured students"
        : "Verify selected student";
  };
  student.onchange = clearResults;
  const updateStudents = () => {
    const selected = assignments[selection.selectedIndex];
    student.replaceChildren(
      new Option("All configured students", "all"),
      ...(selected?.studentIds ?? []).map(
        (id) => new Option(`Student ${id}`, id),
      ),
    );
    clearResults();
  };
  selection.onchange = updateStudents;
  updateStudents();
  cancel.onclick = () => batch?.abort();
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (batch) return;
    const selected = assignments[selection.selectedIndex];
    if (!selected) return;
    const studentIds =
      student.value === "all"
        ? selected.studentIds
        : selected.studentIds.filter((id) => id === student.value);
    if (!studentIds.length) return;
    const running = new AbortController();
    const deadline = AbortSignal.timeout(15 * 60 * 1000);
    const signal = AbortSignal.any([running.signal, deadline]);
    batch = running;
    selection.disabled = student.disabled = start.disabled = true;
    cancel.hidden = false;
    const rows = studentIds.map((id) => {
      const row = document.createElement("li");
      row.textContent = `Student ${id} · Queued`;
      return row;
    });
    list.replaceChildren(...rows);
    let completed = 0;
    let interrupted = false;
    for (const [index, studentId] of studentIds.entries()) {
      if (batch !== running) return;
      const row = rows[index]!;
      const set = (outcome: string) => {
        row.textContent = `Student ${studentId} · ${outcome}`;
      };
      if (signal.aborted || interrupted) {
        set(signal.aborted ? "Cancelled — unchecked" : "Unknown — unchecked");
        continue;
      }
      status.textContent = `Checking ${index + 1} of ${rows.length} students…`;
      set("Checking…");
      try {
        const result = await api.verifyCanvasSubmission(
          scope,
          selected.assignmentId,
          selected.provider,
          studentId,
          signal,
        );
        if (batch !== running) return;
        set(evidenceText(selected.provider, result));
        completed++;
      } catch (error) {
        if (batch !== running) return;
        set(
          signal.aborted
            ? "Cancelled"
            : "Unknown — verification request unavailable",
        );
        interrupted =
          error instanceof ClientError &&
          [401, 403, 409, 429, 503].includes(error.status);
      }
    }
    status.textContent = signal.aborted
      ? `${deadline.aborted ? "Batch time limit reached" : "Verification cancelled"}. ${completed} of ${rows.length} results received.`
      : interrupted
        ? `Verification interrupted. ${completed} of ${rows.length} results received. Reload to recheck the session and configured scope.`
        : `Verification finished. ${completed} of ${rows.length} results received.`;
    batch = undefined;
    selection.disabled = student.disabled = start.disabled = false;
    cancel.hidden = true;
  };
  window.addEventListener("pagehide", () => {
    batch?.abort();
    batch = undefined;
    list.replaceChildren();
    status.textContent = "";
    selection.disabled = student.disabled = start.disabled = false;
    cancel.hidden = true;
  });
  tool.hidden = false;
}
