import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createProviderHealthController } from "@laita/orchestration";
import { OllamaLocalAdapter } from "@laita/providers";
import {
  createCapabilityEvaluator,
  createDemoCapabilityContext,
} from "@laita/policy";
import { createLocalHealthRefresh } from "../dist/local-health.js";
import { createApp } from "../dist/app.js";

const models = ["gemma4:12b-mlx", "llama3.1:8b"];
const cloud = "gpt-5.6-luna";
const digest = `sha256:${"a".repeat(64)}`;
const available = () => ({
  provider: "LOCAL",
  runtime: "OLLAMA",
  selectedModel: models[0],
  state: "UNLOADED",
  models: models.map((model) => ({
    model,
    installed: true,
    digest,
    residency: "UNLOADED",
  })),
  residentModels: 0,
  residentApprovedModels: 0,
  onePrimaryResidencySafe: true,
});
function fixture(inspect, extra = {}) {
  let time = 0,
    held = false,
    probes = 0;
  const health = createProviderHealthController({
    localModels: models,
    openaiModels: [cloud],
    selectedLocalModel: models[0],
    selectedOpenAIModel: cloud,
  });
  const acquire = () => {
    if (held) return;
    held = true;
    return () => {
      held = false;
    };
  };
  const refresh = createLocalHealthRefresh({
    health,
    acquire,
    enabled: true,
    timeoutMs: 100,
    adapter: {
      async inspectAvailability(...args) {
        probes++;
        return inspect(...args);
      },
    },
    now: () => time,
    ...extra,
  });
  return {
    health,
    refresh,
    acquire,
    advance: () => {
      time += 5000;
    },
    probes: () => probes,
  };
}
const statuses = (f) =>
  f.health.snapshot().providers[0].models.map((m) => m.status);

async function listener(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("startup outage recovers through async capability and choices routes using read-only inventories", async (t) => {
  let healthy = false;
  const requests = [];
  const endpoint = await listener(
    t,
    http.createServer((req, res) => {
      requests.push([req.method, req.url]);
      res.setHeader("content-type", "application/json");
      res.statusCode = healthy ? 200 : 503;
      res.end(
        JSON.stringify({
          models:
            req.url === "/api/tags"
              ? models.map((model) => ({ model, digest: "a".repeat(64) }))
              : [],
        }),
      );
    }),
  );
  const adapter = new OllamaLocalAdapter({
    endpoint,
    configuration: { reference: "synthetic", version: "config.v1", digest },
    selectedModel: models[0],
    candidates: models.map((model) => ({
      model,
      contextTokens: 4096,
      maxInputBytes: 32768,
      maxOutputTokens: 512,
      maxOutputBytes: 32768,
      keepAliveSeconds: 60,
    })),
  });
  const f = fixture((...args) => adapter.inspectAvailability(...args));
  await f.refresh(); // Production startup uses this same refresh instance.
  assert.deepEqual(statuses(f), ["UNAVAILABLE", "UNAVAILABLE"]);
  f.health.setStatus("OPENAI", cloud, "READY");
  const configuration = JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/runtime/examples/openai-demo.example.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const evaluator = createCapabilityEvaluator(configuration);
  const read = async () => {
    await f.refresh();
    return evaluator.availability(createDemoCapabilityContext("INSTRUCTOR"), {
      emergencyStop: false,
      ...f.health.capabilityControls(),
    });
  };
  const app = createApp({
    persistence: { isReady: () => true },
    browserAccess: {
      enabled: true,
      maintenanceMode: false,
      mode: "single-operator",
      publicOrigin: "https://owner.example.invalid",
    },
    access: {
      authorize: () => ({ ok: true, actorRole: "INSTRUCTOR" }),
      isReady: () => true,
      binding: () => ({
        courseScopes: ["course-synthetic-demo"],
        expires: Date.now() + 60000,
      }),
    },
    capabilities: { read },
    input: {
      speech: {
        status: () => "READY",
        identity: "synthetic-stt",
        ttsStatus: () => "DISABLED",
        ttsIdentity: "NOT_CONFIGURED",
        releaseOwner: () => true,
        close() {},
      },
      acquire: f.acquire,
      capabilities: read,
      execute: () => {
        throw new Error("No inference authorized");
      },
    },
  });
  const origin = await listener(t, http.createServer(app));
  t.after(() => app.locals.closeInput?.());
  const cap = async () => {
    const res = await fetch(origin + "/api/instructor/capabilities");
    assert.equal(res.status, 200);
    return res.json();
  };
  assert.deepEqual(
    (await cap()).modes.map((m) => m.id),
    ["OPENAI"],
  );
  healthy = true;
  assert.deepEqual(
    (await cap()).modes.map((m) => m.id),
    ["OPENAI"],
  );
  f.advance();
  const sessionResponse = await fetch(origin + "/api/v1/input/sessions", {
    method: "POST",
    headers: {
      "x-owner-client": "a".repeat(64),
      origin: "https://owner.example.invalid",
      "x-forwarded-host": "owner.example.invalid",
      "x-forwarded-proto": "https",
    },
  });
  assert.equal(sessionResponse.status, 200);
  const { sessionRef } = await sessionResponse.json();
  const choices = async () => {
    const res = await fetch(origin + "/api/v1/input/choices", {
      method: "POST",
      headers: {
        "x-input-session": sessionRef,
        "x-owner-client": "a".repeat(64),
        origin: "https://owner.example.invalid",
        "x-forwarded-host": "owner.example.invalid",
        "x-forwarded-proto": "https",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "Explain a tree." }),
    });
    assert.equal(res.status, 200);
    return (await res.json()).providers;
  };
  assert.deepEqual(
    (await choices()).modes.map((m) => m.id),
    ["LOCAL", "OPENAI", "COMPARE"],
  );
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => (i % 2 ? choices() : cap())),
  );
  assert.equal(f.probes(), 2);
  assert.equal(requests.length, 4);
  assert.ok(
    requests.every(
      ([method, url]) =>
        method === "GET" && ["/api/tags", "/api/ps"].includes(url),
    ),
  );
  healthy = false;
  f.advance();
  assert.deepEqual(
    (await cap()).modes.map((m) => m.id),
    ["OPENAI"],
  );
  assert.deepEqual(statuses(f), ["UNAVAILABLE", "UNAVAILABLE"]);
});

test("concurrent reads share one probe and lock, with cooldown after success and throw", async () => {
  let resolve;
  const f = fixture(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const first = f.refresh();
  assert.equal(f.acquire(), undefined);
  const batch = Array.from({ length: 100 }, () => f.refresh());
  assert.ok(batch.every((p) => p === first));
  resolve(available());
  await Promise.all(batch);
  assert.equal(f.probes(), 1);
  await f.refresh();
  assert.equal(f.probes(), 1);
  const release = f.acquire();
  assert.ok(release);
  release();
  const failed = fixture(() => {
    throw new Error("private provider detail");
  });
  await failed.refresh();
  await failed.refresh();
  assert.equal(failed.probes(), 1);
  assert.deepEqual(statuses(failed), ["UNAVAILABLE", "UNAVAILABLE"]);
  failed.advance();
  await failed.refresh();
  assert.equal(failed.probes(), 2);
});

test("refresh preserves busy, switching, disabled, quota and circuit controls and discards stale observations", async () => {
  for (const status of [
    "BUSY",
    "SWITCHING",
    "RECOVERING",
    "DISABLED",
    "OVER_QUOTA",
    "PROVIDER_FAILURE",
  ]) {
    const f = fixture(available);
    f.health.setStatus("LOCAL", models[0], status);
    await f.refresh();
    assert.equal(f.probes(), 0);
    assert.equal(statuses(f)[0], status);
  }
  const f = fixture(available);
  const release = f.acquire();
  await f.refresh();
  assert.equal(f.probes(), 0);
  release();
  await f.refresh();
  assert.deepEqual(statuses(f), ["READY", "READY"]);
  let resolve;
  const stale = fixture(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = stale.refresh();
  stale.health.setStatus("LOCAL", models[0], "SWITCHING");
  resolve(available());
  await pending;
  assert.deepEqual(statuses(stale), ["SWITCHING", "UNAVAILABLE"]);
});

test("unknown, malformed identity, missing models and unsafe residency never become READY", async () => {
  for (const change of [
    { state: "UNKNOWN" },
    { state: "UNAVAILABLE" },
    { state: "BUSY" },
    { state: "SWITCHING" },
    { onePrimaryResidencySafe: false },
    { selectedModel: "unapproved" },
    { error: { code: "UNAVAILABLE" } },
    { models: [] },
    { models: available().models.map((m) => ({ ...m, digest: undefined })) },
    { models: available().models.map((m) => ({ ...m, digest: "invalid" })) },
    { models: available().models.map((m) => ({ ...m, installed: false })) },
    { models: available().models.map((m) => ({ ...m, residency: "UNKNOWN" })) },
  ]) {
    const f = fixture(() => ({ ...available(), ...change }));
    await f.refresh();
    assert.deepEqual(statuses(f), ["UNAVAILABLE", "UNAVAILABLE"]);
  }
  const disabled = fixture(available, { enabled: false });
  await disabled.refresh();
  assert.equal(disabled.probes(), 0);
});

test("hung inventory transport times out, remains unavailable and releases the work lock", async (t) => {
  const endpoint = await listener(
    t,
    http.createServer(() => {}),
  );
  const adapter = new OllamaLocalAdapter({
    endpoint,
    configuration: { reference: "synthetic", version: "config.v1", digest },
    selectedModel: models[0],
    candidates: models.map((model) => ({
      model,
      contextTokens: 4096,
      maxInputBytes: 32768,
      maxOutputTokens: 512,
      maxOutputBytes: 32768,
      keepAliveSeconds: 60,
    })),
  });
  const f = fixture((...args) => adapter.inspectAvailability(...args), {
    timeoutMs: 20,
  });
  await f.refresh();
  assert.deepEqual(statuses(f), ["UNAVAILABLE", "UNAVAILABLE"]);
  const release = f.acquire();
  assert.ok(release);
  release();
  await f.refresh();
  assert.equal(f.probes(), 1);
});

test("installed Llama remains selectable when the default Gemma is absent", async () => {
  const f = fixture(() => ({
    ...available(),
    state: "UNAVAILABLE",
    models: available().models.map((m, i) =>
      i === 0
        ? {
            ...m,
            installed: false,
            digest: undefined,
            residency: "UNAVAILABLE",
          }
        : m,
    ),
  }));
  await f.refresh();
  assert.deepEqual(statuses(f), ["UNAVAILABLE", "READY"]);
});
