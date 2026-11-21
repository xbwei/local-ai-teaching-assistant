import { canvasPageId } from "./canvas-page.ts";
import type { CanvasPagePreview } from "./canvas-page.ts";
import { utf8Bytes } from "./provider-control.ts";

export interface CanvasFeedbackDraft {
  kind: "FEEDBACK";
  assignmentId: string;
  text: string;
}

export interface CanvasTestStudentScope {
  testStudentId: string;
  assignmentIds: string[];
}

export interface CanvasFeedbackSubject {
  assignmentName: string;
  testStudentId: string;
  attempt: number;
  submittedAt: string;
}

export interface CanvasFeedbackPreview {
  planId: string;
  target: CanvasPagePreview["target"];
  draft: CanvasFeedbackDraft;
  feedbackSubject: CanvasFeedbackSubject;
}

export type CanvasFeedbackResult =
  | { status: "VERIFIED" | "UNVERIFIED"; commentId: string }
  | { status: "UNCERTAIN" };

export function canvasFeedbackSubmittedAt(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

export function readCanvasTestStudentScope(
  value: unknown,
): CanvasTestStudentScope {
  if (!value || typeof value !== "object")
    throw new Error("INVALID_TEST_STUDENT_SCOPE");
  const { testStudentId, assignmentIds } = value as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !== "assignmentIds,testStudentId" ||
    !canvasPageId(testStudentId) ||
    !Array.isArray(assignmentIds) ||
    assignmentIds.length < 1 ||
    assignmentIds.length > 12 ||
    !assignmentIds.every(canvasPageId) ||
    new Set(assignmentIds).size !== assignmentIds.length
  )
    throw new Error("INVALID_TEST_STUDENT_SCOPE");
  return { testStudentId, assignmentIds: [...assignmentIds] };
}

export function readCanvasFeedbackDraft(value: unknown): CanvasFeedbackDraft {
  if (!value || typeof value !== "object") throw new Error("INVALID_DRAFT");
  const { kind, assignmentId, text } = value as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !== "assignmentId,kind,text" ||
    kind !== "FEEDBACK" ||
    !canvasPageId(assignmentId) ||
    typeof text !== "string" ||
    !text.trim() ||
    text !== text.trim() ||
    text.length > 1024 ||
    utf8Bytes(text) > 1024 ||
    /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\p{Cs}]/u.test(
      text,
    )
  )
    throw new Error("INVALID_DRAFT");
  return { kind, assignmentId, text };
}
