import { canvasPageId, canvasPageTitle } from "./canvas-page.ts";
import type { CanvasPagePreview } from "./canvas-page.ts";

export type CanvasModuleDraft =
  | { kind: "CREATE_MODULE"; title: string }
  | {
      kind: "LINK_PAGE" | "LINK_ASSIGNMENT";
      moduleId: string;
      contentId: string;
    };

export interface CanvasModuleScope {
  moduleIds: string[];
  pageIds: string[];
  assignmentIds: string[];
}

export interface CanvasModuleSubject {
  moduleId: string;
  moduleName: string;
  resourceName: string;
  resourcePublished: boolean;
}

export interface CanvasModulePreview {
  planId: string;
  target: CanvasPagePreview["target"];
  draft: CanvasModuleDraft;
  moduleSubject?: CanvasModuleSubject;
}

export type CanvasModuleResult =
  | { status: "VERIFIED" | "UNVERIFIED"; resourceId: string }
  | { status: "UNCERTAIN" };

function moduleIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 12 ||
    !value.every(canvasPageId) ||
    new Set(value).size !== value.length
  )
    throw new Error("INVALID_MODULE_SCOPE");
  return [...value];
}

export function readCanvasModuleScope(value: unknown): CanvasModuleScope {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "assignmentIds,moduleIds,pageIds"
  )
    throw new Error("INVALID_MODULE_SCOPE");
  const row = value as Record<string, unknown>;
  return {
    moduleIds: moduleIds(row.moduleIds),
    pageIds: moduleIds(row.pageIds),
    assignmentIds: moduleIds(row.assignmentIds),
  };
}

export function readCanvasModuleDraft(value: unknown): CanvasModuleDraft {
  if (!value || typeof value !== "object") throw new Error("INVALID_DRAFT");
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort().join(",");
  if (
    keys === "kind,title" &&
    row.kind === "CREATE_MODULE" &&
    canvasPageTitle(row.title)
  )
    return { kind: row.kind, title: row.title };
  if (
    keys === "contentId,kind,moduleId" &&
    (row.kind === "LINK_PAGE" || row.kind === "LINK_ASSIGNMENT") &&
    canvasPageId(row.moduleId) &&
    canvasPageId(row.contentId)
  )
    return { kind: row.kind, moduleId: row.moduleId, contentId: row.contentId };
  throw new Error("INVALID_DRAFT");
}
