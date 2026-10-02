import assert from "node:assert/strict";
import test from "node:test";
import { publicErrorMessages, isPublicError } from "@laita/contracts";
const id = "12345678-1234-4123-8123-123456789abc";
const envelope = (code = "INTERNAL_FAILURE") => ({
  contractVersion: "public-error.v1",
  code,
  message: publicErrorMessages[code],
  correlationId: id,
  retryable: false,
});

test("public errors are versioned, closed, bounded and bound to fixed code/message pairs", () => {
  for (const code of Object.keys(publicErrorMessages)) {
    const value = envelope(code);
    assert.equal(isPublicError(value), true);
    for (const key of Object.keys(value)) {
      const missing = { ...value };
      delete missing[key];
      assert.equal(isPublicError(missing), false);
    }
  }
  for (const value of [
    null,
    {},
    { ...envelope(), contractVersion: "public-error.v2" },
    { ...envelope(), code: "UNKNOWN" },
    { ...envelope(), message: "synthetic-exception" },
    { ...envelope(), code: "NOT_FOUND" },
    { ...envelope(), correlationId: "synthetic-user-id" },
    { ...envelope(), correlationId: "x".repeat(500) },
    { ...envelope(), retryable: true },
    { ...envelope(), stack: "synthetic-stack" },
  ]) {
    assert.equal(isPublicError(value), false);
  }
});
