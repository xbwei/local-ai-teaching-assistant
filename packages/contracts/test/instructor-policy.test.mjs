import assert from "node:assert/strict";
import test from "node:test";
import {
  isInstructorPolicyDocument,
  isInstructorPolicyEmergencyDisable,
  isInstructorPolicyMutation,
  isInstructorPolicyPreviewRequest,
  isInstructorPolicyRollback,
} from "../dist/index.js";

const policy = () => ({
  contractVersion: "instructor-policy.v1",
  cloudEnabled: true,
  emergencyCloudDisabled: false,
  schedule: {
    timeZone: "America/New_York",
    startsAt: "2026-09-04T08:00:00-04:00",
    endsAt: "2026-09-04T17:00:00-04:00",
  },
  eligibility: {
    courseRefs: ["course-synthetic-demo"],
    accessClasses: ["INSTRUCTOR"],
    workflows: ["COURSE_QA", "CODING_COACH"],
    learningModes: ["DIRECT_EXPLANATION"],
    inputTypes: ["TEXT"],
    dataClasses: ["IDENTITY_FREE_USER_TEXT"],
  },
  models: {
    local: ["gemma4:12b-mlx", "llama3.1:8b"],
    activeLocal: "gemma4:12b-mlx",
    openai: ["gpt-5.6-luna"],
  },
  comparison: {
    enabled: true,
    courseRef: "course-synthetic-demo",
    moduleRef: "module-fixed-comparison",
    workflow: "COURSE_QA",
    learningMode: "DIRECT_EXPLANATION",
    inputType: "TEXT",
    dataClass: "IDENTITY_FREE_USER_TEXT",
    maxInputCharacters: 8192,
  },
});

test("instructor policy and mutations are closed, allowlisted and credential-free", () => {
  assert.equal(isInstructorPolicyDocument(policy()), true);
  const digest = "sha256:" + "a".repeat(64);
  assert.equal(
    isInstructorPolicyPreviewRequest({
      contractVersion: "instructor-policy-preview-request.v1",
      expectedVersion: 1,
      policy: policy(),
    }),
    true,
  );
  assert.equal(
    isInstructorPolicyMutation({
      contractVersion: "instructor-policy-mutation.v1",
      expectedVersion: 1,
      previewDigest: digest,
      policy: policy(),
    }),
    true,
  );
  for (const unsafe of [
    { ...policy(), credential: "synthetic-secret" },
    {
      ...policy(),
      models: { ...policy().models, openai: ["gpt-arbitrary"] },
    },
    {
      ...policy(),
      models: { ...policy().models, local: ["local-arbitrary"] },
    },
    {
      ...policy(),
      comparison: { ...policy().comparison, maxInputCharacters: 8193 },
    },
  ])
    assert.equal(isInstructorPolicyDocument(unsafe), false);
});

test("rollback and emergency requests accept only an expected version", () => {
  assert.equal(
    isInstructorPolicyRollback({
      contractVersion: "instructor-policy-rollback.v1",
      expectedVersion: 2,
    }),
    true,
  );
  assert.equal(
    isInstructorPolicyEmergencyDisable({
      contractVersion: "instructor-policy-emergency-disable.v1",
      expectedVersion: 1,
    }),
    true,
  );
  assert.equal(
    isInstructorPolicyEmergencyDisable({
      contractVersion: "instructor-policy-emergency-disable.v1",
      expectedVersion: 1,
      credential: "synthetic-secret",
    }),
    false,
  );
});

test("eligibility accepts only the two reviewed text classes without widening comparison or roles", () => {
  const allowed = ["IDENTITY_FREE_USER_TEXT", "IDENTITY_MINIMIZED_USER_TEXT"];
  for (const dataClasses of [
    [allowed[0]],
    [allowed[1]],
    allowed,
    [...allowed].reverse(),
  ]) {
    const candidate = policy();
    candidate.eligibility.dataClasses = dataClasses;
    assert.equal(isInstructorPolicyDocument(candidate), true);
    assert.equal(
      isInstructorPolicyPreviewRequest({
        contractVersion: "instructor-policy-preview-request.v1",
        expectedVersion: 1,
        policy: candidate,
      }),
      true,
    );
    assert.equal(
      isInstructorPolicyMutation({
        contractVersion: "instructor-policy-mutation.v1",
        expectedVersion: 1,
        previewDigest: "sha256:" + "a".repeat(64),
        policy: candidate,
      }),
      true,
    );
  }
  const unrelated = [
    "APPROVED_PUBLIC_COURSE_KNOWLEDGE",
    "APPROVED_PRIVATE_COURSE_MATERIAL",
    "PRIVACY_SENSITIVE_STUDENT_CONTENT",
    "TEMPORARY_UPLOAD",
    "ASSIGNMENT_ARTIFACT",
    "DERIVED_VERIFIER_EVIDENCE",
    "RESTRICTED_ASSESSMENT_CONTENT",
    "INSTRUCTOR_ONLY_SOLUTION_MATERIAL",
    "OPERATIONAL_METADATA",
    "FEEDBACK_REPORT_CONTENT",
    "TEMPORARY_SPEECH_AUDIO",
    "RESEARCH_DATA",
    "UNKNOWN_CLASS",
  ];
  for (const dataClasses of [
    [],
    [allowed[0], allowed[0]],
    [allowed[1], allowed[1]],
    ...unrelated.map((value) => [value]),
    ...unrelated.map((value) => [...allowed, value]),
  ]) {
    const candidate = policy();
    candidate.eligibility.dataClasses = dataClasses;
    assert.equal(
      isInstructorPolicyDocument(candidate),
      false,
      JSON.stringify(dataClasses),
    );
  }
  for (const dataClass of [allowed[1], ...unrelated]) {
    const candidate = policy();
    candidate.comparison.dataClass = dataClass;
    assert.equal(isInstructorPolicyDocument(candidate), false);
  }
  for (const accessClass of [
    "STUDENT",
    "ANONYMOUS_SESSION",
    "OPERATOR",
    "RESEARCHER",
    "KIOSK",
  ]) {
    const candidate = policy();
    candidate.eligibility.dataClasses = allowed;
    candidate.eligibility.accessClasses = [accessClass];
    assert.equal(isInstructorPolicyDocument(candidate), false);
  }
});
