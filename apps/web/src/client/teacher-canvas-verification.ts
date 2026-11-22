import type {
  AssignmentVerificationResult,
  AssignmentVerificationScope,
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
      ATTEMPT_CHANGED:
        "Unknown — the previewed submission changed. Preview again.",
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
  const confirm = get<HTMLButtonElement>("confirm");
  const cancel = get<HTMLButtonElement>("cancel");
  const status = get("status");
  let batch: AbortController | undefined;
  type Row = { studentId: string; element: HTMLLIElement; version?: string };
  type Selection = AssignmentVerificationScope["assignments"][number];
  let pendingPreview: { selection: Selection; rows: Row[] } | undefined;

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
    pendingPreview = undefined;
    confirm.hidden = true;
    list.replaceChildren();
    status.textContent = "";
    start.textContent =
      student.value === "all"
        ? "Preview configured submissions"
        : "Preview selected submission";
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
    const rows = studentIds.map((studentId) => ({
      studentId,
      element: document.createElement("li"),
    }));
    for (const row of rows)
      row.element.textContent = `Student ${row.studentId} · Queued`;
    list.replaceChildren(...rows.map((row) => row.element));
    await run("preview", selected, rows);
  };
  confirm.onclick = async () => {
    if (batch || !pendingPreview) return;
    const plan = pendingPreview;
    if (plan.selection !== assignments[selection.selectedIndex]) {
      clearResults();
      return;
    }
    await run("verify", plan.selection, plan.rows);
  };
  async function run(
    phase: "preview" | "verify",
    selected: Selection,
    rows: Row[],
  ) {
    const running = new AbortController();
    const deadline = AbortSignal.timeout(15 * 60 * 1000);
    const signal = AbortSignal.any([running.signal, deadline]);
    batch = running;
    selection.disabled = student.disabled = start.disabled = true;
    pendingPreview = undefined;
    confirm.hidden = true;
    cancel.hidden = false;
    let completed = 0;
    let interrupted = false;
    for (const [index, row] of rows.entries()) {
      if (batch !== running) return;
      const { studentId } = row;
      const set = (outcome: string) => {
        row.element.textContent = `Student ${studentId} · ${outcome}`;
      };
      if (signal.aborted || interrupted) {
        set(signal.aborted ? "Cancelled — unchecked" : "Unknown — unchecked");
        continue;
      }
      const action = phase === "preview" ? "Previewing" : "Checking";
      status.textContent = `${action} ${index + 1} of ${rows.length} students…`;
      set(`${action}…`);
      try {
        if (phase === "preview") {
          const result = await api.previewCanvasSubmission(
            scope,
            selected.assignmentId,
            selected.provider,
            studentId,
            signal,
          );
          if (batch !== running) return;
          if (result.state === "READY") {
            row.version = result.version;
            set(
              `Ready to verify · Attempt ${result.attempt} · ${result.submittedAt}`,
            );
          } else {
            set(
              result.state === "NOT_APPLICABLE"
                ? "Not applicable — no current Canvas submission"
                : "Unavailable — submission could not be prepared for this verifier",
            );
          }
        } else {
          if (!row.version) throw new Error("NO_PREVIEW");
          const result = await api.verifyCanvasSubmission(
            scope,
            selected.assignmentId,
            selected.provider,
            studentId,
            row.version,
            signal,
          );
          if (batch !== running) return;
          set(evidenceText(selected.provider, result));
        }
        completed++;
      } catch (error) {
        if (batch !== running) return;
        set(
          signal.aborted
            ? "Cancelled"
            : phase === "preview"
              ? "Unavailable — preview request failed"
              : "Unknown — verification request unavailable",
        );
        interrupted =
          error instanceof ClientError &&
          [401, 403, 409, 429, 503].includes(error.status);
      }
    }
    let readyCount = 0;
    if (phase === "preview" && !signal.aborted && !interrupted) {
      const ready = rows.filter((row) => row.version !== undefined);
      readyCount = ready.length;
      if (ready.length) pendingPreview = { selection: selected, rows: ready };
      confirm.textContent =
        readyCount === 1
          ? "Verify previewed submission"
          : "Verify previewed submissions";
      confirm.hidden = readyCount === 0;
    }
    const label = phase === "preview" ? "Preview" : "Verification";
    status.textContent = signal.aborted
      ? `${deadline.aborted ? "Batch time limit reached" : `${label} cancelled`}. ${completed} of ${rows.length} results received.`
      : interrupted
        ? `${label} interrupted. ${completed} of ${rows.length} results received. Reload to recheck the session and configured scope.`
        : phase === "preview"
          ? `Preview finished. ${readyCount} of ${rows.length} ready. Provider checks have not run.`
          : `Verification finished. ${completed} of ${rows.length} results received.`;
    batch = undefined;
    selection.disabled = student.disabled = start.disabled = false;
    cancel.hidden = true;
  }
  window.addEventListener("pagehide", () => {
    batch?.abort();
    batch = undefined;
    clearResults();
    selection.disabled = student.disabled = start.disabled = false;
    cancel.hidden = true;
  });
  tool.hidden = false;
}
