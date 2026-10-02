import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";

import { isProviderOutcome } from "@laita/contracts";
import { createSecretHandleForProvider } from "@laita/runtime";
import {
  invokeProvider,
  OpenAIConfigurationError,
  OpenAIResponsesAdapter,
  streamProvider,
} from "../dist/index.js";
import { createFakeProviderAdapter } from "../dist/test-support.js";

const model = "gpt-5.6-luna";
const sha = `sha256:${"d".repeat(64)}`;
const syntheticSecret = `sk-test_${"z".repeat(32)}`;
const secretReference = { kind: "opaque", id: "openai-primary" };
const configuration = {
  reference: "openai-test-config",
  version: "openai-config.v1",
  digest: sha,
};

function policy() {
  return {
    contractVersion: "provider-policy-decision.v1",
    providerPolicyVersion: "provider-eligibility.v1",
    capabilityDecision: {
      contractVersion: "capability-decision.v1",
      decisionRef: "decision-openai-fixture",
      evaluatedContextDigest: sha,
      policyVersion: "teaching-policy.v1",
      classificationVersion: "data-classification.v1",
      retentionPolicyVersion: "retention-policy.v1",
      gradingBoundaryVersion: "grading-boundary.v1",
      targetProvider: "OPENAI",
      targetModel: model,
      allowed: true,
      reasonCodes: ["EXPLICIT_ALLOW"],
      constraints: {
        localOnly: false,
        noFallback: true,
        minimizedContentRequired: true,
      },
      recheckOn: ["PROVIDER_OR_MODEL_CHANGE", "POLICY_VERSION_CHANGE"],
    },
  };
}

function request(overrides = {}) {
  return {
    contractVersion: "provider-request.v1",
    runRef: "run-openai-fixture",
    attempt: {
      kind: "INITIAL",
      attemptRef: "attempt-openai-fixture",
      ordinal: 1,
    },
    selection: { provider: "OPENAI", model },
    input: {
      messages: [
        { role: "SYSTEM", content: "Use only the synthetic fixture." },
        { role: "USER", content: "Return a synthetic answer." },
      ],
    },
    generation: { maxOutputTokens: 32, temperature: 0, topP: 0.9 },
    timeoutMs: 200,
    cancellationRef: "cancellation-openai-fixture",
    policy: policy(),
    configuration,
    ...overrides,
  };
}

function response(output = "Synthetic response", overrides = {}) {
  return {
    id: "resp_synthetic",
    object: "response",
    created_at: 1,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: 32,
    model,
    output: [
      {
        id: "msg_synthetic",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: output,
            annotations: [],
            logprobs: [],
          },
        ],
      },
    ],
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: { effort: "none", summary: null },
    store: false,
    temperature: 0,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 0.9,
    truncation: "disabled",
    usage: {
      input_tokens: 4,
      input_tokens_details: { cached_tokens: 1 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 6,
    },
    metadata: {},
    ...overrides,
  };
}

async function readBody(incoming) {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(outgoing, status, value) {
  outgoing.writeHead(status, { "content-type": "application/json" });
  outgoing.end(JSON.stringify(value));
}

function writeSse(outgoing, event) {
  outgoing.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

async function mockOpenAI(t) {
  const state = {
    scenario: "SUCCESS",
    requests: [],
    calls: 0,
    transportAborts: 0,
    streamErrorCode: "server_error",
  };
  const server = http.createServer(async (incoming, outgoing) => {
    state.calls += 1;
    incoming.on("aborted", () => {
      state.transportAborts += 1;
    });
    if (incoming.method !== "POST" || incoming.url !== "/v1/responses") {
      return writeJson(outgoing, 404, { error: { message: "not found" } });
    }
    const payload = await readBody(incoming);
    state.requests.push({
      authorization: incoming.headers.authorization,
      payload,
    });
    const errorResponses = {
      AUTH: [401, "invalid_api_key"],
      PERMISSION: [403, "permission_denied"],
      RATE: [429, "rate_limit_exceeded"],
      QUOTA: [429, "insufficient_quota"],
      BUDGET: [429, "budget_exceeded"],
      INVALID_MODEL: [404, "model_not_found"],
      SERVICE: [500, "server_error"],
    };
    if (errorResponses[state.scenario]) {
      const [status, code] = errorResponses[state.scenario];
      return writeJson(outgoing, status, {
        error: {
          message: `${syntheticSecret} must never escape normalization`,
          type: "synthetic_error",
          param: null,
          code,
        },
      });
    }
    if (state.scenario === "MALFORMED_JSON") {
      outgoing.writeHead(200, { "content-type": "application/json" });
      return outgoing.end("{not-json");
    }
    if (state.scenario === "MALFORMED_RESPONSE") {
      return writeJson(
        outgoing,
        200,
        response("", { model: "substituted-model" }),
      );
    }
    if (state.scenario === "NULL_OUTPUT_ITEM") {
      return writeJson(outgoing, 200, response("", { output: [null] }));
    }
    if (state.scenario === "NULL_MESSAGE_CONTENT") {
      return writeJson(
        outgoing,
        200,
        response("", {
          output: [
            {
              id: "msg_synthetic",
              type: "message",
              status: "completed",
              role: "assistant",
              content: null,
            },
          ],
        }),
      );
    }
    if (state.scenario === "OVERSIZED_OUTPUT") {
      return writeJson(outgoing, 200, response("x".repeat(1_025)));
    }
    if (state.scenario === "MALFORMED_USAGE") {
      return writeJson(
        outgoing,
        200,
        response("Synthetic response", {
          usage: {
            input_tokens: 4,
            input_tokens_details: { cached_tokens: 5 },
            output_tokens: 2,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 99,
          },
        }),
      );
    }
    if (state.scenario === "NO_CACHE_DETAILS") {
      return writeJson(
        outgoing,
        200,
        response("Synthetic response", {
          usage: {
            input_tokens: 4,
            output_tokens: 2,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 6,
          },
        }),
      );
    }
    if (state.scenario === "MISSING_OUTPUT") {
      return writeJson(
        outgoing,
        200,
        response("", { output: undefined, output_text: undefined }),
      );
    }
    if (state.scenario === "DELAY") {
      return setTimeout(() => {
        if (!outgoing.destroyed) writeJson(outgoing, 200, response());
      }, 500);
    }
    if (!payload.stream) return writeJson(outgoing, 200, response());
    outgoing.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    if (state.scenario === "STREAM_ERROR") {
      writeSse(outgoing, {
        type: "response.failed",
        sequence_number: 1,
        response: response("", {
          status: "failed",
          error: {
            code: state.streamErrorCode,
            message: `${syntheticSecret} must stay upstream`,
          },
          output: [],
          usage: null,
        }),
      });
      return outgoing.end("data: [DONE]\n\n");
    }
    if (state.scenario === "BROKEN_SSE") {
      return outgoing.end(
        "event: response.output_text.delta\ndata: {not-json\n\n",
      );
    }
    if (state.scenario === "OVERSIZED_STREAM") {
      writeSse(outgoing, {
        type: "response.output_text.delta",
        sequence_number: 1,
        item_id: "msg_synthetic",
        output_index: 0,
        content_index: 0,
        delta: "é".repeat(256),
        logprobs: [],
        obfuscation: "fixture",
      });
      writeSse(outgoing, {
        type: "response.output_text.delta",
        sequence_number: 2,
        item_id: "msg_synthetic",
        output_index: 0,
        content_index: 0,
        delta: "é".repeat(257),
        logprobs: [],
        obfuscation: "fixture",
      });
      return outgoing.end("data: [DONE]\n\n");
    }
    if (state.scenario === "SPLIT_SURROGATE_STREAM") {
      for (const [index, delta] of ["\ud83d", "\ude00"].entries()) {
        writeSse(outgoing, {
          type: "response.output_text.delta",
          sequence_number: index + 1,
          item_id: "msg_synthetic",
          output_index: 0,
          content_index: 0,
          delta,
          logprobs: [],
          obfuscation: "fixture",
        });
      }
      writeSse(outgoing, {
        type: "response.completed",
        sequence_number: 3,
        response: response("😀"),
      });
      return outgoing.end("data: [DONE]\n\n");
    }
    writeSse(outgoing, {
      type: "response.output_text.delta",
      sequence_number: 1,
      item_id: "msg_synthetic",
      output_index: 0,
      content_index: 0,
      delta: "Synthetic ",
      logprobs: [],
      obfuscation: "fixture",
    });
    if (state.scenario === "PARTIAL_DELAY") {
      return setTimeout(() => {
        if (!outgoing.destroyed) outgoing.end();
      }, 500);
    }
    if (state.scenario === "MALFORMED_STREAM") {
      writeSse(outgoing, {
        type: "response.output_text.delta",
        sequence_number: 2,
        item_id: "msg_synthetic",
        output_index: 0,
        content_index: 0,
        delta: "",
        logprobs: [],
        obfuscation: "fixture",
      });
      return outgoing.end("data: [DONE]\n\n");
    }
    writeSse(outgoing, {
      type: "response.output_text.delta",
      sequence_number: 2,
      item_id: "msg_synthetic",
      output_index: 0,
      content_index: 0,
      delta: "response",
      logprobs: [],
      obfuscation: "fixture",
    });
    writeSse(outgoing, {
      type: "response.completed",
      sequence_number: 3,
      response: response(),
    });
    outgoing.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { state, baseURL: `http://127.0.0.1:${address.port}` };
}

function secretProvider(options = {}) {
  const state = { resolves: 0, consumed: 0 };
  return {
    state,
    provider: {
      async resolve(_reference, { signal }) {
        state.resolves += 1;
        if (signal.aborted) {
          return { status: "UNAVAILABLE", code: "SECRET_CANCELLED" };
        }
        if (options.unavailable) {
          return { status: "UNAVAILABLE", code: options.unavailable };
        }
        const handle = createSecretHandleForProvider(
          options.value ?? syntheticSecret,
        );
        return {
          status: "RESOLVED",
          secret: {
            async consume(consumer) {
              state.consumed += 1;
              return handle.consume(consumer);
            },
            toJSON() {
              return undefined;
            },
          },
        };
      },
    },
  };
}

function adapter(baseURL, secret = secretProvider(), maxOutputBytes = 1_024) {
  return {
    adapter: new OpenAIResponsesAdapter({
      configuration,
      candidates: [
        {
          model,
          maxInputBytes: 1_024,
          maxMessages: 8,
          maxMessageBytes: 512,
          maxOutputTokens: 64,
          maxOutputBytes,
        },
      ],
      selectedModel: model,
      secretProvider: secret.provider,
      secretReference,
      testBaseURL: baseURL,
    }),
    secret,
  };
}

const context = (signal = new AbortController().signal) => ({ signal });

test("non-streaming Responses call is bounded, provenance-complete, and server-only", async (t) => {
  const upstream = await mockOpenAI(t);
  const current = adapter(upstream.baseURL);
  const result = await invokeProvider(current.adapter, request(), context());
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.output.text, "Synthetic response");
  assert.deepEqual(result.usage, {
    inputTokens: 4,
    cachedInputTokens: 1,
    outputTokens: 2,
    totalTokens: 6,
    providerReported: true,
  });
  assert.equal(result.identity.actual.model.id, model);
  assert.deepEqual(result.provenance.openai, {
    runtime: "OPENAI_RESPONSES",
    configuredModel: model,
    selectedModel: model,
    responseModel: model,
    sdk: { name: "openai", version: "7.9.0" },
    store: false,
    automaticRetries: 0,
    sdkLogging: "OFF",
    usageStatus: "REPORTED",
  });
  assert.equal(current.secret.state.resolves, 1);
  assert.equal(current.secret.state.consumed, 1);
  assert.equal(
    upstream.state.requests[0].authorization,
    `Bearer ${syntheticSecret}`,
  );
  assert.deepEqual(upstream.state.requests[0].payload.input, [
    { role: "system", content: "Use only the synthetic fixture." },
    { role: "user", content: "Return a synthetic answer." },
  ]);
  assert.equal(upstream.state.requests[0].payload.model, model);
  assert.equal(upstream.state.requests[0].payload.store, false);
  assert.equal(upstream.state.requests[0].payload.stream, false);
  assert.equal(
    upstream.state.requests[0].payload.prompt_cache_options.mode,
    "explicit",
  );
  assert.equal(JSON.stringify(result).includes(syntheticSecret), false);
  assert.equal(JSON.stringify(result).includes(secretReference.id), false);
  assert.equal(isProviderOutcome(result), true);
});

test("streaming produces ordered deltas, measured usage, and equivalent final text", async (t) => {
  const upstream = await mockOpenAI(t);
  const current = adapter(upstream.baseURL);
  const events = [];
  for await (const event of streamProvider(
    current.adapter,
    request(),
    context(),
  )) {
    events.push(event);
  }
  assert.deepEqual(
    events.map(({ type }) => type),
    [
      "STARTED",
      "PROVENANCE",
      "CONTENT_DELTA",
      "CONTENT_DELTA",
      "USAGE_UPDATE",
      "COMPLETED",
    ],
  );
  assert.equal(events.at(-1).result.output.text, "Synthetic response");
  assert.equal(upstream.state.requests[0].payload.stream, true);
  assert.equal(
    upstream.state.requests[0].payload.stream_options.include_obfuscation,
    true,
  );
});

test("valid usage may omit optional cache detail without inventing zero", async (t) => {
  const upstream = await mockOpenAI(t);
  upstream.state.scenario = "NO_CACHE_DETAILS";
  const result = await invokeProvider(
    adapter(upstream.baseURL).adapter,
    request(),
    context(),
  );
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(result.usage, {
    inputTokens: 4,
    outputTokens: 2,
    totalTokens: 6,
    providerReported: true,
  });
  assert.equal("cachedInputTokens" in result.usage, false);
});

test("caller cancellation and timeout abort transport without trusted partial success", async (t) => {
  const upstream = await mockOpenAI(t);
  upstream.state.scenario = "PARTIAL_DELAY";
  const current = adapter(upstream.baseURL);
  const controller = new AbortController();
  const events = [];
  for await (const event of streamProvider(
    current.adapter,
    request({ timeoutMs: 1_000 }),
    context(controller.signal),
  )) {
    events.push(event);
    if (event.type === "CONTENT_DELTA") controller.abort();
  }
  assert.equal(events.at(-1).type, "CANCELLED");
  assert.deepEqual(events.at(-1).result.partialOutput, {
    text: "Synthetic ",
    trusted: false,
  });
  assert.equal(JSON.stringify(events).includes(syntheticSecret), false);

  upstream.state.scenario = "DELAY";
  const timed = await invokeProvider(
    current.adapter,
    request({ timeoutMs: 20 }),
    context(),
  );
  assert.equal(timed.status, "FAILED");
  assert.equal(timed.error.code, "TIMEOUT");
  assert.equal(JSON.stringify(timed).includes(syntheticSecret), false);
  assert.equal(upstream.state.calls, 2);
});

test("upstream failures are distinct, sanitized, and never automatically retried", async (t) => {
  const upstream = await mockOpenAI(t);
  const cases = [
    ["AUTH", "PROVIDER_AUTHENTICATION_FAILED"],
    ["PERMISSION", "PROVIDER_PERMISSION_DENIED"],
    ["RATE", "RATE_LIMITED"],
    ["QUOTA", "QUOTA_EXCEEDED"],
    ["BUDGET", "BUDGET_EXCEEDED"],
    ["SERVICE", "PROVIDER_UNAVAILABLE"],
    ["INVALID_MODEL", "INVALID_PROVIDER_MODEL"],
    ["MALFORMED_JSON", "MALFORMED_PROVIDER_RESPONSE"],
    ["MALFORMED_RESPONSE", "MALFORMED_PROVIDER_RESPONSE"],
    ["NULL_OUTPUT_ITEM", "MALFORMED_PROVIDER_RESPONSE"],
    ["NULL_MESSAGE_CONTENT", "MALFORMED_PROVIDER_RESPONSE"],
    ["OVERSIZED_OUTPUT", "MALFORMED_PROVIDER_RESPONSE"],
    ["MALFORMED_USAGE", "MALFORMED_PROVIDER_RESPONSE"],
    ["MISSING_OUTPUT", "MALFORMED_PROVIDER_RESPONSE"],
  ];
  for (const [scenario, code] of cases) {
    upstream.state.scenario = scenario;
    const before = upstream.state.calls;
    const result = await invokeProvider(
      adapter(upstream.baseURL).adapter,
      request(),
      context(),
    );
    assert.equal(result.status, "FAILED", scenario);
    assert.equal(result.error.code, code, scenario);
    assert.equal(upstream.state.calls, before + 1, `${scenario} retried`);
    assert.equal(JSON.stringify(result).includes(syntheticSecret), false);
    assert.equal(JSON.stringify(result).includes("resp_synthetic"), false);
  }
});

test("malformed stream fails with only untrusted partial output", async (t) => {
  const upstream = await mockOpenAI(t);
  upstream.state.scenario = "MALFORMED_STREAM";
  const events = [];
  for await (const event of streamProvider(
    adapter(upstream.baseURL).adapter,
    request(),
    context(),
  )) {
    events.push(event);
  }
  assert.equal(events.at(-1).type, "FAILED");
  assert.equal(events.at(-1).result.error.code, "MALFORMED_PROVIDER_RESPONSE");
  assert.deepEqual(events.at(-1).result.partialOutput, {
    text: "Synthetic ",
    trusted: false,
  });
});

test("stream byte bounds are incremental, UTF-8 exact, and never return an oversized delta", async (t) => {
  const upstream = await mockOpenAI(t);
  upstream.state.scenario = "OVERSIZED_STREAM";
  const oversized = [];
  for await (const event of streamProvider(
    adapter(upstream.baseURL).adapter,
    request(),
    context(),
  )) {
    oversized.push(event);
  }
  assert.equal(oversized.at(-1).type, "FAILED");
  assert.equal(
    oversized.at(-1).result.error.code,
    "MALFORMED_PROVIDER_RESPONSE",
  );
  assert.equal(
    Buffer.byteLength(oversized.at(-1).result.partialOutput.text, "utf8"),
    512,
  );

  upstream.state.scenario = "SPLIT_SURROGATE_STREAM";
  const exact = [];
  for await (const event of streamProvider(
    adapter(upstream.baseURL, secretProvider(), 4).adapter,
    request(),
    context(),
  )) {
    exact.push(event);
  }
  assert.equal(exact.at(-1).type, "COMPLETED");
  assert.equal(exact.at(-1).result.output.text, "😀");
  assert.equal(Buffer.byteLength(exact.at(-1).result.output.text, "utf8"), 4);
});

test("SDK stream parse failures normalize as malformed provider responses", async (t) => {
  const upstream = await mockOpenAI(t);
  upstream.state.scenario = "BROKEN_SSE";
  const events = [];
  const originalConsoleError = console.error;
  const consoleErrors = [];
  console.error = (...values) => consoleErrors.push(values);
  try {
    for await (const event of streamProvider(
      adapter(upstream.baseURL).adapter,
      request(),
      context(),
    )) {
      events.push(event);
    }
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(events.at(-1).type, "FAILED");
  assert.equal(events.at(-1).result.error.code, "MALFORMED_PROVIDER_RESPONSE");
  assert.equal(events.at(-1).result.partialOutput, undefined);
  assert.deepEqual(consoleErrors, []);
});

test("stream terminal errors use the same sanitized closed taxonomy", async (t) => {
  const upstream = await mockOpenAI(t);
  upstream.state.scenario = "STREAM_ERROR";
  for (const [providerCode, expected] of [
    ["invalid_api_key", "PROVIDER_AUTHENTICATION_FAILED"],
    ["permission_denied", "PROVIDER_PERMISSION_DENIED"],
    ["model_not_found", "INVALID_PROVIDER_MODEL"],
    ["rate_limit_exceeded", "RATE_LIMITED"],
    ["insufficient_quota", "QUOTA_EXCEEDED"],
    ["budget_exceeded", "BUDGET_EXCEEDED"],
    ["server_error", "PROVIDER_UNAVAILABLE"],
  ]) {
    upstream.state.streamErrorCode = providerCode;
    const events = [];
    for await (const event of streamProvider(
      adapter(upstream.baseURL).adapter,
      request(),
      context(),
    )) {
      events.push(event);
    }
    assert.equal(events.at(-1).type, "FAILED");
    assert.equal(events.at(-1).result.error.code, expected);
    assert.equal(JSON.stringify(events).includes(syntheticSecret), false);
  }
});

test("allowlist, input, output, and unsupported-generation bounds fail before credential use", async (t) => {
  const upstream = await mockOpenAI(t);
  const cases = [
    request({ selection: { provider: "OPENAI", model: "arbitrary-model" } }),
    request({ generation: { maxOutputTokens: 65 } }),
    request({ generation: { maxOutputTokens: 32, stop: ["stop"] } }),
    request({
      input: { messages: [{ role: "USER", content: "x".repeat(513) }] },
    }),
  ];
  for (const currentRequest of cases) {
    const current = adapter(upstream.baseURL);
    const result = await current.adapter.invoke(currentRequest, context());
    assert.equal(result.status, "FAILED");
    assert.equal(result.error.code, "CONTRACT_VIOLATION");
    assert.equal(current.secret.state.resolves, 0);
  }
  assert.equal(upstream.state.calls, 0);
});

test("missing, locked, invalid, failed, timed-out, and cancelled secrets fail closed", async (t) => {
  const upstream = await mockOpenAI(t);
  for (const code of [
    "SECRET_MISSING",
    "SECRET_INACCESSIBLE",
    "SECRET_INVALID",
    "SECRET_COMMAND_FAILED",
    "SECRET_TIMEOUT",
    "SECRET_CANCELLED",
  ]) {
    const unavailable = secretProvider({ unavailable: code });
    const result = await adapter(upstream.baseURL, unavailable).adapter.invoke(
      request(),
      context(),
    );
    assert.equal(
      result.status,
      code === "SECRET_CANCELLED" ? "CANCELLED" : "FAILED",
    );
    assert.equal(
      result.error.code,
      code === "SECRET_TIMEOUT"
        ? "TIMEOUT"
        : code === "SECRET_CANCELLED"
          ? "CANCELLED"
          : "PROVIDER_UNAVAILABLE",
    );
    assert.equal(JSON.stringify(result).includes(syntheticSecret), false);
    assert.equal(JSON.stringify(result).includes(secretReference.id), false);
  }
  assert.equal(upstream.state.calls, 0);
});

test("adapter timeout takes precedence when secret resolution reports signal cancellation", async (t) => {
  const upstream = await mockOpenAI(t);
  const delayedSecret = {
    state: { resolves: 0, consumed: 0 },
    provider: {
      resolve(_reference, { signal }) {
        delayedSecret.state.resolves += 1;
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ status: "UNAVAILABLE", code: "SECRET_CANCELLED" }),
            { once: true },
          );
        });
      },
    },
  };
  const result = await adapter(upstream.baseURL, delayedSecret).adapter.invoke(
    request({ timeoutMs: 20 }),
    context(),
  );
  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "TIMEOUT");
  assert.equal(result.error.source, "PROVIDER");
  assert.equal(delayedSecret.state.resolves, 1);
  assert.equal(delayedSecret.state.consumed, 0);
  assert.equal(upstream.state.calls, 0);
});

test("provider-specific invalid credential shape fails before any network call", async (t) => {
  const upstream = await mockOpenAI(t);
  const secret = secretProvider({ value: "synthetic-non-openai-secret" });
  const result = await invokeProvider(
    adapter(upstream.baseURL, secret).adapter,
    request(),
    context(),
  );
  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "PROVIDER_AUTHENTICATION_FAILED");
  assert.equal(secret.state.resolves, 1);
  assert.equal(secret.state.consumed, 1);
  assert.equal(upstream.state.calls, 0);
  assert.equal(
    JSON.stringify(result).includes("synthetic-non-openai-secret"),
    false,
  );
});

test("OpenAI credential failure does not invoke, disable, or silently select Local", async (t) => {
  const upstream = await mockOpenAI(t);
  let localInvocations = 0;
  const cloud = adapter(
    upstream.baseURL,
    secretProvider({ unavailable: "SECRET_MISSING" }),
  );
  const cloudResult = await invokeProvider(cloud.adapter, request(), context());
  assert.equal(cloudResult.status, "FAILED");
  assert.equal(cloudResult.selection.provider, "OPENAI");
  assert.equal(localInvocations, 0);
  assert.equal(upstream.state.calls, 0);

  const localRequest = {
    ...request(),
    runRef: "run-local-explicit",
    attempt: {
      kind: "INITIAL",
      attemptRef: "attempt-local-explicit",
      ordinal: 1,
    },
    selection: { provider: "LOCAL", model: "local-approved-model" },
    cancellationRef: "cancellation-local-explicit",
    policy: {
      ...policy(),
      capabilityDecision: {
        ...policy().capabilityDecision,
        decisionRef: "decision-local-explicit",
        targetProvider: "LOCAL",
        targetModel: "local-approved-model",
        constraints: {
          localOnly: true,
          noFallback: true,
          minimizedContentRequired: false,
        },
      },
    },
  };
  const local = createFakeProviderAdapter({
    provider: "LOCAL",
    configuration,
    onInvoke: () => {
      localInvocations += 1;
    },
  });
  const localResult = await invokeProvider(local, localRequest, context());
  assert.equal(localResult.status, "COMPLETED");
  assert.equal(localResult.identity.actual.provider, "LOCAL");
  assert.equal(localInvocations, 1);
});

test("one active OpenAI request rejects concurrency without releasing the original slot", async (t) => {
  const upstream = await mockOpenAI(t);
  upstream.state.scenario = "DELAY";
  const current = adapter(upstream.baseURL);
  const first = current.adapter.invoke(
    request({ timeoutMs: 1_000 }),
    context(),
  );
  while (upstream.state.calls === 0)
    await new Promise((resolve) => setImmediate(resolve));
  const busy1 = await current.adapter.invoke(request(), context());
  const busy2 = await current.adapter.invoke(request(), context());
  assert.equal(busy1.status, "FAILED");
  assert.equal(busy1.error.code, "PROVIDER_BUSY");
  assert.equal(busy2.error.code, "PROVIDER_BUSY");
  upstream.state.scenario = "SUCCESS";
  assert.equal((await first).status, "COMPLETED");
  assert.equal(upstream.state.calls, 1);
});

test("configuration permits one model and only loopback fake endpoints", () => {
  const secret = secretProvider();
  const base = {
    configuration,
    candidates: [
      {
        model,
        maxInputBytes: 1_024,
        maxMessages: 8,
        maxMessageBytes: 512,
        maxOutputTokens: 64,
        maxOutputBytes: 1_024,
      },
    ],
    selectedModel: model,
    secretProvider: secret.provider,
    secretReference,
  };
  assert.throws(
    () =>
      new OpenAIResponsesAdapter({
        ...base,
        candidates: [...base.candidates, base.candidates[0]],
      }),
    OpenAIConfigurationError,
  );
  for (const testBaseURL of [
    "https://api.openai.com/v1",
    "http://192.0.2.1/v1",
    `http://${"user"}:${"pass"}@127.0.0.1/v1`,
    "http://127.0.0.1/not-v1",
  ]) {
    assert.throws(
      () => new OpenAIResponsesAdapter({ ...base, testBaseURL }),
      OpenAIConfigurationError,
    );
  }
});

test("provider boundary exposes no browser export, logs, fallback, or client credential path", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.exports["."].browser, null);
  assert.equal(packageJson.dependencies.openai, "7.9.0");
  const source = await readFile(
    new URL("../src/openai.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /console\.|logger|localStorage|sessionStorage/u);
  assert.doesNotMatch(source, /fallback|backup provider|browser|sqlite/iu);
  assert.match(source, /maxRetries: 0/u);
  assert.match(source, /store: false/u);
});
