import {
  canvasAssignmentSubmissionTypes,
  canvasPageTitle,
} from "@laita/contracts";
import type { CanvasAuthoringRequest } from "./canvas-page.ts";
import { canvasResponseId as id } from "./canvas-response.ts";

const normalizedTitle = (title: string) =>
  title.normalize("NFC").replace(/\s+/gu, " ").toLowerCase();
const supportedType = (value: unknown) =>
  typeof value === "string" &&
  Object.hasOwn(canvasAssignmentSubmissionTypes, value);
const boundedScore = (value: unknown): value is number =>
  typeof value === "number" && Math.abs(value) <= Number.MAX_SAFE_INTEGER;

export function canvasChat(
  courseId: string,
  read: CanvasAuthoringRequest,
  assertTestStudent: (id: string) => Promise<void>,
) {
  return async function observe(
    selection: { title: string; kind: "count" | "score" },
    scope: { testStudentId: string; assignmentIds: string[] },
  ) {
    let match:
      | { path: string; id: string; row: Record<string, unknown>; name: string }
      | undefined;
    const title = normalizedTitle(selection.title);
    for (const assignmentId of scope.assignmentIds) {
      const path = `/courses/${courseId}/assignments/${id(assignmentId)}`;
      const row = await read(path);
      if (
        id(row.id) !== assignmentId ||
        id(row.course_id) !== courseId ||
        !canvasPageTitle(row.name)
      )
        throw new Error("INVALID_CANVAS_RESPONSE");
      if (normalizedTitle(row.name) === title) {
        if (match) return;
        match = { path, id: assignmentId, row, name: row.name };
      }
    }
    if (!match) return;
    const assignment = match.row;
    const types = assignment.submission_types;
    if (
      assignment.published !== true ||
      assignment.group_category_id !== null ||
      assignment.is_quiz_assignment === true ||
      !Array.isArray(types) ||
      types.length < 1 ||
      types.length > 3 ||
      !types.every(supportedType) ||
      new Set(types).size !== types.length
    )
      throw new Error("UNSUPPORTED_ASSIGNMENT");

    await assertTestStudent(scope.testStudentId);
    const submission = await read(
      `${match.path}/submissions/${id(scope.testStudentId)}?include%5B%5D=visibility`,
    );
    if (
      id(submission.assignment_id) !== match.id ||
      id(submission.user_id) !== scope.testStudentId ||
      submission.assignment_visible !== true ||
      submission.group != null ||
      (submission.excused !== null &&
        typeof submission.excused !== "boolean") ||
      typeof submission.missing !== "boolean"
    )
      throw new Error("INVALID_CANVAS_RESPONSE");

    const name = match.name;
    const missing = submission.missing;
    if (submission.excused === true) return { name, state: "EXCUSED" } as const;
    if (
      (submission.workflow_state === "unsubmitted" ||
        (missing && submission.workflow_state === "graded")) &&
      submission.submitted_at === null &&
      submission.submission_type === null &&
      (submission.attempt === null || submission.attempt === 0)
    )
      return { name, state: "NOT_SUBMITTED", missing } as const;
    if (
      !Number.isSafeInteger(submission.attempt) ||
      Number(submission.attempt) < 1 ||
      typeof submission.submitted_at !== "string" ||
      submission.submitted_at.length > 40 ||
      !Number.isFinite(Date.parse(submission.submitted_at)) ||
      !types.includes(submission.submission_type) ||
      !["submitted", "pending_review", "graded"].includes(
        String(submission.workflow_state),
      )
    )
      throw new Error("INVALID_CANVAS_RESPONSE");

    const submitted = { name, state: "SUBMITTED", missing } as const;
    if (selection.kind === "count" || missing) return submitted;
    if (submission.workflow_state !== "graded" && submission.score === null)
      return { ...submitted, ungraded: true };
    if (
      submission.workflow_state !== "graded" ||
      submission.grade_matches_current_submission !== true ||
      !boundedScore(submission.score)
    )
      return submitted;
    const pointsPossible = assignment.points_possible;
    return {
      ...submitted,
      score: submission.score,
      ...(boundedScore(pointsPossible) &&
        pointsPossible >= 0 && { pointsPossible }),
    };
  };
}
