import { canvasPageId } from "@laita/contracts";

export function canvasResponseId(value: unknown) {
  const candidate = Number.isSafeInteger(value) ? String(value) : value;
  if (!canvasPageId(candidate)) throw new Error("INVALID_CANVAS_RESPONSE");
  return candidate;
}

export function canvasResponseTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}
