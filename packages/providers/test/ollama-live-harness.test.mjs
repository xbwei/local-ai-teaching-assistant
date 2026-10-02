import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { OllamaConfigurationError } from "../dist/index.js";
import {
  OLLAMA_LIVE_APPROVED_MODELS,
  runOllamaLiveHarness,
} from "../dist/ollama-live-harness.js";

const primary = "gemma4:12b-mlx";
const comparison = "llama3.1:8b";
const digests = new Map([
  [primary, "a".repeat(64)],
  [comparison, "b".repeat(64)],
]);

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function chat(model, content = "READY") {
  return {
    model,
    message: { role: "assistant", content },
    done: true,
    done_reason: "stop",
    total_duration: 20_000_000,
    load_duration: 5_000_000,
    prompt_eval_count: 8,
    eval_count: 1,
  };
}

async function mockOllama(t, scenario = "SUCCESS") {
  const state = {
    scenario,
    requests: 0,
    chatRequests: 0,
    running: new Set(),
    models: new Set([primary, comparison]),
    requestedModels: new Set(),
    prompts: [],
  };
  const server = http.createServer(async (incoming, response) => {
    state.requests += 1;
    const url = new URL(incoming.url, "http://127.0.0.1");
    if (incoming.method === "GET" && url.pathname === "/api/version") {
      return json(
        response,
        200,
        state.scenario === "MALFORMED_VERSION"
          ? { version: "private value with spaces" }
          : { version: "0.99.0-test" },
      );
    }
    if (incoming.method === "GET" && url.pathname === "/api/tags") {
      return json(response, 200, {
        models: [...state.models].map((model) => ({
          model,
          digest: digests.get(model),
          size: model === primary ? 7_000_000_000 : 5_000_000_000,
        })),
      });
    }
    if (incoming.method === "GET" && url.pathname === "/api/ps") {
      return json(response, 200, {
        models: [...state.running].map((model) => ({
          model,
          digest: digests.get(model),
          size: 4_000_000_000,
          size_vram: 3_000_000_000,
          context_length: 4096,
        })),
      });
    }
    if (incoming.method === "POST" && url.pathname === "/api/generate") {
      const payload = await body(incoming);
      state.requestedModels.add(payload.model);
      if (payload.keep_alive === 0) state.running.delete(payload.model);
      else state.running.add(payload.model);
      return json(response, 200, { model: payload.model, done: true });
    }
    if (incoming.method !== "POST" || url.pathname !== "/api/chat") {
      return json(response, 404, { error: "not found" });
    }
    state.chatRequests += 1;
    const chatNumber = state.chatRequests;
    const payload = await body(incoming);
    state.requestedModels.add(payload.model);
    state.prompts.push(payload.messages);
    state.running.clear();
    state.running.add(payload.model);
    if (state.scenario === "MALFORMED_RESPONSE" && chatNumber === 1) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end("{malformed");
    }
    if (!payload.stream) {
      if (chatNumber === 5) {
        return setTimeout(() => {
          if (!response.destroyed) json(response, 200, chat(payload.model));
        }, 60);
      }
      return json(response, 200, chat(payload.model));
    }
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write(
      `${JSON.stringify({
        model: payload.model,
        message: { role: "assistant", content: "REA" },
        done: false,
      })}\n`,
    );
    if (chatNumber === 4 || chatNumber === 8) {
      return setTimeout(() => {
        if (!response.destroyed) {
          response.end(`${JSON.stringify(chat(payload.model, "DY"))}\n`);
        }
      }, 60);
    }
    return response.end(`${JSON.stringify(chat(payload.model, "DY"))}\n`);
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { state, endpoint: `http://127.0.0.1:${address.port}` };
}

function resources() {
  return {
    status: "MEASURED",
    memoryAvailablePercent: 75,
    swapUsedBytes: 1024,
    ollamaProcessMemoryBytes: 2048,
    hostname: "must-not-escape",
    privatePath: "/must/not/escape",
  };
}

test("live harness closes the active model set to MLX primary and comparison", () => {
  assert.deepEqual(OLLAMA_LIVE_APPROVED_MODELS, [primary, comparison]);
  assert.equal(OLLAMA_LIVE_APPROVED_MODELS.includes("gemma4:12b"), false);
});

test("live harness is opt-in and performs no transport work when unconfirmed", async () => {
  let samples = 0;
  const evidence = await runOllamaLiveHarness({
    confirmed: false,
    endpoint: "https://example.com",
    sampleResources: () => {
      samples += 1;
      return resources();
    },
  });
  assert.equal(evidence.status, "NOT_RUN");
  assert.equal(samples, 0);
  assert.equal(evidence.cleanup.status, "NOT_RUN");
});

test("live harness rejects every non-loopback or credential-bearing endpoint", async () => {
  for (const endpoint of [
    "https://example.com",
    "http://192.168.1.2:11434",
    "http://10.0.0.2:11434",
    "http://user@127.0.0.1:11434",
    "http://127.0.0.1:11434/api",
  ]) {
    await assert.rejects(
      runOllamaLiveHarness({ confirmed: true, endpoint }),
      OllamaConfigurationError,
    );
  }
});

test("CLI rejects arbitrary model arguments before any live run", () => {
  const result = spawnSync(
    process.execPath,
    [
      new URL("../dist/ollama-live-cli.js", import.meta.url).pathname,
      "--confirm-live",
      "--model=arbitrary:latest",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /rejected unknown arguments/);
  assert.equal(result.stdout, "");
});

test("approved models complete bounded live sequence with provenance and cleanup", async (t) => {
  const mock = await mockOllama(t);
  const evidence = await runOllamaLiveHarness({
    confirmed: true,
    endpoint: mock.endpoint,
    operationTimeoutMs: 1000,
    controlTimeoutMs: 1000,
    timeoutProbeMs: 10,
    sampleResources: resources,
  });
  assert.equal(evidence.status, "PASS", JSON.stringify(evidence));
  assert.equal(evidence.runtime.version, "0.99.0-test");
  assert.deepEqual(
    [...mock.state.requestedModels].sort(),
    [...OLLAMA_LIVE_APPROVED_MODELS].sort(),
  );
  assert.equal(mock.state.running.size, 0);
  assert.equal(evidence.cleanup.status, "PASS");
  assert.equal(evidence.cleanup.residentModelCount, 0);

  const byName = new Map(evidence.tests.map((entry) => [entry.test, entry]));
  assert.equal(byName.get("primary-cold-non-stream").loadState, "COLD");
  assert.equal(byName.get("primary-warm-non-stream").loadState, "WARM");
  assert.equal(byName.get("primary-stream").status, "PASS");
  assert.ok(byName.get("primary-stream").deltaCount >= 1);
  assert.equal(byName.get("primary-cancellation").outcome, "CANCELLED");
  assert.equal(byName.get("primary-timeout").outcome, "TIMEOUT");
  assert.deepEqual(byName.get("switch-primary-to-comparison").transitions, [
    "SWITCHING",
    "UNLOADED",
    "LOADING",
    "WARM",
  ]);
  assert.equal(byName.get("comparison-non-stream").actualModel, comparison);
  assert.equal(
    byName.get("switch-comparison-to-primary").selectedModel,
    primary,
  );
  assert.match(byName.get("primary-cold-non-stream").digest, /^sha256:a{64}$/);

  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(
    serialized,
    /Reply with|READY|must-not-escape|must\/not|hostname|privatePath|example\.com/,
  );
  assert.equal(serialized.includes(mock.endpoint), false);
});

test("malformed provider response fails closed and still unloads", async (t) => {
  const mock = await mockOllama(t, "MALFORMED_RESPONSE");
  const evidence = await runOllamaLiveHarness({
    confirmed: true,
    endpoint: mock.endpoint,
    operationTimeoutMs: 1000,
    controlTimeoutMs: 1000,
    sampleResources: resources,
  });
  assert.equal(evidence.status, "FAIL");
  assert.equal(
    evidence.tests.find((entry) => entry.test === "primary-cold-non-stream")
      .outcome,
    "MALFORMED_PROVIDER_RESPONSE",
  );
  assert.equal(evidence.cleanup.status, "PASS");
  assert.equal(mock.state.running.size, 0);
});

test("missing approved model stops at preflight without generation", async (t) => {
  const mock = await mockOllama(t);
  mock.state.models.delete(comparison);
  const evidence = await runOllamaLiveHarness({
    confirmed: true,
    endpoint: mock.endpoint,
    controlTimeoutMs: 1000,
    sampleResources: resources,
  });
  assert.equal(evidence.status, "FAIL");
  assert.equal(evidence.tests[0].test, "preflight");
  assert.equal(evidence.tests[0].outcome, "MODEL_OR_RESIDENCY_UNAVAILABLE");
  assert.equal(mock.state.chatRequests, 0);
  assert.equal(evidence.cleanup.status, "PASS");
});

test("unmanaged residency fails closed and cleanup does not unload it", async (t) => {
  const mock = await mockOllama(t);
  mock.state.running.add("unmanaged:latest");
  const evidence = await runOllamaLiveHarness({
    confirmed: true,
    endpoint: mock.endpoint,
    controlTimeoutMs: 1000,
    sampleResources: resources,
  });
  assert.equal(evidence.status, "FAIL");
  assert.equal(evidence.tests[0].outcome, "MODEL_OR_RESIDENCY_UNAVAILABLE");
  assert.equal(evidence.cleanup.status, "FAIL");
  assert.deepEqual([...mock.state.running], ["unmanaged:latest"]);
  assert.equal(mock.state.chatRequests, 0);
});

test("malformed runtime provenance fails closed without leaking value", async (t) => {
  const mock = await mockOllama(t, "MALFORMED_VERSION");
  const evidence = await runOllamaLiveHarness({
    confirmed: true,
    endpoint: mock.endpoint,
    controlTimeoutMs: 1000,
    sampleResources: resources,
  });
  assert.equal(evidence.status, "FAIL");
  assert.equal(evidence.runtime.status, "UNAVAILABLE");
  assert.equal(evidence.runtime.error.code, "MALFORMED_PROVIDER_RESPONSE");
  assert.doesNotMatch(JSON.stringify(evidence), /private value/);
});

test("harness source uses the reviewed provider path and has no fallback or logging", async () => {
  const source = await readFile(
    new URL("../src/ollama-live-harness.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /invokeProvider/);
  assert.match(source, /streamProvider/);
  assert.match(source, /OllamaLocalAdapter/);
  assert.doesNotMatch(source, /fetch\s*\(|OPENAI|backupProvider/i);
  assert.doesNotMatch(source, /console\.|process\.stdout|process\.stderr/);
});
