import {
  canvasPageId,
  canvasPageTitle,
  safeLessonHtml,
} from "./canvas-page.ts";
import type { CanvasPagePreview } from "./canvas-page.ts";

export const canvasAssignmentSubmissionTypes = {
  online_text_entry: "Text Entry",
  online_url: "Website URL",
  online_upload: "File Upload",
} as const;

type SubmissionType = keyof typeof canvasAssignmentSubmissionTypes;

export type CanvasAssignmentDraft =
  | {
      kind: "CREATE";
      title: string;
      body: string;
      pointsPossible: number;
      submissionTypes: SubmissionType[];
      dueAt: string | null;
    }
  | { kind: "TITLE"; assignmentId: string; title: string };

export interface CanvasAssignmentScope {
  groupId: string;
  editableIds: string[];
}

export type CanvasAssignmentSubject =
  | { kind: "CREATE"; id: string; name: string }
  | {
      kind: "TITLE";
      id: string;
      name: string;
      updatedAt: string;
      published: boolean;
    };

export interface CanvasAssignmentPreview {
  planId: string;
  target: CanvasPagePreview["target"];
  subject: CanvasAssignmentSubject;
  draft: CanvasAssignmentDraft;
}

export type CanvasAssignmentResult =
  | { status: "VERIFIED" | "UNVERIFIED"; assignmentId: string }
  | { status: "UNCERTAIN" };

export function readCanvasAssignmentScope(
  value: unknown,
): CanvasAssignmentScope {
  const row = value as Partial<CanvasAssignmentScope> | undefined;
  if (
    !row ||
    typeof row !== "object" ||
    Object.keys(row).sort().join(",") !== "editableIds,groupId" ||
    !canvasPageId(row.groupId) ||
    !Array.isArray(row.editableIds) ||
    row.editableIds.length > 12 ||
    !row.editableIds.every(canvasPageId) ||
    new Set(row.editableIds).size !== row.editableIds.length
  )
    throw new Error("INVALID_ASSIGNMENT_SCOPE");
  return { groupId: row.groupId, editableIds: [...row.editableIds] };
}

const submissionType = (value: unknown): value is SubmissionType =>
  typeof value === "string" &&
  Object.hasOwn(canvasAssignmentSubmissionTypes, value);

export function readCanvasAssignmentDraft(
  value: unknown,
): CanvasAssignmentDraft {
  if (!value || typeof value !== "object") throw new Error("INVALID_DRAFT");
  const draft = value as Record<string, unknown>;
  const keys = Object.keys(draft).sort().join(",");
  if (!canvasPageTitle(draft.title)) throw new Error("INVALID_DRAFT");
  if (
    draft.kind === "TITLE" &&
    keys === "assignmentId,kind,title" &&
    canvasPageId(draft.assignmentId)
  )
    return {
      kind: "TITLE",
      assignmentId: draft.assignmentId,
      title: draft.title,
    };
  if (
    draft.kind !== "CREATE" ||
    keys !== "body,dueAt,kind,pointsPossible,submissionTypes,title" ||
    typeof draft.pointsPossible !== "number" ||
    !Number.isFinite(draft.pointsPossible) ||
    draft.pointsPossible < 0 ||
    draft.pointsPossible > Number.MAX_SAFE_INTEGER ||
    !Array.isArray(draft.submissionTypes) ||
    draft.submissionTypes.length === 0 ||
    draft.submissionTypes.length > 3 ||
    !draft.submissionTypes.every(submissionType) ||
    new Set(draft.submissionTypes).size !== draft.submissionTypes.length
  )
    throw new Error("INVALID_DRAFT");

  const dueAt = draft.dueAt;
  if (
    dueAt !== null &&
    (typeof dueAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/u.test(dueAt) ||
      !Number.isFinite(Date.parse(dueAt)) ||
      new Date(dueAt).toISOString() !== dueAt)
  )
    throw new Error("INVALID_DRAFT");

  return {
    kind: "CREATE",
    title: draft.title,
    body: safeLessonHtml(draft.body),
    pointsPossible: draft.pointsPossible,
    submissionTypes: [...draft.submissionTypes].sort(),
    dueAt,
  };
}
