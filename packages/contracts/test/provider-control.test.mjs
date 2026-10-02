import assert from "node:assert/strict";
import test from "node:test";
import {
  validConversation,
  isProviderHealthSnapshot,
  isProviderRunRequest,
  isProviderRunResult,
} from "../dist/index.js";

const identity = {
  policy: {
    runtimeDigest: `sha256:${"a".repeat(64)}`,
    profileVersion: "demo-profile.v2",
    policyVersion: "demo-policy.v2",
    providerPolicyVersion: "demo-provider-eligibility.v2",
    classificationVersion: "data-classification.v1",
    retentionPolicyVersion: "retention-policy.v1",
    gradingBoundaryVersion: "grading-boundary.v1",
  },
  configuration: {
    version: "application-configuration.v2",
    digest: `sha256:${"b".repeat(64)}`,
  },
};
const request = {
  contractVersion: "provider-run-request.v1",
  clientRequestId: "123e4567-e89b-42d3-a456-426614174000",
  mode: "COMPARE",
  localModel: "gemma4:12b-mlx",
  openaiModel: "gpt-5.6-luna",
  input: { text: "Synthetic comparison prompt." },
  capabilityIdentity: identity,
};

test("provider run request is closed, bounded, and mode-specific", () => {
  assert.equal(isProviderRunRequest(request), true);
  assert.equal(
    isProviderRunRequest({ ...request, endpoint: "http://private" }),
    false,
  );
  assert.equal(
    isProviderRunRequest({ ...request, input: { text: "x".repeat(8193) } }),
    false,
  );
  assert.equal(
    isProviderRunRequest({
      ...request,
      capabilityIdentity: { ...identity, credential: "secret" },
    }),
    false,
  );
  assert.equal(
    isProviderRunRequest({ ...request, mode: "LOCAL", openaiModel: undefined }),
    true,
  );
  assert.equal(
    isProviderRunRequest({ ...request, mode: "OPENAI", localModel: undefined }),
    true,
  );
  assert.equal(isProviderRunRequest({ ...request, mode: "LOCAL" }), false);
});

test("provider run request rejects credential and routing-shaped fields", () => {
  assert.equal(isProviderRunRequest({ ...request, apiKey: "secret" }), false);
  assert.equal(
    isProviderRunRequest({ ...request, fallbackProvider: "OPENAI" }),
    false,
  );
  assert.equal(
    isProviderRunRequest({
      ...request,
      input: { text: "ok", studentId: "person" },
    }),
    false,
  );
});

test("course grounding results bind bounded excerpts to one exact public snapshot", () => {
  const commit = "c".repeat(40);
  const source = {
    course: "IA342",
    repository: "JMU-Data/IA342",
    commit,
    path: "docs/assignments/lab-5/index.md",
    section: "Submission",
    url: `https://github.com/JMU-Data/IA342/blob/${commit}/docs/assignments/lab-5/index.md#submission`,
    excerpt: "There is no Canvas submission for this lab.",
  };
  const notice = {
    contractVersion: "provider-run-result.v1",
    interactionRef: "interaction-123e4567-e89b-42d3-a456-426614174010",
    mode: "OPENAI",
    legs: [],
    grounding: { status: "LOCAL_ONLY", course: "IA342" },
  };
  assert.equal(isProviderRunResult(notice), true);
  assert.equal(
    isProviderRunResult({
      ...notice,
      legs: [
        {
          runRef: "run-123e4567-e89b-42d3-a456-426614174011",
          provider: "OPENAI",
        },
      ],
    }),
    false,
  );

  const grounded = {
    contractVersion: "provider-run-result.v1",
    interactionRef: "interaction-123e4567-e89b-42d3-a456-426614174012",
    mode: "LOCAL",
    legs: [
      {
        runRef: "run-123e4567-e89b-42d3-a456-426614174013",
        provider: "LOCAL",
        model: "gemma4:12b-mlx",
        status: "COMPLETED",
        output: { text: "bounded answer" },
        provenance: {
          actualProvider: "LOCAL",
          actualModel: "gemma4:12b-mlx",
          adapter: "fake",
        },
        metrics: { latencyMs: 1 },
      },
    ],
    grounding: {
      status: "GROUNDED",
      course: "IA342",
      snapshot: commit,
      sources: [source],
    },
  };
  assert.equal(isProviderRunResult(grounded), true);
  assert.equal(
    isProviderRunResult({
      ...grounded,
      grounding: {
        ...grounded.grounding,
        sources: [
          {
            ...source,
            path: "docs/assignments/private-material/index.md",
            url: `https://github.com/JMU-Data/IA342/blob/${commit}/docs/assignments/private-material/index.md#submission`,
          },
        ],
      },
    }),
    false,
  );
  assert.equal(
    isProviderRunResult({
      ...grounded,
      grounding: {
        ...grounded.grounding,
        sources: [{ ...source, path: "../../private.md" }],
      },
    }),
    false,
  );
  assert.equal(
    isProviderRunResult({
      ...grounded,
      grounding: {
        ...grounded.grounding,
        sources: [{ ...source, excerpt: "界".repeat(301) }],
      },
    }),
    false,
  );
});

test("health and result projections reject nested private or substituted fields", () => {
  const health = {
    contractVersion: "provider-health.v1",
    revision: 1,
    providers: [
      {
        provider: "LOCAL",
        status: "READY",
        selectedModel: "gemma4:12b-mlx",
        models: [{ model: "gemma4:12b-mlx", status: "READY" }],
        breaker: { state: "CLOSED", consecutiveFailures: 0, retryAfterMs: 0 },
      },
      {
        provider: "OPENAI",
        status: "UNAVAILABLE",
        selectedModel: "gpt-5.6-luna",
        models: [{ model: "gpt-5.6-luna", status: "UNAVAILABLE" }],
        breaker: { state: "CLOSED", consecutiveFailures: 0, retryAfterMs: 0 },
      },
    ],
  };
  assert.equal(isProviderHealthSnapshot(health), true);
  assert.equal(
    isProviderHealthSnapshot({
      ...health,
      providers: [
        {
          ...health.providers[0],
          selectedModel: "missing-approved-model",
        },
        health.providers[1],
      ],
    }),
    false,
  );
  assert.equal(
    isProviderHealthSnapshot({
      ...health,
      providers: [
        { ...health.providers[0], credential: "secret" },
        health.providers[1],
      ],
    }),
    false,
  );
  const result = {
    contractVersion: "provider-run-result.v1",
    interactionRef: "interaction-123e4567-e89b-42d3-a456-426614174001",
    mode: "LOCAL",
    legs: [
      {
        runRef: "run-123e4567-e89b-42d3-a456-426614174002",
        provider: "LOCAL",
        model: "gemma4:12b-mlx",
        status: "COMPLETED",
        output: { text: "safe" },
        provenance: {
          actualProvider: "LOCAL",
          actualModel: "gemma4:12b-mlx",
          adapter: "fake",
        },
        metrics: { latencyMs: 1 },
      },
    ],
  };
  assert.equal(isProviderRunResult(result), true);
  assert.equal(
    isProviderRunResult({
      ...result,
      legs: [
        {
          ...result.legs[0],
          provenance: {
            ...result.legs[0].provenance,
            actualModel: "substitute",
          },
        },
      ],
    }),
    false,
  );
  assert.equal(
    isProviderRunResult({
      ...result,
      legs: [
        {
          ...result.legs[0],
          metrics: {
            latencyMs: 1,
            usage: { providerReported: false, credential: "secret" },
          },
        },
      ],
    }),
    false,
  );
  assert.equal(
    isProviderRunResult({
      ...result,
      legs: [
        {
          ...result.legs[0],
          metrics: {
            latencyMs: 1,
            usage: {
              inputTokens: 2,
              cachedInputTokens: 3,
              outputTokens: 1,
              totalTokens: 3,
              providerReported: true,
            },
          },
        },
      ],
    }),
    false,
  );
});

test("conversation history requires provider ownership and enforces each branch's bounds", () => {
  const user = { role: "USER", content: "Question" };
  const local = { role: "ASSISTANT", provider: "LOCAL", content: "Local only" };
  const cloud = {
    role: "ASSISTANT",
    provider: "OPENAI",
    content: "Cloud only",
  };
  const turns = Array.from({ length: 3 }, () => [user, local, cloud]).flat();
  assert.equal(validConversation("Next", turns), true); // 9 stored, 6 per leg
  assert.equal(validConversation("Next", [...turns, user]), false);
  assert.equal(
    validConversation("Next", [
      user,
      { role: "ASSISTANT", content: "Legacy combined answer" },
    ]),
    false,
  );
  assert.equal(
    validConversation("Next", [{ ...local, provider: "UNKNOWN" }]),
    false,
  );
  assert.equal(
    validConversation("Next", [{ ...user, provider: "LOCAL" }]),
    false,
  );
  assert.equal(
    validConversation("Next", [{ ...local, hidden: "peer answer" }]),
    false,
  );
  assert.equal(
    validConversation("Q", [
      { ...local, content: "x".repeat(2799) },
      { ...cloud, content: "y".repeat(2799) },
    ]),
    true,
  );
  assert.equal(
    validConversation("Q", [{ ...local, content: "x".repeat(2800) }, cloud]),
    false,
  );
  assert.equal(
    validConversation("Q", [local, { ...cloud, content: "界".repeat(934) }]),
    false,
  );
});
