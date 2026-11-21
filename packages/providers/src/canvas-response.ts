import { canvasPageId } from "@laita/contracts";

export function canvasResponseId(value: unknown) {
  const candidate = Number.isSafeInteger(value) ? String(value) : value;
  if (!canvasPageId(candidate)) throw new Error("INVALID_CANVAS_RESPONSE");
  return candidate;
}
