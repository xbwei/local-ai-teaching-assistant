import { createHash } from "node:crypto";
export { canvasPageId as verificationId } from "@laita/contracts";

export class VerificationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export const verificationDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
