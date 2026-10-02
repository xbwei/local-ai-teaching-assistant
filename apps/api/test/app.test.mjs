import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  isPublicError,
  isHealthStatus,
  isReadinessStatus,
  healthStatus,
  isCapabilityAvailability,
} from "@laita/contracts";
import {
  createCapabilityEvaluator,
  createDemoCapabilityContext,
  defaultInstructorPolicy,
  instructorPolicyDigest,
  createInstructorPolicyService,
  successorInstructorPolicy,
} from "@laita/policy";
import { createApp as createApplication } from "../dist/app.js";
// Explicit in-process success seam; HTTP unit tests never initialize real paths.
const createApp = (options) =>
  createApplication({ persistence: { isReady: () => true }, ...options });
function isolatedRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), "teaching-api-test-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  });
  return root;
}
import {
  initializeRuntimePaths,
  createOperationalLogger,
  createWorkGate,
  defaultConfiguration,
} from "@laita/runtime";
import { initializePersistence } from "@laita/persistence";
// Assemble the synthetic URI from fixture parts without excluding any files
// from secret scanning. Cross-module fixtures remain data, not code imports.
const prohibited = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/contracts/test/fixtures/prohibited-values.json",
      import.meta.url,
    ),
    "utf8",
  ),
).map((value) => (Array.isArray(value) ? value.join("") : value));
const assertSafe = (value) => {
  for (const marker of prohibited) assert.equal(value.includes(marker), false);
};
const capture = () => {
  const lines = [];
  return { lines, logger: createOperationalLogger((line) => lines.push(line)) };
};

for (const entry of ["../dist/main.js", "../src/main.ts"]) {
  test(`invalid configuration stops ${entry} before a listener with bounded diagnostics`, () => {
    const result = spawnSync(
      process.execPath,
      [new URL(entry, import.meta.url).pathname],
      {
        env: {
          APP_CONFIG_JSON: JSON.stringify({
            "synthetic-private-field": "synthetic-secret-marker",
            unsafe: prohibited,
          }),
        },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const lines = result.stderr.trim().split("\n");
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.event, "API_STARTUP_FAILED");
    assert.equal(event.code, "INVALID_CONFIGURATION");
    assert.equal(event.operation, "API_STARTUP");
    assert.equal(event.level, "error");
    assert.equal(event.contractVersion, "operational-event.v1");
    assertSafe(result.stderr);
    assert.equal(result.stderr.includes("synthetic-private-field"), false);
    assert.equal(result.stderr.includes("synthetic-secret-marker"), false);
  });
}

test("explicit demo configuration binds loopback and requires its private proxy access contract", async (t) => {
  // Reserve an ephemeral test port, then release it for the test-owned process.
  const probe = createApp().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  const probeClosed = once(probe, "close");
  probe.close();
  await probeClosed;
  const configuration = JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/runtime/examples/openai-demo.example.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  configuration.server.port = port;
  configuration.runtimeRoot = isolatedRoot(t);
  const child = spawn(
    process.execPath,
    [new URL("../dist/main.js", import.meta.url).pathname],
    {
      env: { APP_CONFIG_JSON: JSON.stringify(configuration) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  try {
    for (
      let attempt = 0;
      attempt < 100 && !stdout.includes('"event":"API_STARTED"');
      attempt++
    ) {
      assert.equal(child.exitCode, null);
      await delay(50);
    }
    const started = JSON.parse(stdout.trim());
    assert.equal(started.event, "API_STARTED");
    assert.equal(started.code, "OK");
    assert.equal(started.operation, "API_STARTUP");
    const origin = `http://127.0.0.1:${port}`;
    const ready = await fetch(`${origin}/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), {
      contractVersion: "readiness.v1",
      status: "ready",
    });
    assert.equal(
      existsSync(
        path.join(configuration.runtimeRoot, "data", "foundation.sqlite"),
      ),
      true,
    );
    for (const route of [
      "configuration",
      "chat",
      "models",
      "compare",
      "speech",
      "kiosk",
    ]) {
      assert.equal(
        (
          await fetch(`${origin}/api/${route}`, {
            signal: AbortSignal.timeout(5000),
          })
        ).status,
        404,
      );
    }
    await delay(20);
    const failures = stderr.trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(failures.length, 6);
    assert.ok(
      failures.every(
        (event) =>
          event.code === "NOT_FOUND" && event.operation === "UNMATCHED",
      ),
    );
    assertSafe(stdout + stderr);
    assert.equal((stdout + stderr).includes(configuration.runtimeRoot), false);
  } finally {
    child.kill("SIGTERM");
    const result = await Promise.race([
      exited,
      delay(5000, "timeout", { ref: false }),
    ]);
    if (result === "timeout") {
      child.kill("SIGKILL");
      await exited;
    }
    assert.notEqual(result, "timeout");
  }
});

async function withApp(options, verify) {
  const captured = capture();
  const server = createApp({ ...options, logger: captured.logger }).listen(
    0,
    "127.0.0.1",
  );
  await once(server, "listening");
  try {
    await verify(
      `http://127.0.0.1:${server.address().port}`,
      captured.lines,
      server,
    );
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
}

test("client-safe capability endpoints expose approved choices without accepting policy inputs", async () => {
  const configuration = JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/runtime/examples/openai-demo.example.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  configuration.providers.openai.secretReference.id =
    "synthetic-secret-reference-marker";
  const evaluator = createCapabilityEvaluator(configuration);
  assert.ok(evaluator);
  const controls = {
    emergencyStop: false,
    local: {
      featureEnabled: true,
      scheduleOpen: true,
      withinBudget: true,
      quotaAvailable: true,
      state: "READY",
    },
    openai: {
      featureEnabled: true,
      scheduleOpen: true,
      withinBudget: true,
      quotaAvailable: true,
      state: "READY",
    },
  };
  const audiences = [];
  const capabilities = {
    read(audience) {
      audiences.push(audience);
      const accessClass =
        audience === "instructor"
          ? "INSTRUCTOR"
          : audience === "student"
            ? "STUDENT"
            : "ANONYMOUS_SESSION";
      return evaluator.availability(
        createDemoCapabilityContext(accessClass),
        controls,
      );
    },
  };
  const access = {
    authorize: () => ({ ok: true }),
    isReady: () => true,
    status: () => ({
      contractVersion: "access-status.v1",
      mode: "controlled-pilot",
      status: "enabled",
    }),
  };
  await withApp({ capabilities, access }, async (origin, lines) => {
    const instructor = await fetch(`${origin}/api/instructor/capabilities`, {
      headers: { "Content-Length": "0" },
    });
    assert.equal(instructor.status, 200);
    const body = await instructor.json();
    assert.equal(isCapabilityAvailability(body), true);
    assert.deepEqual(
      body.modes.map(({ id }) => id),
      ["LOCAL", "OPENAI", "COMPARE"],
    );
    const serialized = JSON.stringify(body);
    for (const marker of [
      "synthetic-secret-reference-marker",
      "secretReference",
      "withinBudget",
      "quotaAvailable",
      "allowRules",
    ])
      assert.equal(serialized.includes(marker), false);

    for (const path of [
      "/api/capabilities",
      "/api/kiosk/capabilities",
      "/api/provider-runs",
    ])
      assert.equal((await fetch(origin + path)).status, 404);

    for (const request of [
      fetch(`${origin}/api/instructor/capabilities?model=client-model`),
      fetch(
        `${origin}/api/instructor/capabilities?policyVersion=client-policy.v99`,
      ),
    ]) {
      const response = await request;
      assert.equal(response.status, 400);
      const error = await response.json();
      assert.equal(error.code, "INVALID_REQUEST");
    }
    assert.deepEqual(audiences, ["instructor"]);
    assert.ok(lines.every((line) => !line.includes("synthetic-secret")));
  });
});

test("invalid capability dependency output fails closed with a client-safe error", async () => {
  await withApp(
    {
      access: { authorize: () => ({ ok: true }), isReady: () => true },
      capabilities: { read: () => ({ unrestrictedModels: ["anything"] }) },
    },
    async (origin) => {
      const response = await fetch(`${origin}/api/instructor/capabilities`);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "SERVICE_UNAVAILABLE");
    },
  );
});

test("provider dependency output with private fields fails closed without logging them", async () => {
  const access = {
    authorize: () => ({ ok: true }),
    isReady: () => true,
    status: () => ({
      contractVersion: "access-status.v1",
      mode: "controlled-pilot",
      status: "enabled",
    }),
  };
  await withApp(
    {
      access,
      providerControls: {
        health: () => ({ credential: prohibited[0] }),
        execute: async () => ({ response: prohibited[1] }),
      },
    },
    async (origin, lines) => {
      assert.equal(
        (await fetch(`${origin}/api/instructor/provider-health`)).status,
        503,
      );
      assertSafe(lines.join(""));
    },
  );
});

test("provider-policy controls require instructor/admin auth and reject unsafe or stale writes atomically", async () => {
  let current = {
    contractVersion: "instructor-policy-state.v1",
    version: 1,
    digest: instructorPolicyDigest(defaultInstructorPolicy),
    activatedAt: "2026-09-04T12:00:00.000Z",
    policy: structuredClone(defaultInstructorPolicy),
  };
  const changes = [];
  const policyControls = {
    readState: () => ({ ok: true, value: current }),
    history: () => ({ ok: true, value: changes }),
    preview(expectedVersion, policy) {
      if (expectedVersion !== current.version)
        return { ok: false, code: "CONFLICT" };
      return {
        ok: true,
        value: {
          contractVersion: "instructor-policy-preview.v1",
          basedOnVersion: expectedVersion,
          policyDigest: instructorPolicyDigest(policy),
          scheduleOpen: true,
          capability: {
            contractVersion: "capability-availability.v1",
            decisionRef: "decision-" + "a".repeat(24),
            identity: createCapabilityEvaluator(
              JSON.parse(
                readFileSync(
                  new URL(
                    "../../../packages/runtime/examples/openai-demo.example.json",
                    import.meta.url,
                  ),
                  "utf8",
                ),
              ),
            ).identity,
            providers: [],
            modes: [],
            guidance: "NO_PROVIDER_AVAILABLE",
            recheckOn: [
              "INPUT_CHANGE",
              "ARTIFACT_CHANGE",
              "COURSE_OR_MODULE_CHANGE",
              "WORKFLOW_OR_MODE_CHANGE",
              "PROVIDER_OR_MODEL_CHANGE",
              "SCHEDULE_OR_FEATURE_CHANGE",
              "BUDGET_OR_QUOTA_CHANGE",
              "ASSESSMENT_STATE_CHANGE",
              "POLICY_VERSION_CHANGE",
              "PROVIDER_HEALTH_CHANGE",
            ],
          },
        },
      };
    },
    activate(expectedVersion, previewDigest, policy, actorRole) {
      if (expectedVersion !== current.version)
        return { ok: false, code: "CONFLICT" };
      if (previewDigest !== instructorPolicyDigest(policy))
        return { ok: false, code: "INVALID_POLICY" };
      current = {
        ...current,
        version: current.version + 1,
        digest: previewDigest,
        policy,
      };
      changes.push({ actorRole, change: "ACTIVATE" });
      return { ok: true, value: current };
    },
    emergencyDisable(expectedVersion, actorRole) {
      if (expectedVersion !== current.version)
        return { ok: false, code: "CONFLICT" };
      current = {
        ...current,
        version: current.version + 1,
        policy: { ...current.policy, emergencyCloudDisabled: true },
      };
      changes.push({ actorRole, change: "EMERGENCY_CLOUD_DISABLE" });
      return { ok: true, value: current };
    },
    rollback: () => ({ ok: false, code: "NOT_FOUND" }),
  };
  const access = {
    authorize(request, audience) {
      if (audience !== "control") return { ok: true };
      if (request.authorization === "Bearer synthetic-instructor")
        return { ok: true, actorRole: "INSTRUCTOR" };
      if (request.authorization === "Bearer synthetic-admin")
        return { ok: true, actorRole: "ADMIN" };
      return { ok: false, code: "FORBIDDEN", status: 403 };
    },
    isReady: () => true,
    status: () => ({
      contractVersion: "access-status.v1",
      mode: "controlled-pilot",
      status: "enabled",
    }),
  };
  await withApp({ access, policyControls }, async (origin) => {
    for (const token of ["synthetic-student", "synthetic-kiosk"]) {
      const response = await fetch(`${origin}/api/admin/provider-policy`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 403);
    }
    const policy = {
      ...structuredClone(defaultInstructorPolicy),
      cloudEnabled: true,
    };
    const mutation = {
      contractVersion: "instructor-policy-mutation.v1",
      expectedVersion: 1,
      previewDigest: instructorPolicyDigest(policy),
      policy,
    };
    const preview = await fetch(`${origin}/api/admin/provider-policy/preview`, {
      method: "POST",
      headers: {
        Authorization: "Bearer synthetic-instructor",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contractVersion: "instructor-policy-preview-request.v1",
        expectedVersion: 1,
        policy,
      }),
    });
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).policyDigest, mutation.previewDigest);
    const activated = await fetch(`${origin}/api/admin/provider-policy`, {
      method: "PUT",
      headers: {
        Authorization: "Bearer synthetic-instructor",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(mutation),
    });
    assert.equal(activated.status, 200);
    assert.equal((await activated.json()).version, 2);
    assert.deepEqual(changes, [
      { actorRole: "INSTRUCTOR", change: "ACTIVATE" },
    ]);
    const stale = await fetch(`${origin}/api/admin/provider-policy`, {
      method: "PUT",
      headers: {
        Authorization: "Bearer synthetic-admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(mutation),
    });
    assert.equal(stale.status, 409);
    assert.equal(current.version, 2);
    const unsafe = await fetch(`${origin}/api/admin/provider-policy`, {
      method: "PUT",
      headers: {
        Authorization: "Bearer synthetic-admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...mutation,
        expectedVersion: 2,
        credential: "synthetic-secret",
      }),
    });
    assert.equal(unsafe.status, 400);
    assert.equal(current.version, 2);
    const malformed = await fetch(
      `${origin}/api/admin/provider-policy/preview`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer synthetic-admin",
          "Content-Type": "application/json",
        },
        body: "{",
      },
    );
    assert.equal(malformed.status, 400);
  });
});

test("provider usage summary is control-protected, aggregate-only and fail-closed", async () => {
  const safeSummary = {
    contractVersion: "provider-usage-summary.v1",
    asOf: "2026-09-05T12:00:00.000Z",
    policyVersion: "provider-usage-policy.v1",
    costRepresentation: "ESTIMATE_NOT_PROVIDER_BILLING",
    providers: [
      {
        provider: "LOCAL",
        state: "AVAILABLE",
        dailyRequests: 1,
        weeklyTokens: 10,
        estimatedCostNanoUsd: null,
        completed: 1,
        failed: 0,
        cancelled: 0,
        timedOut: 0,
        missingUsage: 0,
        averageLatencyMs: 20,
        localMemoryPressure: {
          normal: 1,
          warning: 0,
          critical: 0,
          unavailable: 0,
        },
      },
      {
        provider: "OPENAI",
        state: "WARNING",
        dailyRequests: 2,
        weeklyTokens: 20,
        estimatedCostNanoUsd: 5_000,
        completed: 1,
        failed: 0,
        cancelled: 0,
        timedOut: 1,
        missingUsage: 1,
        averageLatencyMs: 30,
        localMemoryPressure: null,
      },
    ],
    comparison: {
      dailyRequests: 1,
      weeklyEstimatedCostNanoUsd: 2_000,
      state: "WARNING",
    },
  };
  const access = {
    authorize(request, audience) {
      if (audience !== "control") return { ok: true };
      if (
        request.authorization === "Bearer synthetic-instructor" ||
        request.authorization === "Bearer synthetic-admin"
      )
        return { ok: true, actorRole: "INSTRUCTOR" };
      return { ok: false, code: "FORBIDDEN", status: 403 };
    },
    isReady: () => true,
    status: () => ({
      contractVersion: "access-status.v1",
      mode: "controlled-pilot",
      status: "enabled",
    }),
  };
  await withApp(
    {
      access,
      usageControls: { summary: () => ({ ok: true, value: safeSummary }) },
    },
    async (origin) => {
      for (const role of ["student", "kiosk"]) {
        const denied = await fetch(
          `${origin}/api/admin/provider-usage/summary`,
          {
            headers: { Authorization: `Bearer synthetic-${role}` },
          },
        );
        assert.equal(denied.status, 403);
      }
      for (const role of ["instructor", "admin"]) {
        const allowed = await fetch(
          `${origin}/api/admin/provider-usage/summary`,
          { headers: { Authorization: `Bearer synthetic-${role}` } },
        );
        assert.equal(allowed.status, 200);
        assert.deepEqual(await allowed.json(), safeSummary);
      }
      assert.equal(
        (
          await fetch(
            `${origin}/api/admin/provider-usage/summary?account=private`,
            { headers: { Authorization: "Bearer synthetic-admin" } },
          )
        ).status,
        400,
      );
    },
  );

  await withApp(
    {
      access,
      usageControls: {
        summary: () => ({
          ok: true,
          value: { ...safeSummary, credential: "synthetic-private-marker" },
        }),
      },
    },
    async (origin, lines) => {
      const response = await fetch(
        `${origin}/api/admin/provider-usage/summary`,
        {
          headers: { Authorization: "Bearer synthetic-admin" },
        },
      );
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "SERVICE_UNAVAILABLE");
      assert.equal(
        lines.join("\n").includes("synthetic-private-marker"),
        false,
      );
    },
  );
});

test("unknown routes and unsupported requests use correlated safe JSON, ignoring input IDs/content", async () => {
  await withApp({}, async (origin, lines) => {
    const ids = new Set();
    for (const [method, path] of [
      [
        "GET",
        `/unknown-${encodeURIComponent(prohibited[0])}?prompt=${encodeURIComponent(prohibited.join(" "))}`,
      ],
      ["POST", "/api/scaffold"],
      ["GET", "/%E0%A4%A"],
    ]) {
      const response = await fetch(origin + path, {
        method,
        headers: {
          Authorization: prohibited[3],
          Cookie: prohibited[4],
          "X-Correlation-ID": prohibited.at(-1),
          "X-Request-ID": prohibited.at(-1),
        },
        ...(method === "POST" ? { body: prohibited.join(" ") } : {}),
      });
      assert.equal(response.status, 404);
      assert.match(response.headers.get("content-type"), /application\/json/);
      const body = await response.json();
      assert.equal(isPublicError(body), true);
      assert.equal(body.code, "NOT_FOUND");
      assert.equal(
        response.headers.get("x-correlation-id"),
        body.correlationId,
      );
      ids.add(body.correlationId);
      assertSafe(JSON.stringify(body));
      const event = JSON.parse(lines.at(-1));
      assert.equal(event.correlationId, body.correlationId);
      assert.equal(event.code, body.code);
      assert.equal(event.operation, "UNMATCHED");
    }
    assert.equal(ids.size, 3);
    assert.equal(lines.length, 3);
    assertSafe(lines.join(""));
  });
});

test("occupied port startup failure produces a bounded event without raw bind details", async (t) => {
  const server = createApp({ logger: capture().logger }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const configuration = JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/runtime/examples/local-only.example.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    configuration.server.port = server.address().port;
    configuration.runtimeRoot = isolatedRoot(t);
    const result = spawnSync(
      process.execPath,
      [new URL("../dist/main.js", import.meta.url).pathname],
      {
        env: { APP_CONFIG_JSON: JSON.stringify(configuration) },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const event = JSON.parse(result.stderr.trim());
    assert.equal(event.event, "API_STARTUP_FAILED");
    assert.equal(event.code, "SERVICE_UNAVAILABLE");
    for (const marker of [
      "EADDRINUSE",
      "127.0.0.1",
      "stack",
      "secretReference",
    ])
      assert.equal(result.stderr.includes(marker), false);
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
});

const requestWithPrivateMarkers = (origin, path) =>
  fetch(origin + path + "?prompt=" + encodeURIComponent(prohibited.join(" ")), {
    headers: {
      Authorization: prohibited[3],
      Cookie: prohibited[4],
      "X-Correlation-ID": prohibited.at(-1),
    },
    signal: AbortSignal.timeout(5000),
  });
const assertCorrelatedError = async (response, lines, code, status) => {
  assert.equal(response.status, status);
  const body = await response.json();
  const error = body.error ?? body;
  assert.equal(isPublicError(error), true);
  assert.equal(error.code, code);
  assert.equal(response.headers.get("x-correlation-id"), error.correlationId);
  const event = lines
    .map(JSON.parse)
    .find((event) => event.correlationId === error.correlationId);
  assert.equal(event.code, code);
  assertSafe(JSON.stringify(body) + lines.join(""));
  return body;
};

test("invalid runtime limits fail before bind with one safe startup event in source and built modes", () => {
  for (const entry of ["../dist/main.js", "../src/main.ts"]) {
    for (const runtime of [
      { maxConcurrentOperations: 0, operationTimeoutMs: 30000 },
      { maxConcurrentOperations: 5, operationTimeoutMs: 30000 },
      { maxConcurrentOperations: "1", operationTimeoutMs: 30000 },
      { maxConcurrentOperations: 1, operationTimeoutMs: 0 },
      { maxConcurrentOperations: 1, operationTimeoutMs: 120001 },
      { maxConcurrentOperations: 1, operationTimeoutMs: prohibited[0] },
    ]) {
      const configuration = { ...defaultConfiguration(), runtime };
      const result = spawnSync(
        process.execPath,
        [new URL(entry, import.meta.url).pathname],
        {
          env: { APP_CONFIG_JSON: JSON.stringify(configuration) },
          encoding: "utf8",
          timeout: 5000,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      const event = JSON.parse(result.stderr.trim());
      assert.equal(event.code, "INVALID_CONFIGURATION");
      assert.equal(event.event, "API_STARTUP_FAILED");
      assertSafe(result.stderr);
      for (const marker of [
        "runtime",
        "operationTimeoutMs",
        "maxConcurrentOperations",
        "stack",
        "127.0.0.1",
      ])
        assert.equal(result.stderr.includes(marker), false);
    }
  }
});

test("persistence readiness reflects initialization/closure without path or database details", async (t) => {
  const runtimeRoot = isolatedRoot(t);
  const paths = initializeRuntimePaths(runtimeRoot);
  assert.equal(paths.ok, true);
  const result = initializePersistence(paths.value);
  assert.equal(result.ok, true);
  try {
    await withApp({ persistence: result.value }, async (origin, lines) => {
      assert.equal((await fetch(origin + "/ready")).status, 200);
      assert.equal(result.value.close().ok, true);
      // No files remain to probe; health still succeeds and ready uses only state.
      rmSync(path.join(runtimeRoot, "data"), { recursive: true });
      const health = await fetch(origin + "/health");
      assert.deepEqual(await health.json(), healthStatus);
      const body = await assertCorrelatedError(
        await fetch(origin + "/ready"),
        lines,
        "SERVICE_UNAVAILABLE",
        503,
      );
      assert.equal(isReadinessStatus(body), true);

      const serialized = JSON.stringify(body) + lines.join("");
      for (const marker of [
        runtimeRoot,
        "foundation.sqlite",
        "schema_migrations",
        "SQLITE",
        "ENOENT",
      ])
        assert.equal(serialized.includes(marker), false);
    });
  } finally {
    result.value.close();
  }
  await withApp({ persistence: undefined }, async (origin, lines) => {
    await assertCorrelatedError(
      await fetch(origin + "/ready"),
      lines,
      "SERVICE_UNAVAILABLE",
      503,
    );
  });
});

test("health performs no persistence/readiness calls even when dependency access would throw", async () => {
  let calls = 0;
  await withApp(
    {
      persistence: {
        isReady() {
          calls++;
          throw new Error("synthetic-private-database-error");
        },
      },
    },
    async (origin) => {
      for (let count = 0; count < 3; count++) {
        const response = await fetch(origin + "/health");
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), healthStatus);
      }
      assert.equal(calls, 0);
    },
  );
});

for (const entry of ["../dist/main.js", "../src/main.ts"]) {
  test(`unsafe/uncreatable/unwritable roots and database failures stop ${entry} before listen with one safe outcome`, (t) => {
    const base = isolatedRoot(t);
    const file = path.join(base, "file");
    writeFileSync(file, "synthetic");
    const unwritable = path.join(base, "unwritable");
    mkdirSync(unwritable, { mode: 0o500 });
    t.after(() => {
      if (existsSync(unwritable)) chmodSync(unwritable, 0o700);
    });
    const databaseDirectory = path.join(base, "database-directory");
    assert.equal(initializeRuntimePaths(databaseDirectory).ok, true);
    mkdirSync(path.join(databaseDirectory, "data", "foundation.sqlite"));
    const invalidDatabase = path.join(base, "invalid-database");
    assert.equal(initializeRuntimePaths(invalidDatabase).ok, true);
    writeFileSync(
      path.join(invalidDatabase, "data", "foundation.sqlite"),
      "synthetic-private-SQLite-error",
      { mode: 0o600 },
    );
    for (const runtimeRoot of [
      new URL("../../../", import.meta.url).pathname,
      path.join(file, "runtime"),
      unwritable,
      databaseDirectory,
      invalidDatabase,
    ]) {
      const configuration = { ...defaultConfiguration(), runtimeRoot };
      const result = spawnSync(
        process.execPath,
        [new URL(entry, import.meta.url).pathname],
        {
          env: { APP_CONFIG_JSON: JSON.stringify(configuration) },
          encoding: "utf8",
          timeout: 5000,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      const lines = result.stderr.trim().split("\n");
      assert.equal(lines.length, 1);
      const event = JSON.parse(lines[0]);
      assert.equal(event.event, "API_STARTUP_FAILED");
      assert.equal(event.code, "SERVICE_UNAVAILABLE");
      assertSafe(result.stderr);
      for (const marker of [
        runtimeRoot,
        "foundation.sqlite",
        "SQLITE",
        "EACCES",
        "ENOENT",
        "stack",
        "synthetic-private",
      ])
        assert.equal(result.stderr.includes(marker), false);
    }
    chmodSync(unwritable, 0o700);
  });
}

test("successor policy crosses real preview, activation, SQLite reopen, history and rollback boundaries", async (t) => {
  const paths = initializeRuntimePaths(isolatedRoot(t));
  assert.equal(paths.ok, true);
  let persistence = initializePersistence(paths.value);
  assert.equal(persistence.ok, true);
  t.after(() => persistence.value.close());
  const configuration = JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/runtime/examples/openai-demo.example.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  configuration.provenance = {
    demoProfileVersion: "demo-profile.v4",
    policyVersion: "demo-policy.v4",
  };
  const evaluator = createCapabilityEvaluator(configuration);
  assert.ok(evaluator);
  const makeService = () =>
    createInstructorPolicyService(
      persistence.value.policyState(defaultInstructorPolicy),
      evaluator,
      () => new Date("2026-09-04T12:00:00Z"),
    );
  let policyControls = makeService();
  const initial = policyControls.readState().value;
  assert.deepEqual(initial.policy, defaultInstructorPolicy);
  const access = {
    authorize: () => ({ ok: true, actorRole: "INSTRUCTOR" }),
    isReady: () => true,
  };
  const policy = structuredClone(successorInstructorPolicy);
  await withApp({ access, policyControls }, async (origin) => {
    const send = async (suffix, method, body) => {
      const response = await fetch(
        `${origin}/api/admin/provider-policy${suffix}`,
        {
          method,
          headers: { "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      return { status: response.status, body: await response.json() };
    };
    // protected GET response, never replace stored controls with demo defaults.
    const current = await send("", "GET");
    assert.equal(current.status, 200);
    assert.equal(current.body.version, 1);
    const minimum = structuredClone(current.body.policy);
    minimum.eligibility.dataClasses.push("IDENTITY_MINIMIZED_USER_TEXT");
    assert.deepEqual(minimum, policy);
    const previewRequest = {
      contractVersion: "instructor-policy-preview-request.v1",
      expectedVersion: current.body.version,
      policy: minimum,
    };
    assert.equal(
      (
        await send("/preview", "POST", {
          ...previewRequest,
          expectedVersion: 2,
        })
      ).status,
      409,
    );
    const preview = await send("/preview", "POST", previewRequest);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.basedOnVersion, 1);
    assert.equal(preview.body.policyDigest, instructorPolicyDigest(policy));
    assert.deepEqual(policyControls.readState().value, initial);
    assert.deepEqual(policyControls.history().value, []);
    const mutation = {
      contractVersion: "instructor-policy-mutation.v1",
      expectedVersion: 1,
      previewDigest: preview.body.policyDigest,
      policy,
    };
    assert.equal(
      (
        await send("", "PUT", {
          ...mutation,
          previewDigest: "sha256:" + "0".repeat(64),
        })
      ).status,
      400,
    );
    assert.equal(
      (await send("", "PUT", { ...mutation, expectedVersion: 2 })).status,
      409,
    );
    assert.deepEqual(policyControls.readState().value, initial);
    for (const unsafe of [
      {
        ...policy,
        comparison: {
          ...policy.comparison,
          dataClass: "IDENTITY_MINIMIZED_USER_TEXT",
        },
      },
      {
        ...policy,
        eligibility: {
          ...policy.eligibility,
          dataClasses: ["PRIVACY_SENSITIVE_STUDENT_CONTENT"],
        },
      },
      { ...policy, models: { ...policy.models, activeLocal: "unapproved" } },
    ]) {
      assert.equal(
        (await send("/preview", "POST", { ...previewRequest, policy: unsafe }))
          .status,
        400,
      );
      assert.equal(
        (await send("", "PUT", { ...mutation, policy: unsafe })).status,
        400,
      );
    }
    const activated = await send("", "PUT", mutation);
    assert.equal(activated.status, 200);
    assert.equal(activated.body.version, 2);
    assert.deepEqual(activated.body.policy, successorInstructorPolicy);
    assert.equal((await send("", "PUT", mutation)).status, 409);
    assert.equal((await send("/preview", "POST", previewRequest)).status, 409);
    assert.equal(policyControls.history().value.length, 1);
  });
  persistence.value.close();
  persistence = initializePersistence(paths.value);
  assert.equal(persistence.ok, true);
  policyControls = makeService();
  const reread = policyControls.readState();
  assert.equal(reread.ok, true);
  assert.equal(reread.value.version, 2);
  assert.deepEqual(reread.value.policy, policy);
  assert.equal(reread.value.digest, instructorPolicyDigest(policy));
  const context = {
    ...createDemoCapabilityContext("INSTRUCTOR"),
    dataClass: "IDENTITY_MINIMIZED_USER_TEXT",
  };
  assert.deepEqual(
    policyControls.capability(context).value.modes.map((m) => m.id),
    ["LOCAL"],
  );
  await withApp({ access, policyControls }, async (origin) => {
    const rollback = async (expectedVersion) =>
      fetch(`${origin}/api/admin/provider-policy/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractVersion: "instructor-policy-rollback.v1",
          expectedVersion,
        }),
      });
    assert.equal((await rollback(3)).status, 409);
    const response = await rollback(2);
    assert.equal(response.status, 200);
    const reverted = await response.json();
    assert.equal(reverted.version, 3);
    assert.deepEqual(reverted.policy, defaultInstructorPolicy);
    assert.equal(reverted.digest, initial.digest);
  });
  persistence.value.close();
  persistence = initializePersistence(paths.value);
  assert.equal(persistence.ok, true);
  policyControls = makeService();
  assert.deepEqual(
    policyControls.readState().value.policy,
    defaultInstructorPolicy,
  );
  assert.deepEqual(policyControls.capability(context).value.providers, []);
  assert.deepEqual(
    policyControls
      .history()
      .value.map(({ version, previousVersion, change, policyDigest }) => ({
        version,
        previousVersion,
        change,
        policyDigest,
      })),
    [
      {
        version: 3,
        previousVersion: 2,
        change: "ROLLBACK",
        policyDigest: initial.digest,
      },
      {
        version: 2,
        previousVersion: 1,
        change: "ACTIVATE",
        policyDigest: instructorPolicyDigest(policy),
      },
    ],
  );
});

test("control results reject inherited fields and accessors without executing getters", async (t) => {
  let getterCalls = 0;
  const hostile = () => {
    getterCalls++;
    throw new Error("Synthetic getter must not run");
  };
  const cases = [
    Object.create({ ok: true, value: { private: "synthetic" } }),
    Object.defineProperty({}, "ok", { get: hostile }),
    Object.create({ code: "CONFLICT" }),
    Object.defineProperty({}, "code", { get: hostile }),
  ];
  const access = {
    authorize: () => ({ ok: true, actorRole: "ADMIN" }),
    isReady: () => true,
  };
  for (const result of cases) {
    const app = createApp({
      access,
      logger: capture().logger,
      policyControls: { readState: () => result },
      usageControls: { summary: () => result },
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      for (const route of ["provider-policy", "provider-usage/summary"]) {
        const response = await fetch(
          `http://127.0.0.1:${server.address().port}/api/admin/${route}`,
        );
        assert.equal(response.status, 503);
        assert.equal((await response.json()).code, "SERVICE_UNAVAILABLE");
      }
    } finally {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  }
  const app = createApp({
    access,
    logger: capture().logger,
    usageControls: {
      summary: () =>
        Object.defineProperty({ ok: true }, "value", { get: hostile }),
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${server.address().port}/api/admin/provider-usage/summary`,
        )
      ).status,
      503,
    );
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
  assert.equal(getterCalls, 0);
});
