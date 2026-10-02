import assert from "node:assert/strict";
import test from "node:test";
import {
  isProviderUsageSummary,
  isUsageAdmissionRequest,
  isUsageReconciliation,
  isUsageTerminalUpdate,
} from "../dist/index.js";

const id = "00000000-0000-4000-8000-000000000001";
const request = {
  contractVersion: "provider-usage-admission.v1",
  runRef: `run-${id}`,
  interactionRef: `interaction-${id}`,
  attemptRef: `attempt-${id}`,
  sessionRef: `session-${id}`,
  provider: "OPENAI",
  model: "gpt-5.6-luna",
  inputTokens: 1,
  maxOutputTokens: 1,
  policyVersion: "instructor-policy.v1",
  configurationVersion: "openai-demo.v1",
  context: {
    courseRef: "course-synthetic-demo",
    workflow: "COURSE_QA",
    comparison: false,
  },
};

test("usage admission is random-reference, allowlist and additional-property closed", () => {
  assert.equal(isUsageAdmissionRequest(request), true);
  assert.equal(
    isUsageAdmissionRequest({ ...request, model: "client-selected-model" }),
    false,
  );
  assert.equal(
    isUsageAdmissionRequest({ ...request, estimatedCostNanoUsd: 0 }),
    false,
  );
  assert.equal(
    isUsageAdmissionRequest({ ...request, runRef: "run-stable-student-id" }),
    false,
  );
});

test("terminal and reconciliation usage reject private and inconsistent metadata", () => {
  const terminal = {
    contractVersion: "provider-usage-terminal.v1",
    attemptRef: request.attemptRef,
    outcome: "COMPLETED",
    providerContact: "MAY_HAVE_OCCURRED",
    usage: {
      providerReported: true,
      inputTokens: 2,
      cachedInputTokens: 1,
      outputTokens: 3,
      totalTokens: 5,
    },
  };
  assert.equal(isUsageTerminalUpdate(terminal), true);
  assert.equal(
    isUsageTerminalUpdate({ ...terminal, prompt: "private" }),
    false,
  );
  assert.equal(
    isUsageTerminalUpdate({
      ...terminal,
      outcome: "CANCELLED",
      providerContact: "NOT_STARTED",
    }),
    false,
  );
  assert.equal(
    isUsageTerminalUpdate({
      contractVersion: "provider-usage-terminal.v1",
      attemptRef: request.attemptRef,
      outcome: "CANCELLED",
      providerContact: "NOT_STARTED",
    }),
    true,
  );
  assert.equal(
    isUsageTerminalUpdate({
      ...terminal,
      localResources: { status: "MEASURED", credential: "private" },
    }),
    false,
  );
  const reconciliation = {
    contractVersion: "provider-usage-reconciliation.v1",
    attemptRef: request.attemptRef,
    usage: terminal.usage,
  };
  assert.equal(isUsageReconciliation(reconciliation), true);
  assert.equal(
    isUsageReconciliation({
      ...reconciliation,
      usage: { ...terminal.usage, totalTokens: 99 },
    }),
    false,
  );
});

test("protected summary contract is aggregate-only and labels estimates", () => {
  const summary = {
    contractVersion: "provider-usage-summary.v1",
    asOf: "2026-09-05T12:00:00.000Z",
    policyVersion: "provider-usage-policy.v1",
    costRepresentation: "ESTIMATE_NOT_PROVIDER_BILLING",
    providers: [
      {
        provider: "LOCAL",
        state: "AVAILABLE",
        dailyRequests: 1,
        weeklyTokens: 2,
        estimatedCostNanoUsd: null,
        completed: 1,
        failed: 0,
        cancelled: 0,
        timedOut: 0,
        missingUsage: 0,
        averageLatencyMs: 10,
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
        dailyRequests: 1,
        weeklyTokens: 2,
        estimatedCostNanoUsd: 100,
        completed: 1,
        failed: 0,
        cancelled: 0,
        timedOut: 0,
        missingUsage: 0,
        averageLatencyMs: 20,
        localMemoryPressure: null,
      },
    ],
    comparison: {
      dailyRequests: 0,
      weeklyEstimatedCostNanoUsd: 0,
      state: "AVAILABLE",
    },
  };
  assert.equal(isProviderUsageSummary(summary), true);
  for (const privateField of [
    "credential",
    "prompt",
    "response",
    "studentIdentity",
    "ip",
    "billingAccount",
  ])
    assert.equal(
      isProviderUsageSummary({ ...summary, [privateField]: "private" }),
      false,
    );
  assert.equal(
    isProviderUsageSummary({
      ...summary,
      costRepresentation: "PROVIDER_BILLING_TRUTH",
    }),
    false,
  );
});
