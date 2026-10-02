import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isPublicError, publicErrorMessages } from "@laita/contracts";
import {
  createCorrelationId,
  createPublicError,
  mapUnexpectedFailure,
  safeOperationalEvent,
  createOperationalLogger,
} from "@laita/runtime";
// Assemble the synthetic URI from fixture parts without excluding any files
// from secret scanning. Cross-module fixtures remain data, not code imports.
const prohibited = JSON.parse(
  readFileSync(
    new URL(
      "../../contracts/test/fixtures/prohibited-values.json",
      import.meta.url,
    ),
    "utf8",
  ),
).map((value) => (Array.isArray(value) ? value.join("") : value));
const event = () => ({
  operation: "SCAFFOLD",
  code: "OK",
  correlationId: createCorrelationId(),
});
const assertSafe = (value) => {
  for (const marker of prohibited) assert.equal(value.includes(marker), false);
};

test("generated UUIDv4 IDs are fresh and public errors never read unexpected failures", () => {
  const ids = new Set(Array.from({ length: 100 }, createCorrelationId));
  assert.equal(ids.size, 100);
  for (const id of ids)
    assert.equal(
      isPublicError(createPublicError("INTERNAL_FAILURE", id)),
      true,
    );
  const trapped = new Proxy(
    {},
    {
      get() {
        throw new Error(prohibited[0]);
      },
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const failure of [
    ...prohibited,
    new Error(prohibited.join(" ")),
    trapped,
    revoked.proxy,
    null,
    undefined,
    12n,
    Symbol("synthetic"),
  ]) {
    const id = createCorrelationId();
    const value = mapUnexpectedFailure(failure, id);
    assert.equal(isPublicError(value), true);
    assert.equal(value.correlationId, id);
    assert.equal(value.code, "INTERNAL_FAILURE");
    assertSafe(JSON.stringify(value));
  }
  for (const code of Object.keys(publicErrorMessages))
    assert.equal(
      isPublicError(createPublicError(code, createCorrelationId())),
      true,
    );
  const defensive = createPublicError(trapped, trapped);
  assert.equal(defensive.code, "INTERNAL_FAILURE");
  assert.equal(isPublicError(defensive), true);
});

test("allowlist drops unknown fields without invoking getters/toJSON or traversing cycles", () => {
  const lines = [];
  const logger = createOperationalLogger((line, level) => {
    lines.push({ line, level });
  });
  const input = {
    ...event(),
    headers: prohibited,
    body: prohibited,
    response: prohibited,
    error: new Error(prohibited[0]),
    timestamp: prohibited[0],
    level: prohibited[1],
  };
  input.self = input;
  input.toJSON = () => {
    throw new Error("must not serialize input");
  };
  Object.defineProperty(input, "secretReference", {
    get() {
      throw new Error("must not read unknown property");
    },
  });
  assert.equal(logger.write(input), true);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, "info");
  const result = JSON.parse(lines[0].line);
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      "contractVersion",
      "timestamp",
      "level",
      "event",
      "operation",
      "code",
      "correlationId",
    ].sort(),
  );
  assert.equal(result.correlationId, input.correlationId);
  assert.equal(result.event, "HTTP_RESULT");
  assert.match(
    result.timestamp,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  );
  assert.ok(lines[0].line.length < 400);
  assertSafe(lines[0].line);
});

test("unsafe values in allowlisted fields, accessors and proxies fail closed without coercion", () => {
  let count = 0;
  const logger = createOperationalLogger(() => {
    count++;
  });
  for (const key of ["operation", "code", "correlationId"]) {
    for (const value of [
      ...prohibited.slice(0, -1),
      null,
      undefined,
      {},
      [],
      true,
      1,
      2n,
    ]) {
      assert.equal(logger.write({ ...event(), [key]: value }), false);
    }
    const input = event();
    Object.defineProperty(input, key, {
      get() {
        throw new Error(prohibited[0]);
      },
    });
    assert.equal(logger.write(input), false);
  }
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  for (const input of [
    null,
    [],
    undefined,
    new Error(prohibited[0]),
    Object.create(event()),
    revocable.proxy,
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error(prohibited[0]);
        },
      },
    ),
  ]) {
    assert.equal(safeOperationalEvent(input), null);
  }
  assert.equal(count, 0);
});

test("operation/outcome combinations are closed and severity is derived", () => {
  const allowed = {
    API_STARTUP: [
      "OK",
      "INVALID_CONFIGURATION",
      "SERVICE_UNAVAILABLE",
      "INTERNAL_FAILURE",
    ],
    SCAFFOLD: [
      "OK",
      "INVALID_REQUEST",
      "UNAUTHENTICATED",
      "FORBIDDEN",
      "ACCESS_DISABLED",
      "MAINTENANCE",
      "RATE_LIMITED",
      "INTERNAL_FAILURE",
      "BUSY",
      "OPERATION_TIMEOUT",
      "CANCELLED",
      "SERVICE_UNAVAILABLE",
    ],
    HEALTH: ["OK", "INTERNAL_FAILURE"],
    READINESS: ["OK", "SERVICE_UNAVAILABLE", "INTERNAL_FAILURE"],
    KIOSK_ACCESS: [
      "OK",
      "UNAUTHENTICATED",
      "FORBIDDEN",
      "ACCESS_DISABLED",
      "MAINTENANCE",
      "RATE_LIMITED",
      "NOT_FOUND",
      "INTERNAL_FAILURE",
    ],
    INSTRUCTOR_ACCESS: [
      "OK",
      "UNAUTHENTICATED",
      "FORBIDDEN",
      "ACCESS_DISABLED",
      "MAINTENANCE",
      "RATE_LIMITED",
      "NOT_FOUND",
      "INTERNAL_FAILURE",
    ],
    ADMIN_ACCESS: [
      "OK",
      "UNAUTHENTICATED",
      "FORBIDDEN",
      "ACCESS_DISABLED",
      "MAINTENANCE",
      "RATE_LIMITED",
      "NOT_FOUND",
      "INTERNAL_FAILURE",
    ],
    UNMATCHED: ["NOT_FOUND", "INTERNAL_FAILURE"],
  };
  for (const [operation, codes] of Object.entries(allowed)) {
    for (const code of [
      "OK",
      "CANCELLED",
      ...Object.keys(publicErrorMessages),
    ]) {
      const result = safeOperationalEvent({ ...event(), operation, code });
      assert.equal(result !== null, codes.includes(code));
      if (result)
        assert.equal(
          result.level,
          code === "OK"
            ? "info"
            : [
                  "NOT_FOUND",
                  "INVALID_REQUEST",
                  "UNAUTHENTICATED",
                  "FORBIDDEN",
                  "RATE_LIMITED",
                  "BUSY",
                  "CANCELLED",
                ].includes(code)
              ? "warn"
              : "error",
        );
    }
  }
});

test("a failing sink is not retried or exposed as raw logging output", () => {
  let count = 0;
  const logger = createOperationalLogger(() => {
    count++;
    throw new Error(prohibited[0]);
  });
  assert.equal(logger.write(event()), false);
  assert.equal(count, 1);
});
