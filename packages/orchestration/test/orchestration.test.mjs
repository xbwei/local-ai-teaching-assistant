import { conversationForProvider, replyInstruction } from "@laita/contracts";
import { reviewedPolicyRuntimeContract } from "@laita/contracts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseConfiguration } from "@laita/runtime";
import {
  createCapabilityEvaluator,
  createDemoCapabilityContext,
} from "@laita/policy";
import {
  createProviderHealthController,
  createProviderOrchestrator,
} from "../dist/index.js";

const fakeConfiguration = {
  reference: "provider-config-fixture",
  version: "provider-config.v1",
  digest: `sha256:${"a".repeat(64)}`,
};
function createFakeProviderAdapter({
  provider,
  scenario = "SUCCESS",
  output = "synthetic response",
  onInvoke,
}) {
  return {
    provider,
    configuration: fakeConfiguration,
    async invoke(request, context) {
      onInvoke?.(request);
      const cancelled =
        scenario === "CANCEL_AFTER_PARTIAL" || context.signal.aborted;
      if (scenario === "SUCCESS" && !cancelled)
        return {
          contractVersion: "provider-result.v1",
          status: "COMPLETED",
          runRef: request.runRef,
          attemptRef: request.attempt.attemptRef,
          identity: {
            selected: request.selection,
            actual: {
              provider,
              model: { id: request.selection.model, version: "fake.v1" },
            },
          },
          output: { text: output },
          usage: {
            inputTokens: 3,
            outputTokens: 2,
            totalTokens: 5,
            providerReported: false,
          },
          latency: { totalMs: 12 },
          finishReason: "STOP",
          policy: request.policy,
          configuration: request.configuration,
          provenance: {
            adapter: "deterministic-fake.v1",
            runtime: "synthetic",
            generation: request.generation,
            ...(provider === "OPENAI"
              ? {
                  openai: {
                    runtime: "OPENAI_RESPONSES",
                    configuredModel: request.selection.model,
                    selectedModel: request.selection.model,
                    responseModel: request.selection.model,
                    sdk: { name: "openai", version: "1.0.0" },
                    store: false,
                    automaticRetries: 0,
                    sdkLogging: "OFF",
                    usageStatus: "NOT_REPORTED",
                  },
                }
              : {}),
          },
        };
      const code = cancelled
        ? "CANCELLED"
        : scenario === "TIMEOUT"
          ? "TIMEOUT"
          : "PROVIDER_UNAVAILABLE";
      return {
        contractVersion: "provider-result.v1",
        status: cancelled ? "CANCELLED" : "FAILED",
        runRef: request.runRef,
        attemptRef: request.attempt.attemptRef,
        selection: request.selection,
        actual: { provider, model: { id: request.selection.model } },
        error: {
          code,
          source: cancelled ? "CALLER" : "PROVIDER",
          retry: cancelled ? "DO_NOT_RETRY" : "SAME_PROVIDER_ONLY",
          message: "Synthetic failure.",
        },
        latency: { totalMs: 8 },
        policy: request.policy,
        configuration: request.configuration,
      };
    },
    async *stream() {
      throw new Error("Not used by orchestration tests");
    },
  };
}

function foundation(successor = false) {
  const parsed = parseConfiguration(
    readFileSync(
      new URL(
        "../../runtime/examples/openai-demo.example.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(parsed.ok, true);
  if (successor)
    parsed.value.provenance = {
      demoProfileVersion: "demo-profile.v4",
      policyVersion: "demo-policy.v4",
    };
  const evaluator = createCapabilityEvaluator(parsed.value);
  assert.ok(evaluator);
  const context = createDemoCapabilityContext("INSTRUCTOR");
  const health = createProviderHealthController({
    localModels: parsed.value.providers.local.candidates,
    openaiModels: [parsed.value.providers.openai.model],
    selectedLocalModel: parsed.value.providers.local.model,
    selectedOpenAIModel: parsed.value.providers.openai.model,
  });
  health.setStatus("LOCAL", "gemma4:12b-mlx", "READY");
  health.setStatus("LOCAL", "llama3.1:8b", "READY");
  health.setStatus("OPENAI", "gpt-5.6-luna", "READY");
  const controls = () => ({
    emergencyStop: false,
    ...health.capabilityControls(),
  });
  const records = new Map();
  const usage = {
    admit(value) {
      const record = {
        contractVersion: "provider-usage-record.v1",
        runRef: value.runRef,
        interactionRef: value.interactionRef,
        attemptRef: value.attemptRef,
        provider: value.provider,
        model: value.model,
        inputTokens: value.inputTokens,
        outputTokens: value.maxOutputTokens,
        totalTokens: value.inputTokens + value.maxOutputTokens,
        estimatedCostNanoUsd: value.provider === "OPENAI" ? 1234 : null,
        costBasis:
          value.provider === "OPENAI"
            ? "openai-gpt-5.6-luna-estimate.v1"
            : null,
        costRepresentation:
          value.provider === "OPENAI" ? "ESTIMATE_NOT_PROVIDER_BILLING" : null,
        usageBasis: "RESERVED_ESTIMATE",
        policyVersion: value.policyVersion,
        configurationVersion: value.configurationVersion,
        courseRef: value.context.courseRef,
        workflow: value.context.workflow,
        comparison: value.context.comparison,
        outcome: "RESERVED",
        latencyMs: null,
        localResources: null,
        day: "2026-09-04",
        week: "2026-W36",
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
      };
      records.set(value.attemptRef, record);
      return { ok: true, value: record };
    },
    finalize(value) {
      const record = records.get(value.attemptRef);
      if (!record) return { ok: false, code: "NOT_FOUND" };
      Object.assign(record, {
        outcome: value.outcome,
        latencyMs: value.latencyMs,
      });
      return { ok: true, value: record };
    },
  };
  const authorization = {
    authorize(selection, identity) {
      const value = evaluator.authorizeSelection(
        context,
        controls(),
        selection,
        identity,
      );
      return { ok: true, value };
    },
  };
  return {
    parsed: parsed.value,
    evaluator,
    context,
    health,
    usage,
    authorization,
  };
}

function request(identity, overrides = {}) {
  return {
    contractVersion: "provider-run-request.v1",
    clientRequestId: "123e4567-e89b-42d3-a456-426614174000",
    mode: "COMPARE",
    localModel: "gemma4:12b-mlx",
    openaiModel: "gpt-5.6-luna",
    input: { text: "Synthetic bounded request." },
    capabilityIdentity: identity,
    ...overrides,
  };
}
function input(base, value) {
  return {
    request: value,
    sessionRef: "session-123e4567-e89b-42d3-a456-426614174000",
    context: base.context,
    signal: new AbortController().signal,
  };
}

test("health transitions open a bounded breaker and recover through half-open", () => {
  let now = 1000;
  const health = createProviderHealthController({
    localModels: ["local"],
    openaiModels: ["cloud"],
    selectedLocalModel: "local",
    selectedOpenAIModel: "cloud",
    failureThreshold: 2,
    baseBackoffMs: 100,
    maxBackoffMs: 200,
    now: () => now,
  });
  health.setStatus("LOCAL", "local", "READY");
  assert.equal(health.begin("LOCAL", "local").ok, true);
  health.failed("LOCAL", "local", "TEMPORARY_PROVIDER_FAILURE");
  assert.equal(health.snapshot().providers[0].status, "READY");
  assert.equal(health.begin("LOCAL", "local").ok, true);
  health.failed("LOCAL", "local", "TIMEOUT");
  assert.equal(health.snapshot().providers[0].breaker.state, "OPEN");
  assert.equal(health.capabilityControls().local.state, "UNAVAILABLE");
  assert.equal(health.begin("LOCAL", "local").ok, false);
  now += 100;
  assert.equal(health.capabilityControls().local.state, "READY");
  assert.equal(health.begin("LOCAL", "local").ok, true);
  assert.equal(health.snapshot().providers[0].status, "RECOVERING");
  health.succeeded("LOCAL", "local");
  assert.equal(health.snapshot().providers[0].breaker.state, "CLOSED");
  assert.equal(health.snapshot().providers[0].status, "READY");
});

test("half-open cancellation preserves recovery and policy denial cannot brick health", () => {
  let now = 1000;
  const health = createProviderHealthController({
    localModels: ["local"],
    openaiModels: ["cloud"],
    selectedLocalModel: "local",
    selectedOpenAIModel: "cloud",
    failureThreshold: 1,
    baseBackoffMs: 100,
    now: () => now,
  });
  health.setStatus("LOCAL", "local", "READY");
  assert.equal(health.begin("LOCAL", "local").ok, true);
  health.failed("LOCAL", "local", "TIMEOUT");
  now += 100;
  assert.equal(health.begin("LOCAL", "local").ok, true);
  health.failed("LOCAL", "local", "CANCELLED");
  assert.equal(health.snapshot().providers[0].breaker.state, "HALF_OPEN");
  assert.equal(health.capabilityControls().local.state, "READY");
  assert.equal(health.begin("LOCAL", "local").ok, true);

  health.setStatus("OPENAI", "cloud", "READY");
  assert.equal(health.begin("OPENAI", "cloud").ok, true);
  health.failed("OPENAI", "cloud", "POLICY_DENIED");
  assert.equal(health.snapshot().providers[1].status, "READY");
  assert.equal(health.begin("OPENAI", "cloud").ok, true);
});

test("authentication and half-open terminal failures remain explicit and closed", () => {
  let now = 1000;
  const health = createProviderHealthController({
    localModels: ["local"],
    openaiModels: ["cloud"],
    selectedLocalModel: "local",
    selectedOpenAIModel: "cloud",
    failureThreshold: 1,
    baseBackoffMs: 100,
    now: () => now,
  });
  health.setStatus("OPENAI", "cloud", "READY");
  assert.equal(health.begin("OPENAI", "cloud").ok, true);
  health.failed("OPENAI", "cloud", "AUTHENTICATION_FAILED");
  assert.equal(health.snapshot().providers[1].status, "AUTHENTICATION_FAILED");
  assert.equal(health.begin("OPENAI", "cloud").ok, false);

  health.setStatus("LOCAL", "local", "READY");
  assert.equal(health.begin("LOCAL", "local").ok, true);
  health.failed("LOCAL", "local", "TIMEOUT");
  now += 100;
  assert.equal(health.begin("LOCAL", "local").ok, true);
  health.failed("LOCAL", "local", "OVER_QUOTA");
  const local = health.snapshot().providers[0];
  assert.equal(local.breaker.state, "CLOSED");
  assert.equal(local.status, "OVER_QUOTA");
  assert.equal(health.begin("LOCAL", "local").ok, false);
});

test("circuit configuration rejects non-integer and unbounded backoff", () => {
  const options = {
    localModels: ["local"],
    openaiModels: ["cloud"],
    selectedLocalModel: "local",
    selectedOpenAIModel: "cloud",
  };
  for (const override of [
    { baseBackoffMs: Number.NaN },
    { maxBackoffMs: Number.NaN },
    { baseBackoffMs: 1.5 },
    { maxBackoffMs: 30_001 },
  ])
    assert.throws(() =>
      createProviderHealthController({ ...options, ...override }),
    );
});

test("an invocation throw after caller abort stays cancelled and health-ready", async () => {
  const base = foundation();
  const cancellation = new AbortController();
  const local = createFakeProviderAdapter({ provider: "LOCAL" });
  local.invoke = async () => {
    cancellation.abort();
    throw new Error("synthetic private failure");
  };
  const orchestrator = createProviderOrchestrator({
    adapters: {
      LOCAL: local,
      OPENAI: createFakeProviderAdapter({ provider: "OPENAI" }),
    },
    health: base.health,
    authorization: base.authorization,
    usage: base.usage,
    timeoutMs: 5000,
  });
  const result = await orchestrator.execute({
    ...input(
      base,
      request(base.evaluator.identity, {
        mode: "LOCAL",
        openaiModel: undefined,
      }),
    ),
    signal: cancellation.signal,
  });
  assert.equal(result.legs[0].status, "CANCELLED");
  assert.equal(result.legs[0].failure.code, "CANCELLED");
  assert.equal(base.health.snapshot().providers[0].status, "READY");
  assert.equal(
    JSON.stringify(result).includes("synthetic private failure"),
    false,
  );
});

test("accounting finalization failure withholds provider output", async () => {
  const base = foundation();
  base.usage.finalize = () => ({ ok: false, code: "SERVICE_UNAVAILABLE" });
  const orchestrator = createProviderOrchestrator({
    adapters: {
      LOCAL: createFakeProviderAdapter({
        provider: "LOCAL",
        output: "must not escape",
      }),
      OPENAI: createFakeProviderAdapter({ provider: "OPENAI" }),
    },
    health: base.health,
    authorization: base.authorization,
    usage: base.usage,
    timeoutMs: 5000,
  });
  const result = await orchestrator.execute(
    input(
      base,
      request(base.evaluator.identity, {
        mode: "LOCAL",
        openaiModel: undefined,
      }),
    ),
  );
  assert.equal(result.legs[0].failure.code, "INTERNAL_FAILURE");
  assert.equal(result.legs[0].output, undefined);
  assert.equal(JSON.stringify(result).includes("must not escape"), false);
});

test("selected Local model and capability state follow sequential switch progress", () => {
  const health = createProviderHealthController({
    localModels: ["primary", "comparison"],
    openaiModels: ["cloud"],
    selectedLocalModel: "primary",
    selectedOpenAIModel: "cloud",
  });
  health.setStatus("LOCAL", "primary", "READY");
  health.setStatus("LOCAL", "comparison", "READY");
  health.selectModel("LOCAL", "comparison");
  health.setStatus("LOCAL", "comparison", "SWITCHING");
  assert.equal(health.snapshot().providers[0].selectedModel, "comparison");
  assert.equal(health.capabilityControls().local.state, "SWITCHING");
  health.setStatus("LOCAL", "comparison", "READY");
  assert.equal(health.capabilityControls().local.state, "READY");
});

test("Compare returns two independent labeled results and accounting metrics", async () => {
  const base = foundation();
  const orchestrator = createProviderOrchestrator({
    adapters: {
      LOCAL: createFakeProviderAdapter({
        provider: "LOCAL",
        output: "local answer",
      }),
      OPENAI: createFakeProviderAdapter({
        provider: "OPENAI",
        output: "cloud answer",
      }),
    },
    health: base.health,
    authorization: base.authorization,
    usage: base.usage,
    timeoutMs: 5000,
  });
  const result = await orchestrator.execute(
    input(base, request(base.evaluator.identity)),
  );
  assert.equal(result.mode, "COMPARE");
  assert.match(result.comparisonRef, /^comparison-/);
  assert.deepEqual(
    result.legs.map(({ provider, status, output }) => [
      provider,
      status,
      output?.text,
    ]),
    [
      ["LOCAL", "COMPLETED", "local answer"],
      ["OPENAI", "COMPLETED", "cloud answer"],
    ],
  );
  assert.notEqual(result.legs[0].runRef, result.legs[1].runRef);
  assert.equal(
    result.legs[1].metrics.estimatedCost.representation,
    "ESTIMATE_NOT_PROVIDER_BILLING",
  );
});

test("one-side Compare failure stays independent and never invokes a substitute", async () => {
  const base = foundation();
  let localCalls = 0,
    openaiCalls = 0;
  const orchestrator = createProviderOrchestrator({
    adapters: {
      LOCAL: createFakeProviderAdapter({
        provider: "LOCAL",
        scenario: "UNAVAILABLE",
        onInvoke: () => localCalls++,
      }),
      OPENAI: createFakeProviderAdapter({
        provider: "OPENAI",
        output: "independent",
        onInvoke: () => openaiCalls++,
      }),
    },
    health: base.health,
    authorization: base.authorization,
    usage: base.usage,
    timeoutMs: 5000,
  });
  const result = await orchestrator.execute(
    input(base, request(base.evaluator.identity)),
  );
  assert.equal(localCalls, 1);
  assert.equal(openaiCalls, 1);
  assert.equal(result.legs[0].failure.code, "SELECTED_PROVIDER_UNAVAILABLE");
  assert.equal(result.legs[1].output.text, "independent");
  assert.equal(result.legs[1].provider, "OPENAI");
});

test("bounded evidence is sent only as an explicit Local evidence pack", async () => {
  const base = foundation();
  let captured;
  const orchestrator = createProviderOrchestrator({
    adapters: {
      LOCAL: createFakeProviderAdapter({
        provider: "LOCAL",
        onInvoke: (request) => (captured = request),
      }),
      OPENAI: createFakeProviderAdapter({ provider: "OPENAI" }),
    },
    health: base.health,
    authorization: base.authorization,
    usage: base.usage,
    timeoutMs: 5000,
  });
  const value = request(base.evaluator.identity, {
    mode: "LOCAL",
    openaiModel: undefined,
    input: { text: "What is required for IA342 Lab 5?" },
  });
  const result = await orchestrator.execute({
    ...input(base, value),
    evidence: {
      systemInstruction: "Use only the untrusted quoted evidence.",
      prompt: "COURSE EVIDENCE\n[1] bounded public text",
      refs: ["course-source-1"],
    },
  });
  assert.equal(result.legs[0].status, "COMPLETED");
  assert.deepEqual(captured.input.evidenceRefs, ["course-source-1"]);
  assert.deepEqual(
    captured.input.messages.map(({ role }) => role),
    ["SYSTEM", "SYSTEM", "USER", "USER"],
  );
  assert.equal(captured.input.messages[0].content, replyInstruction);
  assert.match(captured.input.messages[1].content, /untrusted quoted evidence/);
  assert.match(captured.input.messages[2].content, /COURSE EVIDENCE/);
  assert.equal(captured.input.messages[3].content, value.input.text);

  captured = undefined;
  const rejected = await orchestrator.execute({
    ...input(base, value),
    evidence: {
      systemInstruction: "bounded",
      prompt: "x".repeat(4097),
      refs: ["course-source-1"],
    },
  });
  assert.equal(rejected.legs[0].failure.code, "EVIDENCE_INVALID");
  assert.equal(captured, undefined);
});

test("stale identity and unavailable selected model prevent every adapter call", async () => {
  const base = foundation();
  let localCalls = 0,
    openaiCalls = 0;
  const orchestrator = createProviderOrchestrator({
    adapters: {
      LOCAL: createFakeProviderAdapter({
        provider: "LOCAL",
        onInvoke: () => localCalls++,
      }),
      OPENAI: createFakeProviderAdapter({
        provider: "OPENAI",
        onInvoke: () => openaiCalls++,
      }),
    },
    health: base.health,
    authorization: base.authorization,
    usage: base.usage,
    timeoutMs: 5000,
  });
  const stale = structuredClone(base.evaluator.identity);
  stale.configuration.digest = `sha256:${"0".repeat(64)}`;
  const denied = await orchestrator.execute(input(base, request(stale)));
  assert.equal(localCalls, 0);
  assert.equal(openaiCalls, 0);
  assert.deepEqual(
    denied.legs.map((leg) => leg.failure.code),
    ["STALE_AUTHORIZATION", "STALE_AUTHORIZATION"],
  );
  const unknown = await orchestrator.execute(
    input(
      base,
      request(base.evaluator.identity, {
        mode: "LOCAL",
        localModel: "unapproved",
        openaiModel: undefined,
      }),
    ),
  );
  assert.equal(unknown.legs[0].failure.code, "SELECTED_MODEL_UNAVAILABLE");
  assert.equal(localCalls, 0);
});

test("loading and busy are explicit and never call the other provider", async () => {
  const base = foundation();
  let localCalls = 0,
    openaiCalls = 0;
  base.health.setStatus("LOCAL", "gemma4:12b-mlx", "LOADING");
  const orchestrator = createProviderOrchestrator({
    adapters: {
      LOCAL: createFakeProviderAdapter({
        provider: "LOCAL",
        onInvoke: () => localCalls++,
      }),
      OPENAI: createFakeProviderAdapter({
        provider: "OPENAI",
        onInvoke: () => openaiCalls++,
      }),
    },
    health: base.health,
    authorization: base.authorization,
    usage: base.usage,
    timeoutMs: 5000,
  });
  const result = await orchestrator.execute(
    input(
      base,
      request(base.evaluator.identity, {
        mode: "LOCAL",
        openaiModel: undefined,
      }),
    ),
  );
  assert.equal(result.legs[0].failure.code, "MODEL_LOADING");
  assert.equal(localCalls, 0);
  assert.equal(openaiCalls, 0);
});

test("Compare eligibility denial rejects both legs before either provider is called", async () => {
  const base = foundation();
  let localCalls = 0,
    openaiCalls = 0;
  base.health.setStatus("OPENAI", "gpt-5.6-luna", "UNAVAILABLE");
  const orchestrator = createProviderOrchestrator({
    adapters: {
      LOCAL: createFakeProviderAdapter({
        provider: "LOCAL",
        onInvoke: () => localCalls++,
      }),
      OPENAI: createFakeProviderAdapter({
        provider: "OPENAI",
        onInvoke: () => openaiCalls++,
      }),
    },
    health: base.health,
    authorization: base.authorization,
    usage: base.usage,
    timeoutMs: 5000,
  });
  const result = await orchestrator.execute(
    input(base, request(base.evaluator.identity)),
  );
  assert.equal(localCalls, 0);
  assert.equal(openaiCalls, 0);
  assert.equal(result.legs[0].failure.code, "POLICY_DENIED");
  assert.equal(result.legs[1].failure.code, "SELECTED_PROVIDER_UNAVAILABLE");
});

test("Compare budget hard stop rejects atomically before provider contact", async () => {
  const base = foundation();
  let calls = 0;
  base.usage.state = () => ({ ok: true, value: "HARD_STOP" });
  const orchestrator = createProviderOrchestrator({
    adapters: {
      LOCAL: createFakeProviderAdapter({
        provider: "LOCAL",
        onInvoke: () => calls++,
      }),
      OPENAI: createFakeProviderAdapter({
        provider: "OPENAI",
        onInvoke: () => calls++,
      }),
    },
    health: base.health,
    authorization: base.authorization,
    usage: base.usage,
    timeoutMs: 5000,
  });
  const result = await orchestrator.execute(
    input(base, request(base.evaluator.identity)),
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    result.legs.map((leg) => leg.failure.code),
    ["OVER_BUDGET", "OVER_BUDGET"],
  );
});

for (const [scenario, expected] of [
  ["TIMEOUT", "TIMEOUT"],
  ["CANCEL_AFTER_PARTIAL", "CANCELLED"],
]) {
  test(`${scenario} is explicit and never invokes OpenAI for a Local request`, async () => {
    const base = foundation();
    let localCalls = 0,
      openaiCalls = 0;
    const orchestrator = createProviderOrchestrator({
      adapters: {
        LOCAL: createFakeProviderAdapter({
          provider: "LOCAL",
          scenario,
          onInvoke: () => localCalls++,
        }),
        OPENAI: createFakeProviderAdapter({
          provider: "OPENAI",
          onInvoke: () => openaiCalls++,
        }),
      },
      health: base.health,
      authorization: base.authorization,
      usage: base.usage,
      timeoutMs: 5000,
    });
    const result = await orchestrator.execute(
      input(
        base,
        request(base.evaluator.identity, {
          mode: "LOCAL",
          openaiModel: undefined,
        }),
      ),
    );
    assert.equal(result.legs[0].failure.code, expected);
    assert.equal(result.legs[0].output, undefined);
    assert.equal(localCalls, 1);
    assert.equal(openaiCalls, 0);
  });
}

test("approved comparison Local model is prepared sequentially before invocation", async () => {
  const base = foundation();
  const order = [];
  const orchestrator = createProviderOrchestrator({
    adapters: {
      LOCAL: createFakeProviderAdapter({
        provider: "LOCAL",
        onInvoke: () => order.push("invoke"),
      }),
      OPENAI: createFakeProviderAdapter({ provider: "OPENAI" }),
    },
    health: base.health,
    authorization: base.authorization,
    usage: base.usage,
    timeoutMs: 5000,
    async prepareLocalModel(model) {
      order.push(`switch:${model}`);
      return { ok: true };
    },
  });
  const result = await orchestrator.execute(
    input(
      base,
      request(base.evaluator.identity, {
        mode: "LOCAL",
        localModel: "llama3.1:8b",
        openaiModel: undefined,
      }),
    ),
  );
  assert.equal(result.legs[0].status, "COMPLETED", JSON.stringify(result));
  assert.deepEqual(order, ["switch:llama3.1:8b", "invoke"]);
});

test("v4 reserves complete server instruction and conversation input before provider admission", async () => {
  const base = foundation(true);
  const seed = reviewedPolicyRuntimeContract.successor.seed.cases[0];
  const text = seed.messages.at(-1).content;
  let called = 0,
    reserved;
  const admit = base.usage.admit;
  let limit = Infinity;
  base.usage.admit = (value) => {
    reserved = value.inputTokens;
    return value.inputTokens > limit
      ? { ok: false, code: "REQUEST_LIMIT" }
      : admit(value);
  };
  const service = createProviderOrchestrator({
    health: base.health,
    authorization: base.authorization,
    usage: base.usage,
    timeoutMs: 1000,
    adapters: {
      LOCAL: createFakeProviderAdapter({ provider: "LOCAL" }),
      OPENAI: createFakeProviderAdapter({
        provider: "OPENAI",
        onInvoke: (r) => {
          called++;
          assert.deepEqual(r.input.messages, [
            { role: "SYSTEM", content: replyInstruction },
            { role: "USER", content: text },
          ]);
        },
      }),
    },
  });
  const req = request(base.evaluator.identity, {
    mode: "OPENAI",
    localModel: undefined,
    input: { text },
  });
  const result = await service.execute(input(base, req));
  assert.equal(result.legs[0].status, "COMPLETED", JSON.stringify(result));
  assert.equal(
    reserved,
    Buffer.byteLength(replyInstruction) + Buffer.byteLength(text) + 64,
  );
  assert.equal(called, 1);
  limit = Math.ceil(Buffer.byteLength(text) / 4);
  const denied = await service.execute(input(base, req));
  assert.equal(denied.legs[0].failure.code, "INPUT_LIMIT");
  assert.equal(called, 1);
});

test("v4 ordinary non-sensitive Owner text reaches explicitly selected Cloud", async () => {
  const base = foundation(true);
  base.context.dataClass = "IDENTITY_MINIMIZED_USER_TEXT";
  let local = 0,
    cloud = 0;
  const service = createProviderOrchestrator({
    health: base.health,
    authorization: base.authorization,
    usage: base.usage,
    timeoutMs: 1000,
    adapters: {
      LOCAL: createFakeProviderAdapter({
        provider: "LOCAL",
        onInvoke: () => {
          local++;
        },
      }),
      OPENAI: createFakeProviderAdapter({
        provider: "OPENAI",
        onInvoke: () => {
          cloud++;
        },
      }),
    },
  });
  const localRequest = request(base.evaluator.identity, {
    mode: "LOCAL",
    openaiModel: undefined,
    input: { text: "Explain a tree." },
  });
  assert.equal(
    (await service.execute(input(base, localRequest))).legs[0].status,
    "COMPLETED",
  );
  const cloudRequest = request(base.evaluator.identity, {
    mode: "OPENAI",
    localModel: undefined,
    input: { text: "Explain a tree." },
  });
  assert.equal(
    (await service.execute(input(base, cloudRequest))).legs[0].status,
    "COMPLETED",
  );
  assert.equal(local, 1);
  assert.equal(cloud, 1);
});

test("Compare projects provider-specific bilingual history and reserves every effective message", async () => {
  const base = foundation(true);
  base.context.dataClass = "IDENTITY_MINIMIZED_USER_TEXT";
  const observed = [],
    reservations = [];
  const admit = base.usage.admit;
  base.usage.admit = (value) => {
    reservations.push(value.inputTokens);
    return admit(value);
  };
  const service = createProviderOrchestrator({
    health: base.health,
    authorization: base.authorization,
    usage: base.usage,
    timeoutMs: 1000,
    adapters: Object.fromEntries(
      ["LOCAL", "OPENAI"].map((provider) => [
        provider,
        createFakeProviderAdapter({
          provider,
          onInvoke: (r) => observed.push(r),
        }),
      ]),
    ),
  });
  const history = [
    { role: "USER", content: "解释树。" },
    { role: "ASSISTANT", provider: "LOCAL", content: "A tree has nodes." },
  ];
  const result = await service.execute(
    input(
      base,
      request(base.evaluator.identity, {
        localModel: "llama3.1:8b",
        input: { text: "请继续，用中文回答。", history },
      }),
    ),
  );
  assert.deepEqual(
    result.legs.map((l) => l.status),
    ["COMPLETED", "COMPLETED"],
  );
  assert.equal(observed[0].selection.model, "llama3.1:8b");
  const expected = ["LOCAL", "OPENAI"].map((provider) => [
    { role: "SYSTEM", content: replyInstruction },
    ...conversationForProvider(history, provider),
    { role: "USER", content: "请继续，用中文回答。" },
  ]);
  assert.deepEqual(
    observed.map((r) => r.input.messages),
    expected,
  );
  assert.deepEqual(
    reservations,
    expected.map((messages) =>
      messages.reduce((sum, m) => sum + Buffer.byteLength(m.content) + 32, 0),
    ),
  );
});

test("reproduced 3865-unit evidence envelope hits real usage admission before accounting or adapter", async () => {
  const { createProviderUsageService } = await import("@laita/policy");
  for (const localModel of ["gemma4:12b-mlx", "llama3.1:8b"]) {
    const base = foundation(true);
    let contacts = 0,
      reserves = 0,
      admission;
    const usage = createProviderUsageService({
      reserve() {
        reserves++;
        assert.fail("oversized input must not enter accounting");
      },
    });
    const service = createProviderOrchestrator({
      health: base.health,
      authorization: base.authorization,
      timeoutMs: 1000,
      usage: {
        admit(value) {
          assert.equal(value.inputTokens, 3865);
          admission = usage.admit(value);
          return admission;
        },
        finalize() {
          assert.fail("no reservation to finalize");
        },
      },
      adapters: {
        LOCAL: createFakeProviderAdapter({
          provider: "LOCAL",
          onInvoke: () => contacts++,
        }),
      },
    });
    const result = await service.execute({
      ...input(
        base,
        request(base.evaluator.identity, {
          mode: "LOCAL",
          localModel,
          input: { text: "what do we do in lab4 of ia340" },
        }),
      ),
      // Synthetic same-byte envelope, not copied course content. The exact public
      // snapshot reproduction and selected-source sizes are recorded in the handoff.
      evidence: {
        systemInstruction: "s".repeat(543),
        prompt: "e".repeat(2954),
        refs: ["course-source-1", "course-source-2", "course-source-3"],
      },
    });
    assert.equal(admission.code, "REQUEST_LIMIT");
    assert.equal(result.legs[0].failure.code, "INPUT_LIMIT");
    assert.equal(result.legs[0].provenance, undefined);
    assert.equal(contacts, 0);
    assert.equal(reserves, 0);
  }
});
