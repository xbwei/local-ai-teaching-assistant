import assert from "node:assert/strict";
import test from "node:test";

import {
  isProviderOutcome,
  isProviderRequest,
  isProviderStreamEvent,
  reviewedPolicyRuntimeContract,
} from "@laita/contracts";
import {
  createPolicyDeniedOutcome,
  invokeProvider,
  ProviderContractError,
  streamProvider,
} from "../dist/index.js";
import {
  createFakeProviderAdapter,
  runProviderAdapterContractSuite,
} from "../dist/test-support.js";

const sha = `sha256:${"a".repeat(64)}`;

function policy(
  provider = "LOCAL",
  model = "local-approved-model",
  allowed = true,
  deniedReason = "LOCAL_ONLY_DATA",
) {
  return {
    contractVersion: "provider-policy-decision.v1",
    providerPolicyVersion: "provider-eligibility.v1",
    capabilityDecision: {
      contractVersion: "capability-decision.v1",
      decisionRef: `decision-${provider.toLowerCase()}-fixture`,
      evaluatedContextDigest: sha,
      policyVersion: "teaching-policy.v1",
      classificationVersion: "data-classification.v1",
      retentionPolicyVersion: "retention-policy.v1",
      gradingBoundaryVersion: "grading-boundary.v1",
      targetProvider: provider,
      targetModel: model,
      allowed,
      reasonCodes: allowed ? ["EXPLICIT_ALLOW"] : [deniedReason],
      constraints: {
        localOnly: !allowed,
        noFallback: true,
        minimizedContentRequired: provider === "OPENAI",
      },
      recheckOn: ["PROVIDER_OR_MODEL_CHANGE", "POLICY_VERSION_CHANGE"],
    },
  };
}

function request(provider = "LOCAL", model = "local-approved-model") {
  return {
    contractVersion: "provider-request.v1",
    runRef: `run-${provider.toLowerCase()}-1`,
    attempt: {
      kind: "INITIAL",
      attemptRef: `attempt-${provider.toLowerCase()}-1`,
      ordinal: 1,
    },
    selection: { provider, model },
    input: { messages: [{ role: "USER", content: "Synthetic prompt" }] },
    generation: { maxOutputTokens: 32, temperature: 0 },
    timeoutMs: 1_000,
    cancellationRef: `cancellation-${provider.toLowerCase()}-1`,
    policy: policy(provider, model),
    configuration: {
      reference: "provider-config-fixture",
      version: "provider-config.v1",
      digest: sha,
    },
  };
}

const context = () => ({ signal: new AbortController().signal });

test("workspace consumes the reviewed policy source with no-fallback provenance", () => {
  assert.equal(reviewedPolicyRuntimeContract.identity.fallback, "PROHIBITED");
  assert.equal(
    reviewedPolicyRuntimeContract.provenance.contractVersion,
    "policy-runtime-link.v1",
  );
  assert.match(
    reviewedPolicyRuntimeContract.provenance.sourceDigest,
    /^sha256:/,
  );
  assert.equal(
    reviewedPolicyRuntimeContract.capabilityDecisionFixtures.fixtureVersion,
    "capability-decision-fixtures.v1",
  );
});

test("provider request accepts only the exact generated demo policy identity", () => {
  const current = request("LOCAL", "gemma4:12b-mlx");
  const identity = reviewedPolicyRuntimeContract.demoIdentity;
  current.policy.providerPolicyVersion = identity.providerPolicyVersion;
  Object.assign(current.policy.capabilityDecision, {
    policyVersion: identity.policyVersion,
    classificationVersion: identity.classificationVersion,
    retentionPolicyVersion: identity.retentionPolicyVersion,
    gradingBoundaryVersion: identity.gradingBoundaryVersion,
  });
  assert.equal(isProviderRequest(current), true);
  current.policy.capabilityDecision.policyVersion = "demo-policy.v999";
  assert.equal(isProviderRequest(current), false);
});

test("course evidence references are bounded and Local-only at the provider contract", () => {
  const local = request();
  local.input.evidenceRefs = ["course-source-1", "course-source-2"];
  assert.equal(isProviderRequest(local), true);
  for (const invalid of [
    [],
    ["course-source-1", "course-source-1"],
    ["course-source-4"],
    [
      "course-source-1",
      "course-source-2",
      "course-source-3",
      "course-source-4",
    ],
  ]) {
    local.input.evidenceRefs = invalid;
    assert.equal(isProviderRequest(local), false);
  }
  const cloud = request("OPENAI", "cloud-approved-model");
  cloud.input.evidenceRefs = ["course-source-1"];
  assert.equal(isProviderRequest(cloud), false);
});

test("Local and OpenAI fake adapters share non-streaming and streaming semantics", async () => {
  for (const [provider, model] of [
    ["LOCAL", "local-approved-model"],
    ["OPENAI", "cloud-approved-model"],
  ]) {
    const current = request(provider, model);
    await runProviderAdapterContractSuite({
      request: current,
      context,
      expectedOutput: "shared result",
      createAdapter: (scenario) =>
        createFakeProviderAdapter({
          provider,
          scenario,
          output: "shared result",
        }),
    });
    const adapter = createFakeProviderAdapter({
      provider,
      output: "shared result",
    });
    const result = await invokeProvider(adapter, current, context());
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.identity.actual.provider, provider);
    assert.equal(result.identity.actual.model.id, model);
    const events = [];
    for await (const event of streamProvider(adapter, current, context())) {
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
    assert.equal(events.at(-1).result.output.text, result.output.text);
  }
});

test("normalized fake failures remain distinct", async () => {
  const cases = new Map([
    ["UNAVAILABLE", "PROVIDER_UNAVAILABLE"],
    ["BUSY", "PROVIDER_BUSY"],
    ["TIMEOUT", "TIMEOUT"],
    ["RATE_LIMITED", "RATE_LIMITED"],
    ["QUOTA_EXCEEDED", "QUOTA_EXCEEDED"],
    ["AUTHENTICATION_FAILED", "PROVIDER_AUTHENTICATION_FAILED"],
    ["MALFORMED_RESPONSE", "MALFORMED_PROVIDER_RESPONSE"],
    ["INTERNAL_FAILURE", "INTERNAL_PROVIDER_FAILURE"],
  ]);
  for (const [scenario, code] of cases) {
    const result = await invokeProvider(
      createFakeProviderAdapter({ provider: "LOCAL", scenario }),
      request(),
      context(),
    );
    assert.equal(result.status, "FAILED");
    assert.equal(result.error.code, code);
  }
});

test("partial output followed by cancellation is never trusted success", async () => {
  const events = [];
  for await (const event of streamProvider(
    createFakeProviderAdapter({
      provider: "LOCAL",
      scenario: "CANCEL_AFTER_PARTIAL",
    }),
    request(),
    context(),
  )) {
    events.push(event);
  }
  const terminal = events.at(-1);
  assert.equal(terminal.type, "CANCELLED");
  assert.deepEqual(terminal.result.partialOutput, {
    text: "partial",
    trusted: false,
  });
});

test("pre-cancelled invocation returns explicit cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await invokeProvider(
    createFakeProviderAdapter({ provider: "LOCAL" }),
    request(),
    { signal: controller.signal },
  );
  assert.equal(result.status, "CANCELLED");
  assert.equal(result.error.code, "CANCELLED");
  assert.equal(result.error.source, "CALLER");
});

test("Local failure neither invokes nor authorizes Cloud", async () => {
  let cloudInvocations = 0;
  const localResult = await invokeProvider(
    createFakeProviderAdapter({ provider: "LOCAL", scenario: "UNAVAILABLE" }),
    request(),
    context(),
  );
  createFakeProviderAdapter({
    provider: "OPENAI",
    onInvoke: () => {
      cloudInvocations += 1;
    },
  });
  assert.equal(localResult.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(localResult.error.retry, "SAME_PROVIDER_ONLY");
  assert.equal(cloudInvocations, 0);

  await assert.rejects(
    invokeProvider(
      createFakeProviderAdapter({ provider: "OPENAI" }),
      request(),
      context(),
    ),
    ProviderContractError,
  );
});

test("a provider change requires a new explicit run and matching decision", async () => {
  const retry = structuredClone(request());
  retry.attempt = {
    kind: "SAME_PROVIDER_RETRY",
    attemptRef: "attempt-local-2",
    ordinal: 2,
    previousAttemptRef: "attempt-local-1",
    previousSelection: { provider: "LOCAL", model: "local-approved-model" },
  };
  assert.equal(isProviderRequest(retry), true);
  retry.selection = { provider: "OPENAI", model: "cloud-approved-model" };
  assert.equal(isProviderRequest(retry), false);

  const cloud = request("OPENAI", "cloud-approved-model");
  cloud.runRef = "run-cloud-explicit-rerun";
  cloud.attempt = {
    kind: "EXPLICIT_PROVIDER_RERUN",
    attemptRef: "attempt-cloud-explicit-1",
    ordinal: 1,
    parentRun: {
      runRef: "run-local-1",
      selection: { provider: "LOCAL", model: "local-approved-model" },
    },
  };
  assert.equal(isProviderRequest(cloud), true);
});

test("fallback and backup routing directives are rejected at runtime", () => {
  for (const mutation of [
    { fallbackProvider: "OPENAI" },
    { routing: { backupProvider: "OPENAI" } },
    { preferredProvider: "LOCAL" },
  ]) {
    assert.equal(isProviderRequest({ ...request(), ...mutation }), false);
  }
});

test("routing inspection handles cyclic and deeply nested input", () => {
  const cyclic = request();
  cyclic.metadata = {};
  cyclic.metadata.self = cyclic.metadata;
  assert.doesNotThrow(() => isProviderRequest(cyclic));
  assert.equal(isProviderRequest(cyclic), true);

  cyclic.metadata.routing = { backupProvider: "OPENAI" };
  assert.equal(isProviderRequest(cyclic), false);

  const deeplyNested = request();
  let cursor = (deeplyNested.metadata = {});
  for (let depth = 0; depth < 20_000; depth += 1) {
    cursor = cursor.next = {};
  }
  assert.doesNotThrow(() => isProviderRequest(deeplyNested));
  assert.equal(isProviderRequest(deeplyNested), true);
});

test("stale policy and malformed configuration versions fail closed", () => {
  const stale = structuredClone(request());
  stale.policy.capabilityDecision.policyVersion = "teaching-policy.v999";
  assert.equal(isProviderRequest(stale), false);
  const malformed = structuredClone(request());
  malformed.configuration.version = "unknown";
  assert.equal(isProviderRequest(malformed), false);
});

test("syntactically valid but unknown configuration identity fails closed", async () => {
  const unknown = structuredClone(request());
  unknown.configuration.version = "provider-config.v999";
  await assert.rejects(
    invokeProvider(
      createFakeProviderAdapter({ provider: "LOCAL" }),
      unknown,
      context(),
    ),
    /configuration identity is unknown or stale/,
  );
});

test("structurally equal configuration identity is independent of key order", async () => {
  const current = request();
  const reordered = {
    digest: current.configuration.digest,
    version: current.configuration.version,
    reference: current.configuration.reference,
  };
  const result = await invokeProvider(
    createFakeProviderAdapter({ provider: "LOCAL", configuration: reordered }),
    current,
    context(),
  );
  assert.equal(result.status, "COMPLETED");
});

test("policy denial is separate and does not invoke an adapter", () => {
  let invocations = 0;
  createFakeProviderAdapter({
    provider: "OPENAI",
    onInvoke: () => {
      invocations += 1;
    },
  });
  const denied = createPolicyDeniedOutcome({
    runRef: "run-cloud-denied",
    attemptRef: "attempt-cloud-denied",
    selection: { provider: "OPENAI", model: "cloud-approved-model" },
    policy: policy("OPENAI", "cloud-approved-model", false),
    configuration: request().configuration,
  });
  assert.equal(denied.error.code, "POLICY_DENIED");
  assert.equal(denied.error.source, "POLICY");
  assert.equal(invocations, 0);
  for (const [reason, code] of [
    ["OVER_BUDGET", "BUDGET_EXCEEDED"],
    ["QUOTA_UNAVAILABLE", "QUOTA_EXCEEDED"],
  ]) {
    const constrained = createPolicyDeniedOutcome({
      runRef: `run-cloud-${reason.toLowerCase()}`,
      attemptRef: `attempt-cloud-${reason.toLowerCase()}`,
      selection: { provider: "OPENAI", model: "cloud-approved-model" },
      policy: policy("OPENAI", "cloud-approved-model", false, reason),
      configuration: request().configuration,
    });
    assert.equal(constrained.error.code, code);
    assert.equal(constrained.error.source, "POLICY");
  }
});

test("malformed policy-denial inputs fail with a bounded contract error", () => {
  for (const malformed of [
    null,
    {},
    { policy: {} },
    { policy: { capabilityDecision: {} }, selection: {} },
  ]) {
    assert.throws(
      () => createPolicyDeniedOutcome(malformed),
      ProviderContractError,
    );
  }
});

test("success with substituted or missing provenance is rejected", async () => {
  const current = request();
  const good = createFakeProviderAdapter({ provider: "LOCAL" });
  const substituted = {
    provider: "LOCAL",
    configuration: good.configuration,
    async invoke(input, execution) {
      const result = await good.invoke(input, execution);
      result.identity.actual.provider = "OPENAI";
      return result;
    },
    stream: good.stream,
  };
  await assert.rejects(
    invokeProvider(substituted, current, context()),
    ProviderContractError,
  );
});

test("unknown error codes and contradictory cancellation states are rejected", async () => {
  const failed = await invokeProvider(
    createFakeProviderAdapter({ provider: "LOCAL", scenario: "UNAVAILABLE" }),
    request(),
    context(),
  );
  assert.equal(
    isProviderOutcome({
      ...failed,
      error: { ...failed.error, code: "GENERIC_500" },
    }),
    false,
  );
  assert.equal(
    isProviderOutcome({
      ...failed,
      status: "CANCELLED",
    }),
    false,
  );
});

test("malformed nested provenance fails closed without throwing", async () => {
  const current = request();
  const success = await invokeProvider(
    createFakeProviderAdapter({ provider: "LOCAL" }),
    current,
    context(),
  );
  const failed = await invokeProvider(
    createFakeProviderAdapter({ provider: "LOCAL", scenario: "UNAVAILABLE" }),
    current,
    context(),
  );
  for (const malformed of [
    { ...success, provenance: { adapter: "synthetic" } },
    { ...success, identity: { selected: current.selection } },
    {
      ...success,
      identity: { selected: current.selection, actual: { provider: "LOCAL" } },
    },
    { ...failed, actual: { provider: "LOCAL" } },
    { ...failed, actual: null },
    { ...failed, partialOutput: null },
  ]) {
    assert.doesNotThrow(() => isProviderOutcome(malformed));
    assert.equal(isProviderOutcome(malformed), false);
  }

  for (const identity of [
    { selected: current.selection },
    { selected: current.selection, actual: { provider: "LOCAL" } },
  ]) {
    const malformedEvent = {
      contractVersion: "provider-stream-event.v1",
      runRef: current.runRef,
      attemptRef: current.attempt.attemptRef,
      sequence: 0,
      type: "STARTED",
      identity,
    };
    assert.doesNotThrow(() => isProviderStreamEvent(malformedEvent));
    assert.equal(isProviderStreamEvent(malformedEvent), false);
  }
});
