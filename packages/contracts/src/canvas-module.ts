import { canvasPageId, canvasPageTitle } from "./canvas-page.ts";
import type { CanvasPagePreview } from "./canvas-page.ts";
import type { CanvasInventoryEntry } from "./canvas-inventory.ts";

export const canvasModuleOrderLimit = 10;
export const canvasModuleCatalogLimit = 250;

export interface CanvasModuleCatalog {
  modules: CanvasInventoryEntry[];
  pages: CanvasInventoryEntry[];
  assignments: CanvasInventoryEntry[];
}

export interface CanvasModuleLinkItem {
  kind: "LINK_PAGE" | "LINK_ASSIGNMENT";
  contentId: string;
}

export type CanvasModuleLinkDraft = CanvasModuleLinkItem & { moduleId: string };

export type CanvasModuleOrderDraft = {
  kind: "LINK_ORDERED";
  moduleId: string;
  items: CanvasModuleLinkItem[];
};

export type CanvasModuleDraft =
  | { kind: "CREATE_MODULE"; title: string }
  | CanvasModuleLinkDraft
  | CanvasModuleOrderDraft;

export interface CanvasModuleScope {
  moduleIds: string[];
  pageIds: string[];
  assignmentIds: string[];
  organizeSavedResources?: true;
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
  orderedSubjects?: CanvasModuleSubject[];
}

export type CanvasModuleStep =
  | { status: "VERIFIED" | "UNVERIFIED"; resourceId: string }
  | { status: "UNCERTAIN" };

export type CanvasModuleResult =
  CanvasModuleStep | { status: "ORDERED"; steps: CanvasModuleStep[] };

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
  if (!value || typeof value !== "object")
    throw new Error("INVALID_MODULE_SCOPE");
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort().join(",");
  if (keys === "organizeSavedResources" && row.organizeSavedResources === true)
    return {
      moduleIds: [],
      pageIds: [],
      assignmentIds: [],
      organizeSavedResources: true,
    };
  if (
    keys !== "assignmentIds,moduleIds,pageIds" &&
    !(
      keys === "assignmentIds,moduleIds,organizeSavedResources,pageIds" &&
      row.organizeSavedResources === true
    )
  )
    throw new Error("INVALID_MODULE_SCOPE");
  return {
    moduleIds: moduleIds(row.moduleIds),
    pageIds: moduleIds(row.pageIds),
    assignmentIds: moduleIds(row.assignmentIds),
    ...(row.organizeSavedResources === true && {
      organizeSavedResources: true,
    }),
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
  if (
    keys === "items,kind,moduleId" &&
    row.kind === "LINK_ORDERED" &&
    canvasPageId(row.moduleId) &&
    Array.isArray(row.items) &&
    row.items.length >= 2 &&
    row.items.length <= canvasModuleOrderLimit
  ) {
    const items = Array.from(
      row.items,
      (item: unknown): CanvasModuleLinkItem => {
        if (!item || typeof item !== "object") throw new Error("INVALID_DRAFT");
        const link = item as Record<string, unknown>;
        if (
          Object.keys(link).sort().join(",") !== "contentId,kind" ||
          (link.kind !== "LINK_PAGE" && link.kind !== "LINK_ASSIGNMENT") ||
          !canvasPageId(link.contentId)
        )
          throw new Error("INVALID_DRAFT");
        return { kind: link.kind, contentId: link.contentId };
      },
    );
    if (
      new Set(items.map(({ kind, contentId }) => `${kind}:${contentId}`))
        .size !== items.length
    )
      throw new Error("INVALID_DRAFT");
    return { kind: row.kind, moduleId: row.moduleId, items };
  }
  throw new Error("INVALID_DRAFT");
}
