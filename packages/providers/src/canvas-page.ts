import { createHash } from "node:crypto";
import {
  canvasFeedbackSubmittedAt,
  canvasPageId,
  canvasPageTitle,
  safeLessonHtml,
  type CanvasPageDraft,
} from "@laita/contracts";
import type { SecretHandle } from "@laita/runtime";
import { assignmentAuthoring } from "./canvas-assignment.ts";
import { canvasChat } from "./canvas-chat.ts";
import { feedbackAuthoring } from "./canvas-feedback.ts";
import { moduleAuthoring } from "./canvas-module.ts";
import { canvasResponseId as id } from "./canvas-response.ts";

interface PageTarget {
  origin: string;
  courseId: string;
  teacherId: string;
}

const row = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_CANVAS_RESPONSE");
  return value as Record<string, unknown>;
};

function bounded<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  discard?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("CANVAS_UNAVAILABLE"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) discard?.(value);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function readJson(
  response: Response,
  signal: AbortSignal,
  singleStudentView: boolean,
): Promise<unknown> {
  if (
    !response.ok ||
    response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase() !== "application/json" ||
    (response.headers.has("link") && !singleStudentView)
  ) {
    void response.body?.cancel().catch(() => {});
    throw new Error("CANVAS_UNAVAILABLE");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("INVALID_CANVAS_RESPONSE");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let raw = "";
  try {
    for (;;) {
      const part = await bounded(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 128 * 1024) throw new Error("INVALID_CANVAS_RESPONSE");
      raw += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(raw + decoder.decode()) as unknown;
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export interface CanvasPageAccess extends PageTarget {
  refresh: () => SecretHandle;
  fetcher?: typeof fetch;
}

type CanvasContent = { title: string; body?: string };
interface CanvasWrite {
  method: "POST" | "PUT";
  fields: URLSearchParams;
  beforeDispatch: () => void;
}

export type CanvasAuthoringRequest = (
  endpoint: string,
  content?: CanvasContent,
  write?: CanvasWrite,
) => Promise<Record<string, unknown>>;

export function createCanvasPageClient(
  access: CanvasPageAccess,
  signal: AbortSignal,
) {
  const { origin, courseId, teacherId, refresh, fetcher = fetch } = access;
  const parsed = new URL(origin);
  if (
    parsed.origin !== origin ||
    parsed.protocol !== "https:" ||
    !canvasPageId(courseId) ||
    !canvasPageId(teacherId)
  )
    throw new Error("INVALID_CANVAS_TARGET");
  const coursePath = `/courses/${courseId}`;

  async function requestJson(
    endpoint: string,
    content?: CanvasContent,
    write?: CanvasWrite,
    singleStudentView = false,
  ) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    deadline.throwIfAborted();
    return refresh().consume(async (token) => {
      if (
        content?.title.includes(token) ||
        content?.body?.includes(token) ||
        (write &&
          [...write.fields.values()].some((value) => value.includes(token)))
      )
        throw new Error("INVALID_DRAFT");
      const body = write?.fields.toString();
      deadline.throwIfAborted();
      // No asynchronous work between the final authority check and dispatch.
      write?.beforeDispatch();
      const response = await bounded(
        fetcher(`${origin}/api/v1${endpoint}`, {
          method: write?.method ?? "GET",
          redirect: "error",
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(body
              ? { "Content-Type": "application/x-www-form-urlencoded" }
              : {}),
          },
          ...(body ? { body } : {}),
          signal: deadline,
        }),
        deadline,
        (late) => {
          void late.body?.cancel().catch(() => {});
        },
      );
      const result = await readJson(response, deadline, singleStudentView);
      deadline.throwIfAborted();
      if (JSON.stringify(result).includes(token))
        throw new Error("INVALID_CANVAS_RESPONSE");
      return result;
    });
  }
  const request: CanvasAuthoringRequest = async (endpoint, content, write) =>
    row(await requestJson(endpoint, content, write));

  async function assertCourseStudent(
    studentId: string,
    enrollment: "student_view" | "student",
  ) {
    if (!canvasPageId(studentId) || studentId === teacherId)
      throw new Error("INVALID_CANVAS_TARGET");
    const query = new URLSearchParams({
      "user_ids[]": studentId,
      "enrollment_type[]": enrollment,
      "enrollment_state[]": "active",
      per_page: "2",
    });
    // Canvas may send pagination links even for this exact singleton lookup.
    // The course, type and ID filters fix the candidate, and no link is followed.
    const result = await requestJson(
      `${coursePath}/users?${query}`,
      undefined,
      undefined,
      true,
    );
    if (
      !Array.isArray(result) ||
      result.length !== 1 ||
      id(row(result[0]).id) !== studentId
    )
      throw new Error("INVALID_CANVAS_TARGET");
  }

  async function verificationSource(assignmentId: string, studentId: string) {
    const path = `${coursePath}/assignments/${id(assignmentId)}`;
    const assignment = await request(path);
    if (
      id(assignment.id) !== assignmentId ||
      id(assignment.course_id) !== courseId ||
      assignment.published !== true ||
      assignment.group_category_id !== null ||
      assignment.is_quiz_assignment === true ||
      assignment.anonymous_grading === true ||
      assignment.moderated_grading === true ||
      !Array.isArray(assignment.submission_types)
    )
      throw new Error("INVALID_CANVAS_TARGET");
    await assertCourseStudent(studentId, "student");
    const s = await request(
      `${path}/submissions/${id(studentId)}?include%5B%5D=visibility&include%5B%5D=group`,
    );
    if (
      id(s.assignment_id) !== assignmentId ||
      id(s.user_id) !== studentId ||
      s.assignment_visible !== true ||
      (s.excused !== null && s.excused !== false) ||
      (s.group != null && row(s.group).id !== null)
    )
      throw new Error("INVALID_CANVAS_TARGET");
    if (
      (s.workflow_state === "unsubmitted" ||
        (s.workflow_state === "graded" && s.missing === true)) &&
      s.submitted_at === null &&
      (s.attempt === null || s.attempt === 0) &&
      s.submission_type === null
    )
      return;
    const { attempt, submitted_at: submittedAt, submission_type: type } = s;
    if (
      typeof attempt !== "number" ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      !canvasFeedbackSubmittedAt(submittedAt) ||
      (type !== "online_text_entry" && type !== "online_url") ||
      !assignment.submission_types.includes(type) ||
      s.missing !== false ||
      (s.workflow_state !== "submitted" &&
        s.workflow_state !== "graded" &&
        s.workflow_state !== "pending_review")
    )
      throw new Error("INVALID_CANVAS_TARGET");
    const source = type === "online_text_entry" ? s.body : s.url;
    if (
      typeof source !== "string" ||
      !source.trim() ||
      Buffer.byteLength(source) > 16_000
    )
      throw new Error("INVALID_CANVAS_TARGET");
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          id(s.id),
          assignment.updated_at,
          assignment.submission_types,
          attempt,
          submittedAt,
          type,
          source,
        ]),
      )
      .digest("hex");
    return { attempt, submittedAt, type, source, digest };
  }

  return {
    assignments: assignmentAuthoring(courseId, request),
    modules: moduleAuthoring(courseId, request),
    chat: canvasChat(courseId, request, (studentId) =>
      assertCourseStudent(studentId, "student_view"),
    ),
    feedback: feedbackAuthoring(courseId, teacherId, request, (studentId) =>
      assertCourseStudent(studentId, "student_view"),
    ),
    verificationSource,
    async readTarget(draft?: { title: string; body?: string }) {
      const self = await request("/users/self", draft);
      if (id(self.id) !== teacherId) throw new Error("INVALID_CANVAS_TARGET");
      const course = await request(coursePath, draft);
      if (
        id(course.id) !== courseId ||
        course.workflow_state !== "available" ||
        !Array.isArray(course.enrollments) ||
        !course.enrollments.some((entry: unknown) => {
          const e = row(entry);
          return (
            e.type === "teacher" &&
            e.enrollment_state === "active" &&
            id(e.user_id) === teacherId
          );
        }) ||
        !canvasPageTitle(course.name)
      )
        throw new Error("INVALID_CANVAS_TARGET");
      return { origin, courseId, teacherId, courseName: course.name };
    },
    async create(draft: CanvasPageDraft, beforeDispatch: () => void) {
      const created = await request(`${coursePath}/pages`, draft, {
        method: "POST",
        fields: new URLSearchParams({
          "wiki_page[title]": draft.title,
          "wiki_page[body]": draft.body,
          "wiki_page[published]": "false",
          "wiki_page[editing_roles]": "teachers",
          "wiki_page[notify_of_update]": "false",
        }),
        beforeDispatch,
      });
      if (created.course_id !== undefined && id(created.course_id) !== courseId)
        throw new Error("INVALID_CANVAS_TARGET");
      return id(created.page_id);
    },
    async readBack(pageId: string, draft: CanvasPageDraft) {
      if (!canvasPageId(pageId)) throw new Error("INVALID_CANVAS_RESPONSE");
      const page = await request(
        `${coursePath}/pages/page_id:${pageId}`,
        draft,
      );
      return (
        id(page.page_id) === pageId &&
        (page.course_id === undefined || id(page.course_id) === courseId) &&
        page.title === draft.title &&
        safeLessonHtml(page.body) === draft.body &&
        page.published === false &&
        page.editing_roles === "teachers"
      );
    },
  };
}
