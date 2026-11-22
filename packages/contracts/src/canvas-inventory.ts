import type { CanvasPagePreview } from "./canvas-page.ts";

export const canvasInventoryKinds = [
  "pages",
  "editable-assignments",
  "module-assignments",
  "modules",
] as const;

export type CanvasInventoryKind = (typeof canvasInventoryKinds)[number];

export function isCanvasInventoryKind(
  value: unknown,
): value is CanvasInventoryKind {
  return canvasInventoryKinds.some((kind) => value === kind);
}

export interface CanvasInventoryEntry {
  id: string;
  title: string;
  published: boolean;
}

export interface CanvasInventory {
  target: CanvasPagePreview["target"];
  entries: CanvasInventoryEntry[];
}
