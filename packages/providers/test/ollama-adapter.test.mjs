import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";

import { isProviderOutcome } from "@laita/contracts";
import {
  invokeProvider,
  OllamaConfigurationError,
  OllamaLocalAdapter,
  streamProvider,
} from "../dist/index.js";
import { runProviderAdapterContractSuite } from "../dist/test-support.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const sha = `sha256:${"c".repeat(64)}`;

function policy(model = "local-a") {
  return {
    contractVersion: "provider-policy-decision.v1",
    providerPolicyVersion: "provider-eligibility.v1",
    capabilityDecision: {
      contractVersion: "capability-decision.v1",
      decisionRef: `decision-${model}`,
      evaluatedContextDigest: sha,
      policyVersion: "teaching-policy.v1",
      classificationVersion: "data-classification.v1",
      retentionPolicyVersion: "retention-policy.v1",
      gradingBoundaryVersion: "grading-boundary.v1",
      targetProvider: "LOCAL",
      targetModel: model,
      allowed: true,
      reasonCodes: ["EXPLICIT_ALLOW"],
      constraints: {
        localOnly: true,
        noFallback: true,
        minimizedContentRequired: false,
      },
      recheckOn: ["PROVIDER_OR_MODEL_CHANGE", "POLICY_VERSION_CHANGE"],
    },
  };
}

function request(model = "local-a", overrides = {}) {
  return {
    contractVersion: "provider-request.v1",
    runRef: `run-${model.replaceAll(":", "-")}`,
    attempt: {
      kind: "INITIAL",
      attemptRef: `attempt-${model.replaceAll(":", "-")}`,
      ordinal: 1,
    },
    selection: { provider: "LOCAL", model },
    input: { messages: [{ role: "USER", content: "Synthetic prompt" }] },
    generation: { maxOutputTokens: 32, temperature: 0.2, topP: 0.9 },
    timeoutMs: 100,
    cancellationRef: `cancellation-${model.replaceAll(":", "-")}`,
    policy: policy(model),
    configuration: {
      reference: "ollama-test-config",
      version: "ollama-config.v1",
      digest: sha,
    },
    ...overrides,
  };
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function mockOllama(t) {
  const state = {
    scenario: "SUCCESS",
    running: new Set(["local-a"]),
    installed: new Set(["local-a", "local-b"]),
    requests: [],
    abortCurrent: undefined,
    abortedTransports: 0,
    interruptedStreamResponses: 0,
    transportRequests: 0,
  };
  const server = http.createServer(async (incoming, response) => {
    state.transportRequests += 1;
    incoming.on("aborted", () => {
      state.abortedTransports += 1;
    });
    const url = new URL(incoming.url, "http://127.0.0.1");
    if (incoming.method === "GET" && url.pathname === "/api/tags") {
      if (state.scenario === "INVENTORY_OUTAGE") {
        response.writeHead(503, { "content-type": "text/plain" });
        return response.end("temporarily unavailable");
      }
      if (state.scenario === "MALFORMED_INVENTORY") {
        return json(response, 200, { wrong: [] });
      }
      return json(response, 200, {
        models: [...state.installed].map((model) => ({
          model,
          digest:
            state.scenario === "MALFORMED_DIGEST"
              ? "not-a-digest"
              : model === "local-a"
                ? digestA
                : digestB,
          size: model === "local-a" ? 1000 : 2000,
        })),
      });
    }
    if (incoming.method === "GET" && url.pathname === "/api/ps") {
      return json(response, 200, {
        models: [...state.running].map((model) => ({
          model,
          digest: model === "local-a" ? digestA : digestB,
          size: 3000,
          size_vram: 2500,
          context_length: 4096,
        })),
      });
    }
    if (incoming.method === "POST" && url.pathname === "/api/generate") {
      const payload = await body(incoming);
      state.requests.push({ path: url.pathname, payload });
      if (payload.keep_alive === 0) state.running.delete(payload.model);
      else state.running.add(payload.model);
      return json(response, 200, { model: payload.model, done: true });
    }
    if (incoming.method !== "POST" || url.pathname !== "/api/chat") {
      return json(response, 404, { error: "not found" });
    }
    const payload = await body(incoming);
    state.requests.push({ path: url.pathname, payload });
    const scenario = state.scenario;
    const errors = {
      UNAVAILABLE: [503, "service unavailable"],
      BUSY: [409, "model loading"],
      RATE_LIMITED: [429, "rate limited"],
      QUOTA_EXCEEDED: [507, "capacity exhausted"],
      AUTHENTICATION_FAILED: [401, "authentication required"],
      INTERNAL_FAILURE: [500, "server failure"],
    };
    if (errors[scenario]) {
      const [status, error] = errors[scenario];
      return json(response, status, { error });
    }
    if (scenario === "TIMEOUT") {
      return setTimeout(() => {
        if (!response.destroyed) json(response, 200, chat(payload.model));
      }, 250);
    }
    if (scenario === "SERVICE_HTML") {
      response.writeHead(503, { "content-type": "text/plain" });
      return response.end("temporarily unavailable");
    }
    if (scenario === "ERROR_BODY_MISSING") {
      response.writeHead(503, { "content-length": "0" });
      return response.end();
    }
    if (scenario === "ERROR_BODY_MALFORMED") {
      response.writeHead(429, { "content-type": "application/json" });
      return response.end("{malformed");
    }
    if (scenario === "ERROR_BODY_OVERSIZED") {
      response.writeHead(429, { "content-type": "application/json" });
      return response.end("x".repeat(1024 * 1024 + 1));
    }
    if (scenario === "ERROR_BODY_READ_FAILURE") {
      response.writeHead(401, {
        "content-type": "application/json",
        "content-length": "1024",
      });
      response.flushHeaders();
      response.write("{");
      return setTimeout(() => response.destroy(), 5);
    }
    if (scenario === "REDIRECT") {
      response.writeHead(302, {
        location: `http://${incoming.headers.host}/redirect-target`,
      });
      return response.end();
    }
    if (scenario === "MALFORMED_RESPONSE") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end("{broken");
    }
    if (!payload.stream) {
      const result = chat(payload.model);
      if (scenario === "OVERSIZED_OUTPUT") {
        result.message.content = "x".repeat(2048);
      }
      if (scenario === "OVERSIZED_USAGE") result.eval_count = 100;
      return json(response, 200, result);
    }
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.on("close", () => {
      if (!response.writableEnded) state.interruptedStreamResponses += 1;
    });
    if (scenario === "NULL_STREAM_EVENT") return response.end("null\n");
    if (scenario === "STRING_STREAM_EVENT") {
      return response.end('"not-an-event"\n');
    }
    if (scenario === "NUMBER_STREAM_EVENT") return response.end("7\n");
    if (scenario === "BOOLEAN_STREAM_EVENT") return response.end("true\n");
    if (scenario === "ARRAY_STREAM_EVENT") return response.end("[]\n");
    response.write(
      `${JSON.stringify({
        model: payload.model,
        message: { role: "assistant", content: "shared " },
        done: false,
      })}\n`,
    );
    if (scenario === "CANCEL_AFTER_PARTIAL") {
      return setTimeout(() => state.abortCurrent?.abort(), 10);
    }
    if (scenario === "EARLY_BREAK") return;
    if (scenario === "PARTIAL_FAILURE") {
      return response.end(`${JSON.stringify({ error: "server failure" })}\n`);
    }
    if (scenario === "UNEXPECTED_CLOSE") {
      return setTimeout(() => response.socket?.destroy(), 5);
    }
    if (scenario === "MALFORMED_STREAM") {
      return response.end("{broken}\n");
    }
    if (scenario === "OVERSIZED_OUTPUT") {
      return response.end(
        `${JSON.stringify({
          ...chat(payload.model),
          message: { role: "assistant", content: "x".repeat(2048) },
        })}\n`,
      );
    }
    response.end(
      `${JSON.stringify({
        ...chat(payload.model),
        message: { role: "assistant", content: "result" },
      })}\n`,
    );
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { state, endpoint: `http://127.0.0.1:${address.port}` };
}

function chat(model) {
  return {
    model,
    message: { role: "assistant", content: "shared result" },
    done: true,
    done_reason: "stop",
    total_duration: 12_000_000,
    load_duration: 2_000_000,
    prompt_eval_count: 3,
    eval_count: 2,
  };
}

function candidates() {
  return ["local-a", "local-b"].map((model) => ({
    model,
    contextTokens: 4096,
    maxInputBytes: 1024,
    maxOutputTokens: 64,
    maxOutputBytes: 1024,
    keepAliveSeconds: 60,
  }));
}

function adapter(endpoint, options = {}) {
  return new OllamaLocalAdapter({
    endpoint,
    configuration: request().configuration,
    candidates: candidates(),
    selectedModel: "local-a",
    ...options,
  });
}

function context(controller = new AbortController()) {
  return { signal: controller.signal };
}

test("Ollama adapter passes the complete shared provider contract suite", async (t) => {
  const mock = await mockOllama(t);
  let currentController;
  await runProviderAdapterContractSuite({
    request: request(),
    expectedOutput: "shared result",
    context: () => {
      currentController = new AbortController();
      mock.state.abortCurrent = currentController;
      return context(currentController);
    },
    createAdapter: (scenario) => {
      mock.state.scenario = scenario;
      return adapter(mock.endpoint);
    },
  });
});

test("non-streaming success carries exact model, digest, generation, usage and safe resource provenance", async (t) => {
  const mock = await mockOllama(t);
  const result = await invokeProvider(
    adapter(mock.endpoint, {
      measureResources: () => ({
        status: "MEASURED",
        processMemoryBytes: 4096,
        systemMemoryPressure: "NORMAL",
        swapDeltaBytes: 0,
      }),
    }),
    request(),
    context(),
  );
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(result.identity, {
    selected: { provider: "LOCAL", model: "local-a" },
    actual: {
      provider: "LOCAL",
      model: { id: "local-a", digest: `sha256:${digestA}` },
    },
  });
  assert.deepEqual(result.usage, {
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 5,
    providerReported: true,
  });
  assert.equal(result.provenance.local.runtime, "OLLAMA");
  assert.equal(result.provenance.local.loadState, "WARM");
  assert.equal(result.provenance.local.residency, "WARM");
  assert.equal(result.provenance.local.loadDurationMs, 2);
  assert.equal(result.provenance.local.resources.processMemoryBytes, 4096);
  const sent = mock.state.requests.at(-1).payload;
  assert.equal(sent.model, "local-a");
  assert.equal(sent.keep_alive, 60);
  assert.equal(sent.think, false);
  assert.deepEqual(sent.options, {
    num_ctx: 4096,
    num_predict: 32,
    temperature: 0.2,
    top_p: 0.9,
  });
});

test("resource provenance drops unapproved fields and marks invalid measurements interrupted", async (t) => {
  const mock = await mockOllama(t);
  const sanitized = await invokeProvider(
    adapter(mock.endpoint, {
      measureResources: () => ({
        status: "MEASURED",
        processMemoryBytes: 4096,
        hostname: "must-not-escape",
        privatePath: "/must/not/escape",
      }),
    }),
    request(),
    context(),
  );
  assert.equal(sanitized.status, "COMPLETED");
  assert.deepEqual(sanitized.provenance.local.resources, {
    status: "MEASURED",
    processMemoryBytes: 4096,
  });
  assert.doesNotMatch(JSON.stringify(sanitized), /must-not-escape|must\/not/);
  assert.equal(
    isProviderOutcome({
      ...sanitized,
      provenance: {
        ...sanitized.provenance,
        local: {
          ...sanitized.provenance.local,
          hostname: "must-not-escape",
        },
      },
    }),
    false,
  );

  const interrupted = await invokeProvider(
    adapter(mock.endpoint, {
      measureResources: () => ({ status: "MEASURED" }),
    }),
    request(),
    context(),
  );
  assert.deepEqual(interrupted.provenance.local.resources, {
    status: "INTERRUPTED",
  });
});

test("stream success uses stable final semantics and consistent provenance", async (t) => {
  const mock = await mockOllama(t);
  const events = [];
  for await (const event of streamProvider(
    adapter(mock.endpoint),
    request(),
    context(),
  )) {
    events.push(event);
  }
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "STARTED",
      "PROVENANCE",
      "CONTENT_DELTA",
      "CONTENT_DELTA",
      "USAGE_UPDATE",
      "COMPLETED",
    ],
  );
  assert.equal(events.at(-1).result.output.text, "shared result");
  assert.equal(
    events.at(1).identity.actual.model.digest,
    events.at(-1).result.identity.actual.model.digest,
  );
});

test("stopping stream consumption cancels transport and releases the request slot", async (t) => {
  const mock = await mockOllama(t);
  mock.state.scenario = "EARLY_BREAK";
  const instance = adapter(mock.endpoint);
  const iterator = streamProvider(instance, request(), context())[
    Symbol.asyncIterator
  ]();
  assert.equal((await iterator.next()).value.type, "STARTED");
  assert.equal((await iterator.next()).value.type, "PROVENANCE");
  assert.equal((await iterator.next()).value.type, "CONTENT_DELTA");
  await iterator.return();
  await assert.doesNotReject(
    Promise.race([
      new Promise((resolve) => {
        const poll = () => {
          if (mock.state.interruptedStreamResponses === 1) return resolve();
          setTimeout(poll, 1);
        };
        poll();
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("stream transport stayed open")),
          100,
        ),
      ),
    ]),
  );
  mock.state.scenario = "SUCCESS";
  const recovered = await invokeProvider(instance, request(), context());
  assert.equal(recovered.status, "COMPLETED");
});

for (const [scenario, code] of [
  ["MALFORMED_STREAM", "MALFORMED_PROVIDER_RESPONSE"],
  ["PARTIAL_FAILURE", "INTERNAL_PROVIDER_FAILURE"],
  ["UNEXPECTED_CLOSE", "MALFORMED_PROVIDER_RESPONSE"],
]) {
  test(`${scenario} ends with untrusted partial output and no success`, async (t) => {
    const mock = await mockOllama(t);
    mock.state.scenario = scenario;
    const events = [];
    for await (const event of streamProvider(
      adapter(mock.endpoint),
      request(),
      context(),
    )) {
      events.push(event);
    }
    const terminal = events.at(-1);
    assert.equal(terminal.type, "FAILED");
    assert.equal(terminal.result.error.code, code);
    assert.equal(terminal.result.partialOutput.trusted, false);
    assert.equal(
      events.some((event) => event.type === "COMPLETED"),
      false,
    );
  });
}

for (const scenario of [
  "NULL_STREAM_EVENT",
  "STRING_STREAM_EVENT",
  "NUMBER_STREAM_EVENT",
  "BOOLEAN_STREAM_EVENT",
  "ARRAY_STREAM_EVENT",
]) {
  test(`${scenario} fails closed as a malformed provider response`, async (t) => {
    const mock = await mockOllama(t);
    mock.state.scenario = scenario;
    const events = [];
    for await (const event of streamProvider(
      adapter(mock.endpoint),
      request(),
      context(),
    )) {
      events.push(event);
    }
    const terminal = events.at(-1);
    assert.equal(terminal.type, "FAILED");
    assert.equal(terminal.result.error.code, "MALFORMED_PROVIDER_RESPONSE");
    assert.notEqual(terminal.result.error.code, "PROVIDER_UNAVAILABLE");
    assert.equal(
      events.some((event) => event.type === "CONTENT_DELTA"),
      false,
    );
    assert.equal(
      events.some((event) => event.type === "COMPLETED"),
      false,
    );
  });
}

test("caller cancellation reaches transport after partial output and late settlement cannot succeed", async (t) => {
  const mock = await mockOllama(t);
  mock.state.scenario = "CANCEL_AFTER_PARTIAL";
  const controller = new AbortController();
  mock.state.abortCurrent = controller;
  const events = [];
  for await (const event of streamProvider(
    adapter(mock.endpoint),
    request(),
    context(controller),
  )) {
    events.push(event);
  }
  const terminal = events.at(-1);
  assert.equal(terminal.type, "CANCELLED");
  assert.equal(terminal.result.error.code, "CANCELLED");
  assert.deepEqual(terminal.result.partialOutput, {
    text: "shared ",
    trusted: false,
  });
  assert.equal(
    events.some((event) => event.type === "COMPLETED"),
    false,
  );
});

test("timeout aborts transport and releases the single request slot", async (t) => {
  const mock = await mockOllama(t);
  mock.state.scenario = "TIMEOUT";
  const instance = adapter(mock.endpoint);
  const timedOut = await invokeProvider(instance, request(), context());
  assert.equal(timedOut.status, "FAILED");
  assert.equal(timedOut.error.code, "TIMEOUT");
  mock.state.scenario = "SUCCESS";
  const recovered = await invokeProvider(instance, request(), context());
  assert.equal(recovered.status, "COMPLETED");
});

test("timeout also bounds an uncooperative optional resource measurement and releases the slot", async (t) => {
  const mock = await mockOllama(t);
  let measurements = 0;
  const instance = adapter(mock.endpoint, {
    measureResources: () => {
      measurements += 1;
      return measurements === 1
        ? new Promise(() => undefined)
        : { status: "NOT_AVAILABLE" };
    },
  });
  const timedOut = await invokeProvider(instance, request(), context());
  assert.equal(timedOut.status, "FAILED");
  assert.equal(timedOut.error.code, "TIMEOUT");
  const recovered = await invokeProvider(instance, request(), context());
  assert.equal(recovered.status, "COMPLETED");
});

test("one active generation exposes busy state and rejects concurrent work without a queue", async (t) => {
  const mock = await mockOllama(t);
  mock.state.scenario = "TIMEOUT";
  const instance = adapter(mock.endpoint);
  const first = invokeProvider(instance, request(), context());
  const snapshot = await instance.inspectAvailability(context());
  assert.equal(snapshot.state, "BUSY");
  assert.equal(snapshot.models[0].residency, "BUSY");
  const second = await invokeProvider(instance, request(), context());
  assert.equal(second.status, "FAILED");
  assert.equal(second.error.code, "PROVIDER_BUSY");
  assert.equal((await first).error.code, "TIMEOUT");
});

test("pre-cancelled request performs zero transport work", async (t) => {
  const mock = await mockOllama(t);
  const controller = new AbortController();
  controller.abort();
  const result = await invokeProvider(
    adapter(mock.endpoint),
    request(),
    context(controller),
  );
  assert.equal(result.status, "CANCELLED");
  assert.equal(result.error.code, "CANCELLED");
  assert.equal(mock.state.transportRequests, 0);
});

test("connection refusal maps to explicit Local unavailability", async () => {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  const result = await invokeProvider(
    adapter(`http://127.0.0.1:${address.port}`),
    request(),
    context(),
  );
  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "PROVIDER_UNAVAILABLE");
});

test("non-JSON service errors still map by HTTP status", async (t) => {
  const mock = await mockOllama(t);
  mock.state.scenario = "SERVICE_HTML";
  const result = await invokeProvider(
    adapter(mock.endpoint),
    request(),
    context(),
  );
  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "PROVIDER_UNAVAILABLE");
});

for (const [scenario, code] of [
  ["ERROR_BODY_MISSING", "PROVIDER_UNAVAILABLE"],
  ["ERROR_BODY_MALFORMED", "RATE_LIMITED"],
  ["ERROR_BODY_OVERSIZED", "RATE_LIMITED"],
  ["ERROR_BODY_READ_FAILURE", "PROVIDER_AUTHENTICATION_FAILED"],
]) {
  test(`${scenario} preserves HTTP status semantics`, async (t) => {
    const mock = await mockOllama(t);
    mock.state.scenario = scenario;
    const result = await invokeProvider(
      adapter(mock.endpoint),
      request(),
      context(),
    );
    assert.equal(result.status, "FAILED");
    assert.equal(result.error.code, code);
  });
}

test("provider redirects are never followed with request content", async (t) => {
  const mock = await mockOllama(t);
  mock.state.scenario = "REDIRECT";
  const result = await invokeProvider(
    adapter(mock.endpoint),
    request(),
    context(),
  );
  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(mock.state.transportRequests, 3);
});

test("unknown models, unselected approved models, and missing models fail closed without substitution", async (t) => {
  const mock = await mockOllama(t);
  const instance = adapter(mock.endpoint);
  const before = mock.state.requests.length;
  const unknown = await invokeProvider(
    instance,
    request("arbitrary-client-model"),
    context(),
  );
  assert.equal(unknown.error.code, "CONTRACT_VIOLATION");
  assert.equal(mock.state.requests.length, before);
  const unselected = await invokeProvider(
    instance,
    request("local-b"),
    context(),
  );
  assert.equal(unselected.error.code, "PROVIDER_BUSY");
  assert.equal(instance.selectedModel, "local-a");
  mock.state.installed.delete("local-a");
  const unavailable = await invokeProvider(instance, request(), context());
  assert.equal(unavailable.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(instance.selectedModel, "local-a");
});

test("availability represents unloaded, warm, busy, unavailable, and unsafe multi-residency states", async (t) => {
  const mock = await mockOllama(t);
  const instance = adapter(mock.endpoint);
  let snapshot = await instance.inspectAvailability(context());
  assert.deepEqual(
    snapshot.models.map(({ model, residency }) => [model, residency]),
    [
      ["local-a", "WARM"],
      ["local-b", "UNLOADED"],
    ],
  );
  mock.state.installed.delete("local-b");
  snapshot = await instance.inspectAvailability(context());
  assert.equal(snapshot.models[1].residency, "UNAVAILABLE");
  mock.state.installed.add("local-b");
  mock.state.running.add("local-b");
  snapshot = await instance.inspectAvailability(context());
  assert.equal(snapshot.residentModels, 2);
  assert.equal(snapshot.residentApprovedModels, 2);
  assert.equal(snapshot.onePrimaryResidencySafe, false);
  const blocked = await invokeProvider(instance, request(), context());
  assert.equal(blocked.error.code, "PROVIDER_BUSY");
});

test("an unmanaged resident model blocks generation and switching instead of creating hidden coexistence", async (t) => {
  const mock = await mockOllama(t);
  mock.state.running.add("unmanaged-model");
  const instance = adapter(mock.endpoint);
  const snapshot = await instance.inspectAvailability(context());
  assert.equal(snapshot.residentModels, 2);
  assert.equal(snapshot.residentApprovedModels, 1);
  assert.equal(snapshot.onePrimaryResidencySafe, false);
  const generation = await invokeProvider(instance, request(), context());
  assert.equal(generation.error.code, "PROVIDER_BUSY");
  const switched = await instance.switchModel("local-b", context());
  assert.equal(switched.status, "FAILED");
  assert.equal(switched.error.code, "PROVIDER_BUSY");
  assert.equal(
    mock.state.requests.some(({ path }) => path === "/api/generate"),
    false,
  );
});

test("availability outage and malformed model digest return bounded normalized state", async (t) => {
  const mock = await mockOllama(t);
  const instance = adapter(mock.endpoint);
  mock.state.scenario = "INVENTORY_OUTAGE";
  let snapshot = await instance.inspectAvailability(context());
  assert.equal(snapshot.state, "UNAVAILABLE");
  assert.equal(snapshot.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(snapshot.onePrimaryResidencySafe, false);
  assert.equal(
    snapshot.models.every((model) => !model.installed),
    true,
  );

  mock.state.scenario = "MALFORMED_DIGEST";
  snapshot = await instance.inspectAvailability(context());
  assert.equal(snapshot.error.code, "MALFORMED_PROVIDER_RESPONSE");
  const outcome = await invokeProvider(instance, request(), context());
  assert.equal(outcome.error.code, "MALFORMED_PROVIDER_RESPONSE");
});

test("deliberate switching unloads all approved residents before loading one selected primary", async (t) => {
  const mock = await mockOllama(t);
  const instance = adapter(mock.endpoint);
  const result = await instance.switchModel("local-b", context());
  assert.deepEqual(result, {
    status: "SWITCHED",
    previousModel: "local-a",
    selectedModel: "local-b",
    transitions: ["SWITCHING", "UNLOADED", "LOADING", "WARM"],
    digest: `sha256:${digestB}`,
  });
  assert.deepEqual([...mock.state.running], ["local-b"]);
  assert.deepEqual(
    mock.state.requests
      .filter(({ path }) => path === "/api/generate")
      .map(({ payload }) => [payload.model, payload.keep_alive]),
    [
      ["local-a", 0],
      ["local-b", 60],
    ],
  );
  const completed = await invokeProvider(
    instance,
    request("local-b"),
    context(),
  );
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.identity.actual.model.id, "local-b");
});

test("unknown switch requests cannot alter selection or invoke transport", async (t) => {
  const mock = await mockOllama(t);
  const instance = adapter(mock.endpoint);
  const before = mock.state.requests.length;
  const result = await instance.switchModel("client-choice", context());
  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "CONTRACT_VIOLATION");
  assert.equal(instance.selectedModel, "local-a");
  assert.equal(mock.state.requests.length, before);
});

test("input and output bounds fail closed and do not retry or fall back", async (t) => {
  const mock = await mockOllama(t);
  const instance = adapter(mock.endpoint, {
    candidates: candidates().map((candidate) => ({
      ...candidate,
      maxInputBytes: 32,
      maxOutputTokens: 16,
    })),
  });
  const oversized = request("local-a", {
    input: { messages: [{ role: "USER", content: "x".repeat(100) }] },
  });
  const inputFailure = await invokeProvider(instance, oversized, context());
  assert.equal(inputFailure.error.code, "CONTRACT_VIOLATION");
  const outputFailure = await invokeProvider(instance, request(), context());
  assert.equal(outputFailure.error.code, "CONTRACT_VIOLATION");
  assert.equal(mock.state.requests.length, 0);
  mock.state.scenario = "OVERSIZED_OUTPUT";
  const boundedInstance = adapter(mock.endpoint);
  const oversizedOutput = await invokeProvider(
    boundedInstance,
    request(),
    context(),
  );
  assert.equal(oversizedOutput.error.code, "MALFORMED_PROVIDER_RESPONSE");
  mock.state.scenario = "OVERSIZED_USAGE";
  const oversizedUsage = await invokeProvider(
    boundedInstance,
    request(),
    context(),
  );
  assert.equal(oversizedUsage.error.code, "MALFORMED_PROVIDER_RESPONSE");
});

test("endpoint and residency configuration reject public URLs and multi-model defaults", () => {
  const credentialEndpoint = new URL("http://127.0.0.1:11434");
  credentialEndpoint.username = "synthetic-user";
  for (const options of [
    { endpoint: "https://example.com" },
    { endpoint: credentialEndpoint.toString() },
    { endpoint: "http://127.0.0.1:11434/api" },
    { endpoint: "http://127.0.0.1:11434", maxResidentModels: 2 },
    { endpoint: "http://127.0.0.1:11434", selectedModel: "unknown" },
    { endpoint: "http://127.0.0.1:11434", maxMessages: 0 },
    { endpoint: "http://127.0.0.1:11434", maxMessageBytes: 2 ** 21 },
    {
      endpoint: "http://127.0.0.1:11434",
      candidates: candidates().map((candidate) => ({
        ...candidate,
        keepAliveSeconds: 100_000,
      })),
    },
  ]) {
    assert.throws(
      () =>
        new OllamaLocalAdapter({
          configuration: request().configuration,
          candidates: candidates(),
          selectedModel: "local-a",
          ...options,
        }),
      OllamaConfigurationError,
    );
  }
});

test("adapter source contains no prompt logging or Cloud/OpenAI fallback path", async () => {
  const source = await readFile(
    new URL("../src/ollama.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /console\.|process\.stdout|process\.stderr/);
  assert.doesNotMatch(source, /OPENAI|fallback|backupProvider/i);
});

test("installed UNLOADED model accepts one cold request; timeout still aborts with no retry or fallback", async (t) => {
  const mock = await mockOllama(t);
  mock.state.running.clear();
  const instance = adapter(mock.endpoint);
  const available = await instance.inspectAvailability(context());
  assert.equal(
    available.models.find((m) => m.model === "local-a").residency,
    "UNLOADED",
  );
  const cold = await invokeProvider(instance, request(), context());
  assert.equal(cold.status, "COMPLETED");
  assert.equal(cold.provenance.local.loadState, "COLD");
  assert.equal(
    mock.state.requests.filter((r) => r.path === "/api/chat").length,
    1,
  );
  mock.state.scenario = "TIMEOUT";
  const failed = await invokeProvider(instance, request(), context());
  assert.equal(failed.error.code, "TIMEOUT");
  assert.equal(
    mock.state.requests.filter((r) => r.path === "/api/chat").length,
    2,
  );
  assert.ok(mock.state.requests.every((r) => r.payload.model === "local-a"));
});
