import assert from "node:assert/strict";
import test from "node:test";
import {
  isBrowserCapability,
  isInputJob,
  isInputBuild,
  isInputSession,
  isTtsMedia,
  inputLimits,
} from "../dist/browser.js";
import { isCapabilityAvailability } from "../dist/capability.js";
const identity = {
  policy: {
    runtimeDigest: `sha256:${"a".repeat(64)}`,
    profileVersion: "demo-profile.v4",
    policyVersion: "demo-policy.v4",
    providerPolicyVersion: "demo-provider-eligibility.v4",
    classificationVersion: "data-classification.v1",
    retentionPolicyVersion: "retention-policy.v1",
    gradingBoundaryVersion: "grading-boundary.v1",
  },
  configuration: {
    version: "application-configuration.v2",
    digest: `sha256:${"b".repeat(64)}`,
  },
};
const safe = {
  contractVersion: "capability-availability.v1",
  decisionRef: "decision-0123456789abcdef01234567",
  identity,
  providers: [
    {
      id: "LOCAL",
      label: "Local",
      state: "READY",
      models: [{ id: "synthetic", label: "Synthetic" }],
    },
  ],
  modes: [{ id: "LOCAL", label: "Local", providers: ["LOCAL"] }],
  guidance: "SELECT_AVAILABLE_MODE",
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
};
test("CSP-safe capability reader agrees on wire shape and rejects ambiguous choices", () => {
  assert.ok(isCapabilityAvailability(safe) && isBrowserCapability(safe));
  for (const key of Object.keys(safe)) {
    const bad = structuredClone(safe);
    delete bad[key];
    assert.equal(isBrowserCapability(bad), false);
    assert.equal(isCapabilityAvailability(bad), false);
  }
  for (const state of [
    "READY",
    "LOADING",
    "SWITCHING",
    "BUSY",
    "UNAVAILABLE",
  ]) {
    const v = structuredClone(safe);
    v.providers[0].state = state;
    assert.ok(isCapabilityAvailability(v) && isBrowserCapability(v));
  }
  const duplicate = structuredClone(safe);
  duplicate.providers.push({ ...duplicate.providers[0], state: "BUSY" });
  assert.equal(isBrowserCapability(duplicate), false);
  const model = structuredClone(safe);
  model.providers[0].models[0].endpoint = "https://invalid.example";
  assert.equal(isBrowserCapability(model), false);
});
test("input wire readers deny malformed handles, fake completion and undeleted transcript", () => {
  const session = {
    contractVersion: "input-session.v1",
    sessionRef: "a".repeat(64),
    limits: inputLimits,
  };
  assert.ok(isInputSession(session));
  assert.equal(
    isInputSession({ ...session, limits: { ...inputLimits, sessionMs: 0 } }),
    false,
  );
  const job = {
    contractVersion: "input-job.v1",
    jobRef: "b".repeat(64),
    sequence: 1,
    state: "REVIEW",
    cleanup: "DELETED",
    transcript: { transcriptRef: "c".repeat(64), text: "Synthetic" },
  };
  assert.ok(isInputJob(job));
  assert.equal(isInputJob({ ...job, cleanup: "PENDING" }), false);
  assert.equal(isInputJob({ ...job, state: "COMPLETED" }), false);
  assert.equal(
    isInputJob({ ...job, transcript: { ...job.transcript, extra: true } }),
    false,
  );
});
test("build and TTS media readers require local identities and opaque WAV handles", () => {
  const build = {
    contractVersion: "input-build.v1",
    commit: "a".repeat(40),
    profileVersion: "demo-profile.v4",
    sttIdentity: "synthetic-stt",
    ttsIdentity: "macos-say/local-bilingual-v1",
  };
  assert.ok(isInputBuild(build));
  assert.equal(
    isInputBuild({ ...build, ttsIdentity: { path: "/tmp/x" } }),
    false,
  );
  const media = {
    contractVersion: "tts-media.v1",
    mediaRef: "a".repeat(64),
    contentType: "audio/wav",
    language: "zh",
    expiresAtEpochSeconds: 1234567890,
  };
  assert.ok(isTtsMedia(media));
  assert.equal(isTtsMedia({ ...media, mediaUrl: "file:///tmp/x" }), false);
  assert.equal(isTtsMedia({ ...media, contentType: "text/html" }), false);
});

test("course limitation notices are valid completions without fabricated provider legs", () => {
  const job = {
    contractVersion: "input-job.v1",
    jobRef: "a".repeat(64),
    sequence: 1,
    state: "COMPLETED",
    cleanup: "NOT_REQUIRED",
    result: {
      contractVersion: "provider-run-result.v1",
      interactionRef: "interaction-123e4567-e89b-42d3-a456-426614174000",
      mode: "LOCAL",
      legs: [],
      grounding: { status: "EVIDENCE_INPUT_LIMIT", course: "IA340" },
    },
  };
  for (const mode of ["LOCAL", "OPENAI", "COMPARE"]) {
    const notice = structuredClone(job);
    notice.result.mode = mode;
    if (mode !== "LOCAL") notice.result.grounding.status = "LOCAL_ONLY";
    assert.equal(isInputJob(notice), true);
  }
  for (const grounding of [
    undefined,
    { status: "GROUNDED", course: "IA340" },
    { status: "UNKNOWN", course: "IA340" },
  ]) {
    const malformed = structuredClone(job);
    malformed.result.grounding = grounding;
    assert.equal(isInputJob(malformed), false);
  }
});
