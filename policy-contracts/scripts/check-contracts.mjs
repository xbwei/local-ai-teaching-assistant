import assert from "node:assert/strict";
import {pathToFileURL} from "node:url";
import {loadContracts, assertValid} from "./support.mjs";

export function checkContracts({ajv, documents, schemas}) {
  const ids = Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [name, schema.$id]),
  );

  assertValid(
    ajv,
    ids["data-classification"],
    documents.classification,
    "classification",
  );
  assertValid(
    ajv,
    ids["provider-eligibility"],
    documents.provider,
    "provider policy",
  );
  assertValid(ajv, ids.retention, documents.retention, "retention policy");
  assertValid(
    ajv,
    ids["grade-boundary"],
    documents.grading,
    "grading boundary",
  );
  assertValid(
    ajv,
    ids["policy-bundle"],
    documents.bundle,
    "policy bundle",
  );
  assertValid(
    ajv,
    ids["evaluation-cases"],
    documents.evaluationFixtures,
    "provider fixtures",
  );
  assertValid(
    ajv,
    ids["interaction-record"],
    documents.interactionFixtures.valid,
    "valid interaction fixture",
  );
  for (const [index, record] of documents.decisionFixtures.records.entries()) {
    assertValid(
      ajv,
      ids["capability-decision"],
      record,
      `capability decision fixture ${index}`,
    );
  }

  function requireUnique(values, label) {
    if (new Set(values).size !== values.length) {
      throw new Error(`${label}: identifiers must be unique`);
    }
  }

  function requireExactSet(actual, expected, label) {
    const missing = expected.filter((value) => !actual.includes(value));
    const extra = actual.filter((value) => !expected.includes(value));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `${label}: missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extra)}`,
      );
    }
  }

  requireUnique(
    documents.classification.classes.map((entry) => entry.id),
    "data classifications",
  );
  requireUnique(
    documents.retention.profiles.map((entry) => entry.id),
    "retention profiles",
  );
  const classes = new Map(
    documents.classification.classes.map((entry) => [entry.id, entry]),
  );
  const profiles = new Map(
    documents.retention.profiles.map((entry) => [entry.id, entry]),
  );
  requireExactSet(
    [...classes.keys()],
    [
      "APPROVED_PUBLIC_COURSE_KNOWLEDGE",
      "APPROVED_PRIVATE_COURSE_MATERIAL",
      "IDENTITY_FREE_USER_TEXT",
      "IDENTITY_MINIMIZED_USER_TEXT",
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
    ],
    "data classification coverage",
  );
  requireExactSet(
    [...profiles.keys()],
    [
      "APPROVED_COURSE_KNOWLEDGE",
      "SESSION_TEXT",
      "INTERACTION_METADATA",
      "FEEDBACK",
      "ISSUE_REPORT",
      "OPTIONAL_RETAINED_REPORT_CONTENT",
      "SAFETY_OPERATIONS_METADATA",
      "UPLOAD",
      "GENERATED_TEMPORARY_FILE",
      "RAW_MICROPHONE_AUDIO",
      "GENERATED_TTS_AUDIO",
      "VERIFIER_WORKSPACE",
      "DETERMINISTIC_EVIDENCE",
      "DELETION_FAILURE_METADATA",
      "EVALUATION_FIXTURE_RESULT",
      "RETENTION_PROHIBITED",
    ],
    "retention profile coverage",
  );
  requireUnique(
    documents.provider.allowRules.map((rule) => rule.id),
    "provider allow rules",
  );
  requireUnique(
    documents.evaluationFixtures.cases.map((fixture) => fixture.name),
    "provider fixtures",
  );

  for (const entry of classes.values()) {
    if (!profiles.has(entry.retentionProfile)) {
      throw new Error(
        `data class ${entry.id}: unknown retention profile ${entry.retentionProfile}`,
      );
    }
  }
  for (const rule of documents.provider.allowRules) {
    for (const classId of rule.dataClasses) {
      const entry = classes.get(classId);
      if (!entry) {
        throw new Error(`allow rule ${rule.id}: unknown data class ${classId}`);
      }
      if (entry.providerProcessing === "PROHIBITED") {
        throw new Error(`allow rule ${rule.id}: prohibited class ${classId}`);
      }
      if (rule.provider === "OPENAI" && entry.providerProcessing !== "CLOUD_EXPLICIT_ALLOW") {
        throw new Error(`allow rule ${rule.id}: class ${classId} is not Cloud-eligible`);
      }
    }
  }

  const {bundle, classification, provider, retention, grading} = documents;
  const versionPairs = [
    [bundle.classificationVersion, classification.classificationVersion, "classification"],
    [bundle.providerPolicyVersion, provider.providerPolicyVersion, "provider"],
    [bundle.retentionPolicyVersion, retention.retentionPolicyVersion, "retention"],
    [bundle.gradingBoundaryVersion, grading.gradingBoundaryVersion, "grading"],
    [bundle.policyVersion, documents.evaluationFixtures.policyVersion, "fixture policy"],
    [bundle.policyVersion, documents.decisionFixtures.policyVersion, "decision fixture policy"],
    [bundle.retentionPolicyVersion, documents.retentionFixtures.policyVersion, "retention fixture policy"],
  ];
  for (const [expected, actual, label] of versionPairs) {
    if (expected !== actual) {
      throw new Error(`${label}: version mismatch ${actual} != ${expected}`);
    }
  }

  const expectedLayers = [
    "DETERMINISTIC_EVIDENCE",
    "OBJECTIVE_FORMATIVE_POINTS",
    "AI_RECOMMENDATION",
    "INSTRUCTOR_APPROVED_RESULT",
    "OFFICIAL_GRADE",
  ];
  if (grading.layers.map((layer) => layer.id).join(",") !== expectedLayers.join(",")) {
    throw new Error("grading boundary: layers must appear once and in authority order");
  }
  const officialGrade = grading.layers.find((layer) => layer.id === "OFFICIAL_GRADE");
  assert(officialGrade);
  if (officialGrade.interactionStoreAllowed) {
    throw new Error("grading boundary: official grade cannot enter interaction storage");
  }
  for (const layer of grading.layers) {
    if (layer.aiMayCreate !== (layer.id === "AI_RECOMMENDATION")) {
      throw new Error(
        `grading boundary: AI creation authority is invalid for ${layer.id}`,
      );
    }
  }
  if (grading.allowedTransitions.some((transition) => transition.to === "OFFICIAL_GRADE")) {
    throw new Error("grading boundary: no autonomous official-grade transition is allowed");
  }
  requireExactSet(
    grading.prohibitions,
    [
      "AI_MUTATES_DETERMINISTIC_EVIDENCE",
      "AI_MUTATES_OBJECTIVE_POINTS",
      "AI_SELF_APPROVES_RESULT",
      "OFFICIAL_GRADE_IN_SESSION_DATA",
      "PERSISTENT_STUDENT_IDENTITY_IN_INTERACTION_STORE",
      "AUTONOMOUS_OFFICIAL_GRADE_WRITE",
    ],
    "grading prohibition coverage",
  );

  return (
    `Policy contract check passed (${classes.size} classes, ${profiles.size} retention profiles, ${documents.evaluationFixtures.cases.length} provider fixtures).`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(checkContracts(await loadContracts()));
}
