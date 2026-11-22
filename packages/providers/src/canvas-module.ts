import {
  canvasAssignmentSubmissionTypes,
  canvasPageTitle,
  type CanvasModuleDraft,
  type CanvasModuleSubject,
} from "@laita/contracts";
import type { CanvasAuthoringRequest } from "./canvas-page.ts";
import { canvasResponseId as id } from "./canvas-response.ts";

const maxItems = 25;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_CANVAS_RESPONSE");
  return value as Record<string, unknown>;
};

function position(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("INVALID_CANVAS_RESPONSE");
  return value;
}

type LinkDraft = Exclude<CanvasModuleDraft, { kind: "CREATE_MODULE" }>;

export function moduleAuthoring(
  courseId: string,
  request: CanvasAuthoringRequest,
) {
  const course = `/courses/${courseId}`;
  const modules = `${course}/modules`;
  const verifyCourse = (row: Record<string, unknown>) =>
    row.course_id === undefined || id(row.course_id) === courseId;

  async function readModule(moduleId: string, draft?: { title: string }) {
    const row = await request(
      `${modules}/${id(moduleId)}?include%5B%5D=items`,
      draft,
    );
    if (
      id(row.id) !== moduleId ||
      !verifyCourse(row) ||
      row.published !== false ||
      !canvasPageTitle(row.name) ||
      !Array.isArray(row.items) ||
      row.items.length > maxItems ||
      row.items_count !== row.items.length
    )
      throw new Error("INVALID_CANVAS_TARGET");

    const items = row.items
      .map((value: unknown) => {
        const item = record(value);
        if (
          id(item.module_id) !== moduleId ||
          !canvasPageTitle(item.type) ||
          typeof item.published !== "boolean"
        )
          throw new Error("INVALID_CANVAS_RESPONSE");
        let reference: string | undefined;
        if (item.type === "Page") {
          if (!canvasPageTitle(item.page_url))
            throw new Error("INVALID_CANVAS_RESPONSE");
          reference = item.page_url;
        } else if (item.type === "Assignment") {
          reference = id(item.content_id);
        }
        return {
          id: id(item.id),
          position: position(item.position),
          type: item.type,
          published: item.published,
          reference,
        };
      })
      .sort((a, b) => a.position - b.position);
    if (
      new Set(items.map((item) => item.id)).size !== items.length ||
      new Set(items.map((item) => item.position)).size !== items.length
    )
      throw new Error("INVALID_CANVAS_RESPONSE");
    return { name: row.name, position: position(row.position), items };
  }

  async function readResource({
    kind,
    contentId,
  }: Pick<LinkDraft, "kind" | "contentId">) {
    if (kind === "LINK_PAGE") {
      const row = await request(`${course}/pages/page_id:${id(contentId)}`);
      if (
        id(row.page_id) !== contentId ||
        !verifyCourse(row) ||
        !canvasPageTitle(row.url) ||
        !canvasPageTitle(row.title) ||
        typeof row.published !== "boolean"
      )
        throw new Error("INVALID_CANVAS_TARGET");
      return {
        type: "Page",
        name: row.title,
        published: row.published,
        reference: row.url,
      };
    }
    const row = await request(`${course}/assignments/${id(contentId)}`);
    // Canvas can substitute a quiz or discussion for its backing Assignment.
    if (
      id(row.id) !== contentId ||
      id(row.course_id) !== courseId ||
      !canvasPageTitle(row.name) ||
      typeof row.published !== "boolean" ||
      row.is_quiz_assignment !== false ||
      row.discussion_topic != null ||
      !Array.isArray(row.submission_types) ||
      row.submission_types.length < 1 ||
      row.submission_types.length > 3 ||
      !row.submission_types.every(
        (type: unknown) =>
          typeof type === "string" &&
          Object.hasOwn(canvasAssignmentSubmissionTypes, type),
      )
    )
      throw new Error("INVALID_CANVAS_TARGET");
    return {
      type: "Assignment",
      name: row.name,
      published: row.published,
      reference: contentId,
    };
  }

  async function preview(draft: LinkDraft) {
    const module = await readModule(draft.moduleId);
    const resource = await readResource(draft);
    if (
      module.items.length >= maxItems ||
      module.items.some(
        (item) =>
          item.type === resource.type && item.reference === resource.reference,
      )
    )
      throw new Error("INVALID_CANVAS_TARGET");
    const subject: CanvasModuleSubject = {
      moduleId: draft.moduleId,
      moduleName: module.name,
      resourceName: resource.name,
      resourcePublished: resource.published,
    };
    return { module, resource, subject };
  }

  type LinkPreview = Awaited<ReturnType<typeof preview>>;
  return {
    preview,
    async describeDestination(moduleId: string) {
      const module = await readModule(moduleId);
      return { id: moduleId, title: module.name, published: false };
    },
    async describeItem(kind: LinkDraft["kind"], contentId: string) {
      const resource = await readResource({ kind, contentId });
      return {
        id: contentId,
        title: resource.name,
        published: resource.published,
      };
    },
    async write(
      draft: CanvasModuleDraft,
      link: LinkPreview | undefined,
      beforeDispatch: () => void,
    ) {
      if (draft.kind === "CREATE_MODULE") {
        const row = await request(modules, draft, {
          method: "POST",
          fields: new URLSearchParams({ "module[name]": draft.title }),
          beforeDispatch,
        });
        if (!verifyCourse(row)) throw new Error("INVALID_CANVAS_RESPONSE");
        return id(row.id);
      }
      if (!link || link.subject.moduleId !== draft.moduleId)
        throw new Error("INVALID_CANVAS_TARGET");
      const fields = new URLSearchParams({
        "module_item[type]": link.resource.type,
        [draft.kind === "LINK_PAGE"
          ? "module_item[page_url]"
          : "module_item[content_id]"]: link.resource.reference,
      });
      const row = await request(
        `${modules}/${id(draft.moduleId)}/items`,
        undefined,
        {
          method: "POST",
          fields,
          beforeDispatch,
        },
      );
      if (id(row.module_id) !== draft.moduleId)
        throw new Error("INVALID_CANVAS_RESPONSE");
      return id(row.id);
    },
    async readBack(
      resourceId: string,
      draft: CanvasModuleDraft,
      link: LinkPreview | undefined,
    ) {
      if (draft.kind === "CREATE_MODULE") {
        const module = await readModule(resourceId, draft);
        return module.name === draft.title && module.items.length === 0;
      }
      if (!link || link.subject.moduleId !== draft.moduleId) return false;
      const resource = await readResource(draft);
      const module = await readModule(draft.moduleId);
      const last = module.items.at(-1);
      return (
        JSON.stringify(resource) === JSON.stringify(link.resource) &&
        module.name === link.module.name &&
        module.position === link.module.position &&
        last?.id === resourceId &&
        last.type === resource.type &&
        last.reference === resource.reference &&
        last.published === resource.published &&
        JSON.stringify(module.items.slice(0, -1)) ===
          JSON.stringify(link.module.items)
      );
    },
  };
}
