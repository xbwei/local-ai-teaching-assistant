import assert from "node:assert/strict";
import test from "node:test";
import { Ajv } from "ajv";
import {
  healthStatus,
  healthStatusSchema,
  readinessStatusSchema,
  isHealthStatus,
  isReadinessStatus,
  publicErrorMessages,
} from "@laita/contracts";

const unavailable = {
  contractVersion: "readiness.v1",
  status: "not-ready",
  error: {
    contractVersion: "public-error.v1",
    code: "SERVICE_UNAVAILABLE",
    message: publicErrorMessages.SERVICE_UNAVAILABLE,
    correlationId: "00000000-0000-4000-8000-000000000000",
    retryable: false,
  },
};

test("health/readiness are closed versioned contracts with no dependency claims or arbitrary metadata", () => {
  for (const [schema, wrapper, values] of [
    [healthStatusSchema, isHealthStatus, [healthStatus]],
    [
      readinessStatusSchema,
      isReadinessStatus,
      [{ contractVersion: "readiness.v1", status: "ready" }, unavailable],
    ],
  ]) {
    const validate = new Ajv({ strict: true, ownProperties: true }).compile(
      schema,
    );
    for (const value of values) {
      assert.equal(wrapper(value), true);
      assert.equal(validate(value), true);
      for (const key of Object.keys(value)) {
        const missing = structuredClone(value);
        delete missing[key];
        assert.equal(validate(missing), false);
      }
      for (const key of [
        "hostname",
        "ip",
        "path",
        "environment",
        "configuration",
        "secretReference",
        "memory",
        "stack",
        "device",
        "metadata",
        "dependencies",
      ]) {
        assert.equal(
          wrapper({ ...value, [key]: "synthetic-private-marker" }),
          false,
        );
      }
      for (const invalid of [
        null,
        [],
        { ...value, status: "ollama-healthy" },
        { ...value, contractVersion: "unknown.v1" },
      ]) {
        assert.equal(wrapper(invalid), false);
      }
    }
  }
  for (const error of [
    { ...unavailable.error, code: "BUSY", message: publicErrorMessages.BUSY },
    { ...unavailable.error, message: "synthetic-private-message" },
    { ...unavailable.error, correlationId: "synthetic-private-id" },
    { ...unavailable.error, stack: "synthetic-private-stack" },
  ])
    assert.equal(isReadinessStatus({ ...unavailable, error }), false);
  assert.equal(isReadinessStatus({ ...unavailable, status: "ready" }), false);
});
