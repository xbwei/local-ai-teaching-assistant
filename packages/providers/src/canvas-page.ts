import {
  canvasPageId,
  canvasPageTitle,
  safeLessonHtml,
  type CanvasPageDraft,
} from "@laita/contracts";
import type { SecretHandle } from "@laita/runtime";

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
const id = (value: unknown) => {
  const candidate = Number.isSafeInteger(value) ? String(value) : value;
  if (!canvasPageId(candidate)) throw new Error("INVALID_CANVAS_RESPONSE");
  return candidate;
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

async function readJson(response: Response, signal: AbortSignal) {
  if (
    !response.ok ||
    response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase() !== "application/json" ||
    response.headers.has("link")
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
    return row(JSON.parse(raw + decoder.decode()));
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

  async function request(
    endpoint: string,
    draft: CanvasPageDraft,
    write: boolean,
    beforeDispatch?: () => void,
  ) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    deadline.throwIfAborted();
    return refresh().consume(async (token) => {
      if (draft.title.includes(token) || draft.body.includes(token))
        throw new Error("INVALID_DRAFT");
      const body = write
        ? new URLSearchParams({
            "wiki_page[title]": draft.title,
            "wiki_page[body]": draft.body,
            "wiki_page[published]": "false",
            "wiki_page[editing_roles]": "teachers",
            "wiki_page[notify_of_update]": "false",
          })
        : undefined;
      deadline.throwIfAborted();
      // No asynchronous work between the final authority check and dispatch.
      beforeDispatch?.();
      const response = await bounded(
        fetcher(`${origin}/api/v1${endpoint}`, {
          method: write ? "POST" : "GET",
          redirect: "error",
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(body
              ? { "Content-Type": "application/x-www-form-urlencoded" }
              : {}),
          },
          ...(body ? { body: body.toString() } : {}),
          signal: deadline,
        }),
        deadline,
        (late) => {
          void late.body?.cancel().catch(() => {});
        },
      );
      const result = await readJson(response, deadline);
      deadline.throwIfAborted();
      if (JSON.stringify(result).includes(token))
        throw new Error("INVALID_CANVAS_RESPONSE");
      return result;
    });
  }

  return {
    async readTarget(draft: CanvasPageDraft) {
      const self = await request("/users/self", draft, false);
      if (id(self.id) !== teacherId) throw new Error("INVALID_CANVAS_TARGET");
      const course = await request(coursePath, draft, false);
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
      const created = await request(
        `${coursePath}/pages`,
        draft,
        true,
        beforeDispatch,
      );
      if (created.course_id !== undefined && id(created.course_id) !== courseId)
        throw new Error("INVALID_CANVAS_TARGET");
      return id(created.page_id);
    },
    async readBack(pageId: string, draft: CanvasPageDraft) {
      if (!canvasPageId(pageId)) throw new Error("INVALID_CANVAS_RESPONSE");
      const page = await request(
        `${coursePath}/pages/page_id:${pageId}`,
        draft,
        false,
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
