import assert from "node:assert/strict";
import test from "node:test";
import { isCapabilityAvailability } from "@laita/contracts";

const sha = `sha256:${"a".repeat(64)}`;
const safe = () => ({
  contractVersion: "capability-availability.v1",
  decisionRef: "decision-0123456789abcdef01234567",
  identity: {
    policy: {
      runtimeDigest: sha,
      profileVersion: "demo-profile.v2",
      policyVersion: "demo-policy.v2",
      providerPolicyVersion: "demo-provider-eligibility.v2",
      classificationVersion: "data-classification.v1",
      retentionPolicyVersion: "retention-policy.v1",
      gradingBoundaryVersion: "grading-boundary.v1",
    },
    configuration: {
      version: "application-configuration.v2",
      digest: sha,
    },
  },
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
});

test("capability availability contract is closed and version-bound", () => {
  assert.equal(isCapabilityAvailability(safe()), true);
  for (const changed of [
    { ...safe(), contractVersion: "capability-availability.v99" },
    { ...safe(), credential: "synthetic-secret" },
    {
      ...safe(),
      identity: {
        ...safe().identity,
        policy: { ...safe().identity.policy, policyVersion: "unknown.v99" },
      },
    },
    {
      ...safe(),
      identity: {
        ...safe().identity,
        configuration: { ...safe().identity.configuration, digest: "invalid" },
      },
    },
  ])
    assert.equal(isCapabilityAvailability(changed), false);
});

test("provider and mode unions reject mismatched labels, state and structure", () => {
  const local = {
    id: "LOCAL",
    label: "Local",
    state: "LOADING",
    models: [{ id: "synthetic-local-model", label: "Synthetic Local" }],
  };
  const openai = {
    id: "OPENAI",
    label: "OpenAI",
    state: "READY",
    models: [{ id: "synthetic-cloud-model", label: "Synthetic Cloud" }],
  };
  const value = {
    ...safe(),
    providers: [local, openai],
    modes: [{ id: "OPENAI", label: "OpenAI", providers: ["OPENAI"] }],
    guidance: "SELECT_AVAILABLE_MODE",
  };
  assert.equal(isCapabilityAvailability(value), true);
  for (const changed of [
    { ...value, providers: [{ ...local, state: "UNKNOWN" }] },
    { ...value, providers: [{ ...openai, label: "Cloud configuration" }] },
    {
      ...value,
      modes: [{ id: "LOCAL", label: "Compare", providers: ["OPENAI"] }],
    },
    { ...value, providers: [{ ...local, secretReference: "synthetic" }] },
  ])
    assert.equal(isCapabilityAvailability(changed), false);
});
