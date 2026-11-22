import {
  canvasPageId,
  canvasPageTitle,
  safeLessonHtml,
  type CanvasAssignmentDraft,
  type CanvasAssignmentSubject,
} from "@laita/contracts";
import { canvasResponseId } from "./canvas-response.ts";
import type { CanvasAuthoringRequest } from "./canvas-page.ts";

function assignmentDate(value: unknown) {
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("INVALID_CANVAS_RESPONSE");
  return new Date(value).toISOString();
}

export function assignmentAuthoring(
  courseId: string,
  request: CanvasAuthoringRequest,
) {
  const course = `/courses/${courseId}`;
  const path = (id: string) => {
    if (!canvasPageId(id)) throw new Error("INVALID_CANVAS_TARGET");
    return `${course}/assignments/${id}`;
  };
  async function readAssignment(id: string, draft?: CanvasAssignmentDraft) {
    const row = await request(path(id), draft);
    if (
      canvasResponseId(row.id) !== id ||
      canvasResponseId(row.course_id) !== courseId
    )
      throw new Error("INVALID_CANVAS_TARGET");
    return row;
  }
  async function readGroup(groupId: string, draft?: CanvasAssignmentDraft) {
    if (!canvasPageId(groupId)) throw new Error("INVALID_CANVAS_TARGET");
    const row = await request(`${course}/assignment_groups/${groupId}`, draft);
    if (
      canvasResponseId(row.id) !== groupId ||
      !canvasPageTitle(row.name) ||
      (row.course_id !== undefined &&
        canvasResponseId(row.course_id) !== courseId)
    )
      throw new Error("INVALID_CANVAS_TARGET");
    return { id: groupId, name: row.name };
  }

  return {
    describeGroup(groupId: string) {
      return readGroup(groupId);
    },
    async describe(assignmentId: string) {
      const row = await readAssignment(assignmentId);
      if (!canvasPageTitle(row.name) || typeof row.published !== "boolean")
        throw new Error("INVALID_CANVAS_TARGET");
      return { id: assignmentId, title: row.name, published: row.published };
    },

    async preview(
      draft: CanvasAssignmentDraft,
      groupId: string,
    ): Promise<CanvasAssignmentSubject> {
      if (draft.kind === "TITLE") {
        const row = await readAssignment(draft.assignmentId, draft);
        if (!canvasPageTitle(row.name) || typeof row.published !== "boolean")
          throw new Error("INVALID_CANVAS_TARGET");
        const updatedAt = row.updated_at;
        if (
          typeof updatedAt !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
            updatedAt,
          ) ||
          !Number.isFinite(Date.parse(updatedAt))
        )
          throw new Error("INVALID_CANVAS_TARGET");
        return {
          kind: "TITLE",
          id: draft.assignmentId,
          name: row.name,
          updatedAt,
          published: row.published,
        };
      }

      return { kind: "CREATE", ...(await readGroup(groupId, draft)) };
    },

    async write(
      draft: CanvasAssignmentDraft,
      subject: CanvasAssignmentSubject,
      beforeDispatch: () => void,
    ) {
      if (draft.kind !== subject.kind) throw new Error("INVALID_CANVAS_TARGET");
      const fields = new URLSearchParams({
        "assignment[name]": draft.title,
        "assignment[notify_of_update]": "false",
      });
      if (draft.kind === "CREATE") {
        fields.set("assignment[description]", draft.body);
        fields.set("assignment[points_possible]", String(draft.pointsPossible));
        fields.set("assignment[assignment_group_id]", subject.id);
        fields.set("assignment[published]", "false");
        if (draft.dueAt) fields.set("assignment[due_at]", draft.dueAt);
        draft.submissionTypes.forEach((type) =>
          fields.append("assignment[submission_types][]", type),
        );
      } else if (draft.assignmentId !== subject.id) {
        throw new Error("INVALID_CANVAS_TARGET");
      }
      const created = await request(
        draft.kind === "CREATE"
          ? `${course}/assignments`
          : path(draft.assignmentId),
        draft,
        {
          method: draft.kind === "CREATE" ? "POST" : "PUT",
          fields,
          beforeDispatch,
        },
      );
      const id = canvasResponseId(created.id);
      if (
        canvasResponseId(created.course_id) !== courseId ||
        (draft.kind === "TITLE" && id !== draft.assignmentId)
      )
        throw new Error("INVALID_CANVAS_RESPONSE");
      return id;
    },

    async readBack(
      id: string,
      draft: CanvasAssignmentDraft,
      subject: CanvasAssignmentSubject,
    ) {
      const row = await readAssignment(id, draft);
      if (row.name !== draft.title) return false;
      if (draft.kind === "TITLE")
        return subject.kind === "TITLE" && row.published === subject.published;
      return (
        subject.kind === "CREATE" &&
        canvasResponseId(row.assignment_group_id) === subject.id &&
        safeLessonHtml(row.description) === draft.body &&
        row.points_possible === draft.pointsPossible &&
        Array.isArray(row.submission_types) &&
        JSON.stringify([...row.submission_types].sort()) ===
          JSON.stringify(draft.submissionTypes) &&
        assignmentDate(row.due_at) === draft.dueAt &&
        row.published === false
      );
    },
  };
}
