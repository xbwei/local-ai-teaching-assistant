import { createHash } from "node:crypto";
import {
  canvasAssignmentSubmissionTypes,
  canvasFeedbackSubmittedAt,
  canvasPageTitle,
  type CanvasFeedbackDraft,
  type CanvasFeedbackSubject,
} from "@laita/contracts";
import type { CanvasAuthoringRequest } from "./canvas-page.ts";
import { canvasResponseId as id } from "./canvas-response.ts";

function commentRows(value: unknown) {
  if (!Array.isArray(value)) throw new Error("INVALID_CANVAS_RESPONSE");
  const comments = new Map<string, Record<string, unknown>>();
  for (const comment of value) {
    if (!comment || typeof comment !== "object" || Array.isArray(comment))
      throw new Error("INVALID_CANVAS_RESPONSE");
    const key = id(comment.id);
    if (comments.has(key)) throw new Error("INVALID_CANVAS_RESPONSE");
    comments.set(key, comment);
  }
  return comments;
}

function assertSubmission(
  submission: Record<string, unknown>,
  assignmentId: string,
  studentId: string,
) {
  if (
    id(submission.assignment_id) !== assignmentId ||
    id(submission.user_id) !== studentId
  )
    throw new Error("INVALID_CANVAS_TARGET");
}

export function feedbackAuthoring(
  courseId: string,
  teacherId: string,
  request: CanvasAuthoringRequest,
  assertTestStudent: (id: string) => Promise<void>,
) {
  const assignmentPath = (assignmentId: string) =>
    `/courses/${courseId}/assignments/${id(assignmentId)}`;
  const submissionPath = (assignmentId: string, studentId: string) =>
    `${assignmentPath(assignmentId)}/submissions/${id(studentId)}`;

  async function readTarget(assignmentId: string, studentId: string) {
    const assignment = await request(assignmentPath(assignmentId));
    const types = assignment.submission_types;
    if (
      id(assignment.id) !== assignmentId ||
      id(assignment.course_id) !== courseId ||
      !canvasPageTitle(assignment.name) ||
      assignment.published !== true ||
      assignment.group_category_id !== null ||
      assignment.is_quiz_assignment === true ||
      assignment.anonymous_grading === true ||
      assignment.moderated_grading === true ||
      !Array.isArray(types) ||
      types.length < 1 ||
      types.length > 3 ||
      new Set(types).size !== types.length ||
      !types.every(
        (type) =>
          typeof type === "string" &&
          Object.hasOwn(canvasAssignmentSubmissionTypes, type),
      )
    )
      throw new Error("UNSUPPORTED_ASSIGNMENT");
    await assertTestStudent(studentId);
    const query = new URLSearchParams([
      ["include[]", "visibility"],
      ["include[]", "group"],
      ["include[]", "submission_comments"],
    ]);
    const submission = await request(
      `${submissionPath(assignmentId, studentId)}?${query}`,
    );
    assertSubmission(submission, assignmentId, studentId);
    const { attempt, submitted_at: submittedAt, group } = submission;
    const workflow = submission.workflow_state;
    if (
      submission.assignment_visible !== true ||
      (group != null &&
        (typeof group !== "object" || !("id" in group) || group.id !== null)) ||
      (submission.excused !== false && submission.excused !== null) ||
      submission.missing !== false ||
      typeof attempt !== "number" ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      !canvasFeedbackSubmittedAt(submittedAt) ||
      !types.includes(submission.submission_type) ||
      typeof workflow !== "string" ||
      !["submitted", "pending_review", "graded"].includes(workflow)
    )
      throw new Error("UNSUPPORTED_SUBMISSION");
    // An Instructor comment can post an unposted submission under automatic posting.
    if (
      !canvasFeedbackSubmittedAt(submission.posted_at) &&
      !(submission.posted_at === null && assignment.post_manually === true)
    )
      throw new Error("UNSUPPORTED_POSTING_POLICY");

    const subject: CanvasFeedbackSubject = {
      assignmentName: assignment.name,
      testStudentId: studentId,
      attempt,
      submittedAt,
    };
    // Keep only a digest of submission content. Never follow URLs or return it.
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          subject,
          assignment.updated_at,
          assignment.post_manually,
          types,
          id(submission.id),
          submission.submission_type,
          workflow,
          submission.posted_at,
          submission.body,
          submission.url,
          submission.attachments,
        ]),
      )
      .digest("hex");
    return {
      subject,
      digest,
      comments: commentRows(submission.submission_comments),
    };
  }

  function matches(
    comment: Record<string, unknown> | undefined,
    text: string,
    attempt: number,
  ) {
    return (
      !!comment &&
      (comment.author_id === teacherId ||
        comment.author_id === Number(teacherId)) &&
      comment.comment === text &&
      comment.attempt === attempt
    );
  }

  return {
    async preview(assignmentId: string, studentId: string) {
      const { subject, digest, comments } = await readTarget(
        assignmentId,
        studentId,
      );
      return { subject, digest, commentIds: [...comments.keys()].sort() };
    },
    async post(
      draft: CanvasFeedbackDraft,
      subject: CanvasFeedbackSubject,
      priorIds: string[],
      beforeDispatch: () => void,
    ) {
      const { testStudentId, attempt } = subject;
      // Canvas sanitizes comment HTML and returns a plain-text projection.
      const text = draft.text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      const response = await request(
        submissionPath(draft.assignmentId, testStudentId),
        undefined,
        {
          method: "PUT",
          fields: new URLSearchParams({
            "comment[text_comment]": text,
            "comment[attempt]": String(attempt),
            "comment[group_comment]": "false",
          }),
          beforeDispatch,
        },
      );
      assertSubmission(response, draft.assignmentId, testStudentId);
      if (response.attempt !== attempt)
        throw new Error("INVALID_CANVAS_RESPONSE");
      const existing = new Set(priorIds);
      const added = [...commentRows(response.submission_comments)].filter(
        ([commentId, comment]) =>
          !existing.has(commentId) && matches(comment, draft.text, attempt),
      );
      if (added.length !== 1) throw new Error("INVALID_CANVAS_RESPONSE");
      return added[0]![0];
    },
    async readBack(
      commentId: string,
      draft: CanvasFeedbackDraft,
      subject: CanvasFeedbackSubject,
      digest: string,
    ) {
      const result = await readTarget(
        draft.assignmentId,
        subject.testStudentId,
      );
      return (
        result.digest === digest &&
        matches(result.comments.get(commentId), draft.text, subject.attempt)
      );
    },
  };
}
