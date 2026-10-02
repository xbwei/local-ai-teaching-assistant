import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, relative} from "node:path";
import {checkContracts} from "./check-contracts.mjs";
import {checkDemo, demoContext, demoDocuments, inputDigest, loadDemo} from "./check-demo.mjs";
import {
  durationMilliseconds,
  evaluateCapability,
  isExpired,
  loadContracts,
  readJson,
  root,
  validationMessage,
} from "./support.mjs";

const {ajv, documents, schemas} = await loadContracts();
const demo = await loadDemo();
const validateClassification = ajv.getSchema(
  schemas["data-classification"].$id,
);
const validateGrading = ajv.getSchema(schemas["grade-boundary"].$id);
const validateRetention = ajv.getSchema(schemas.retention.$id);
const validateProvider = ajv.getSchema(schemas["provider-eligibility"].$id);
const validateContext = ajv.getSchema(schemas["capability-evaluation"].$id);
const validateDecision = ajv.getSchema(schemas["capability-decision"].$id);
const validateInteraction = ajv.getSchema(schemas["interaction-record"].$id);

function clone(value) {
  return structuredClone(value);
}

function expectInvalid(validate, value, messagePattern) {
  assert.equal(validate(value), false, "negative fixture unexpectedly validated");
  assert.match(validationMessage(validate), messagePattern);
}

test("all table-driven capability fixtures produce expected deterministic decisions", () => {
  for (const fixture of documents.evaluationFixtures.cases) {
    assert.equal(validateContext(fixture.context), true, validationMessage(validateContext));
    const first = evaluateCapability(fixture.context, documents);
    const second = evaluateCapability(clone(fixture.context), documents);
    assert.deepEqual(first, fixture.expected, fixture.name);
    assert.deepEqual(second, first, `${fixture.name}: decision was not deterministic`);
  }
});

test("contract JSON load failures identify the source path", async () => {
  await assert.rejects(
    readJson("fixtures/v1/missing-contract.json"),
    /failed to read or parse JSON contract fixtures\/v1\/missing-contract\.json/,
  );
  const temporary = await mkdtemp(join(tmpdir(), "policy-contract-json-"));
  const relativePath = relative(root, join(temporary, "malformed.json"));
  try {
    await writeFile(join(temporary, "malformed.json"), '{"synthetic":');
    await assert.rejects(readJson(relativePath), (error) =>
      error.message.includes(relativePath) && error.cause instanceof SyntaxError);
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
});

test("Cloud remains deny-by-default and changing an upload classification revokes eligibility", () => {
  const allowed = documents.evaluationFixtures.cases.find(
    (fixture) => fixture.name === "cloud-identity-free-text-explicitly-eligible",
  ).context;
  assert.deepEqual(evaluateCapability(allowed, documents), {
    allowed: true,
    reason: "EXPLICIT_ALLOW",
  });
  const uploaded = {
    ...allowed,
    inputType: "UPLOAD_REFERENCE",
    dataClass: "TEMPORARY_UPLOAD",
    artifactState: "TEMPORARY_UPLOAD",
  };
  assert.deepEqual(evaluateCapability(uploaded, documents), {
    allowed: false,
    reason: "LOCAL_ONLY_DATA",
  });
  assert.equal(documents.provider.cloudDefault, "DENY");
  assert.equal(documents.provider.fallback, "PROHIBITED");
});

test("missing evaluator inputs fail closed instead of throwing", () => {
  assert.deepEqual(evaluateCapability(undefined, documents), {
    allowed: false,
    reason: "CONTEXT_NOT_ALLOWED",
  });
  assert.deepEqual(evaluateCapability({}, undefined), {
    allowed: false,
    reason: "CONTEXT_NOT_ALLOWED",
  });
  assert.deepEqual(evaluateCapability({}, {bundle: documents.bundle}), {
    allowed: false,
    reason: "CONTEXT_NOT_ALLOWED",
  });
});

test("malformed, incomplete, unknown, and extra policy fields fail with actionable paths", () => {
  const missing = clone(documents.provider);
  delete missing.cloudDefault;
  expectInvalid(validateProvider, missing, /cloudDefault/);

  const unknown = clone(documents.classification);
  unknown.classes[0].providerProcessing = "CLOUD_BY_CLIENT_REQUEST";
  expectInvalid(validateClassification, unknown, /providerProcessing/);

  const malformed = clone(documents.provider);
  malformed.allowRules = "allow everything";
  expectInvalid(validateProvider, malformed, /allowRules/);

  const extra = clone(documents.provider);
  extra.clientOverride = true;
  expectInvalid(validateProvider, extra, /additional properties/);
});

test("unknown context enum and missing context fields fail schema validation", () => {
  const context = clone(documents.evaluationFixtures.cases[0].context);
  context.targetProvider = "CLIENT_SELECTED_PROVIDER";
  expectInvalid(validateContext, context, /targetProvider/);
  delete context.courseRef;
  expectInvalid(validateContext, context, /courseRef/);
});

test("decisions remain bound to exact context and versions and cannot authorize fallback", () => {
  for (const record of documents.decisionFixtures.records) {
    assert.equal(validateDecision(record), true, validationMessage(validateDecision));
    assert.match(record.evaluatedContextDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(record.constraints.noFallback, true);
    assert.equal(record.policyVersion, documents.bundle.policyVersion);
    assert.equal(
      record.classificationVersion,
      documents.bundle.classificationVersion,
    );
  }
  const missingContextBinding = clone(documents.decisionFixtures.records[0]);
  delete missingContextBinding.evaluatedContextDigest;
  expectInvalid(validateDecision, missingContextBinding, /evaluatedContextDigest/);

  const fallbackGrant = clone(documents.decisionFixtures.records[0]);
  fallbackGrant.constraints.noFallback = false;
  expectInvalid(validateDecision, fallbackGrant, /noFallback/);

  const contradictoryDenial = clone(documents.decisionFixtures.records[1]);
  contradictoryDenial.reasonCodes = ["EXPLICIT_ALLOW"];
  expectInvalid(validateDecision, contradictoryDenial, /reasonCodes/);
});

test("retention expiry, storage, reset, and deletion-failure contracts are detectable", () => {
  for (const policyVersion of [undefined, "retention-policy.v2"]) {
    const invalid = clone(documents);
    invalid.retentionFixtures.policyVersion = policyVersion;
    assert.throws(() => checkContracts({ajv, documents: invalid, schemas}),
      /retention fixture policy: version mismatch/);
  }
  assert.equal(
    documents.retentionFixtures.policyVersion,
    documents.retention.retentionPolicyVersion,
  );
  for (const fixture of documents.retentionFixtures.cases) {
    const profile = documents.retention.profiles.find(
      (candidate) => candidate.id === fixture.profile,
    );
    assert.ok(profile, `${fixture.name}: missing profile`);
    assert.equal(isExpired(fixture, profile), fixture.expectedExpired, fixture.name);
  }
  for (const id of ["UPLOAD", "RAW_MICROPHONE_AUDIO", "GENERATED_TTS_AUDIO", "VERIFIER_WORKSPACE"]) {
    const profile = documents.retention.profiles.find((candidate) => candidate.id === id);
    assert.equal(profile.storageLocation, "LOCAL_ONLY", id);
    assert.equal(profile.contentPersistence, "TRANSIENT_ONLY", id);
    assert.equal(profile.onSessionReset, "DELETE", id);
    assert.equal(profile.deletionFailure.retry, "BOUNDED_BACKOFF", id);
  }
  const sessionProfile = documents.retention.profiles.find(
    (candidate) => candidate.id === "SESSION_TEXT",
  );
  assert.throws(
    () =>
      isExpired(
        {createdAt: "2026-01-01T00:00:00Z", evaluatedAt: "invalid-date"},
        sessionProfile,
      ),
    /missing sessionEndedAt expiry basis date/,
  );
  assert.throws(
    () =>
      isExpired(
        {
          createdAt: "2026-01-01T00:00:00Z",
          sessionEndedAt: "invalid-date",
          evaluatedAt: "2026-01-02T00:00:00Z",
        },
        sessionProfile,
      ),
    /invalid retention date/,
  );
  assert.equal(
    isExpired(
      {
        lastActivityAt: "2026-01-01T00:00:00Z",
        evaluatedAt: "2026-01-02T00:00:00Z",
      },
      {...sessionProfile, expiryBasis: "LAST_ACTIVITY_AT"},
    ),
    true,
  );
  assert.throws(
    () =>
      isExpired(
        {createdAt: "2026-01-01T00:00:00Z", evaluatedAt: "2026-01-02T00:00:00Z"},
        {...sessionProfile, expiryBasis: "NEVER_PERSIST", duration: "P1D"},
      ),
    /unsupported expiry basis/,
  );
});

test("interaction records reject persistent identity and official grades", () => {
  assert.equal(validateInteraction(documents.interactionFixtures.valid), true);
  expectInvalid(
    validateInteraction,
    documents.interactionFixtures.invalidPersistentIdentity,
    /additional properties/,
  );
  expectInvalid(
    validateInteraction,
    documents.interactionFixtures.invalidOfficialGrade,
    /additional properties/,
  );
  expectInvalid(validateInteraction, {
    ...documents.interactionFixtures.valid, dataClass: "OFFICIAL_GRADE",
  }, /dataClass/);
  expectInvalid(validateInteraction, {
    ...documents.interactionFixtures.valid, dataClass: "PERSISTENT_STUDENT_IDENTITY",
  }, /dataClass/);
});

test("grading layers preserve immutable evidence, human approval, and external official grades", () => {
  assert.equal(validateGrading(documents.grading), true);
  for (const prohibition of documents.grading.prohibitions) {
    const incomplete = clone(documents.grading);
    incomplete.prohibitions = incomplete.prohibitions.filter((entry) => entry !== prohibition);
    expectInvalid(validateGrading, incomplete, /prohibitions/);
  }
  const duplicate = clone(documents.grading);
  duplicate.prohibitions.push(duplicate.prohibitions[0]);
  expectInvalid(validateGrading, duplicate, /prohibitions/);
  const layers = new Map(documents.grading.layers.map((layer) => [layer.id, layer]));
  assert.equal(layers.get("DETERMINISTIC_EVIDENCE").mutableByAI, false);
  assert.equal(layers.get("DETERMINISTIC_EVIDENCE").aiMayCreate, false);
  assert.equal(layers.get("OBJECTIVE_FORMATIVE_POINTS").mutableByAI, false);
  assert.equal(layers.get("AI_RECOMMENDATION").aiMayCreate, true);
  assert.equal(layers.get("INSTRUCTOR_APPROVED_RESULT").authority, "INSTRUCTOR");
  assert.equal(layers.get("INSTRUCTOR_APPROVED_RESULT").aiMayCreate, false);
  assert.equal(layers.get("OFFICIAL_GRADE").interactionStoreAllowed, false);
  assert.ok(
    documents.grading.prohibitions.includes("AI_SELF_APPROVES_RESULT"),
  );
  assert.ok(
    documents.grading.prohibitions.includes("AUTONOMOUS_OFFICIAL_GRADE_WRITE"),
  );
});

test("complete contract validation rejects duplicate IDs before Map construction", () => {
  assert.match(checkContracts({ajv, documents, schemas}), /Policy contract check passed/);
  for (const [document, field, label] of [
    ["classification", "classes", "data classifications"],
    ["retention", "profiles", "retention profiles"],
  ]) {
    for (const changeDescription of [false, true]) {
      const duplicate = clone(documents);
      const entry = clone(duplicate[document][field][0]);
      if (changeDescription) {
        entry[document === "classification" ? "description" : "purpose"] =
          "Synthetic duplicate with different contents";
      }
      duplicate[document][field].push(entry);
      assert.throws(() => checkContracts({ajv, documents: duplicate, schemas}),
        {message: `${label}: identifiers must be unique`});
    }
  }
});

test("malformed rule properties fail closed even without schema validation", () => {
  const context = documents.evaluationFixtures.cases.find(
    (fixture) => fixture.name === "cloud-identity-free-text-explicitly-eligible",
  ).context;
  const rule = documents.provider.allowRules.find(
    (candidate) => candidate.id === "OPENAI_IDENTITY_FREE_TEXT",
  );
  const malformedRules = [null, undefined, {}, "allow everything", 42];
  for (const field of Object.keys(rule)) {
    const incomplete = clone(rule);
    delete incomplete[field];
    malformedRules.push(incomplete);
    for (const value of [null, {}, 42, false]) {
      malformedRules.push({...rule, [field]: value});
    }
    if (Array.isArray(rule[field])) {
      // A string also has includes(); it must not act as an allow-list.
      for (const value of [rule[field].join(","), [], [null], [42]]) {
        malformedRules.push({...rule, [field]: value});
      }
    }
  }
  for (const malformedRule of malformedRules) {
    const invalid = clone(documents);
    // Even a valid matching rule cannot rescue a malformed policy.
    invalid.provider.allowRules.push(malformedRule);
    assert.deepEqual(evaluateCapability(context, invalid), {
      allowed: false, reason: "CONTEXT_NOT_ALLOWED",
    }, JSON.stringify(malformedRule));
  }
  for (const field of Object.keys(context)) {
    const incomplete = clone(context);
    delete incomplete[field];
    assert.equal(evaluateCapability(incomplete, documents).allowed, false, field);
  }
  for (const section of ["bundle", "classification", "provider"]) {
    for (const value of [undefined, null, {}, "invalid"]) {
      assert.equal(evaluateCapability(context, {...documents, [section]: value}).allowed,
        false, section);
    }
  }
  for (const value of [undefined, null, {}, "allow everything", [null]]) {
    assert.equal(evaluateCapability(context, {
      ...documents, provider: {...documents.provider, allowRules: value},
    }).allowed, false);
    assert.equal(evaluateCapability(context, {
      ...documents, classification: {...documents.classification, classes: value},
    }).allowed, false);
  }
});

test("configured deny precedence selects among simultaneous reasons", () => {
  const context = {
    ...documents.evaluationFixtures.cases[0].context,
    providerFeatureEnabled: false, scheduleOpen: false, withinBudget: false,
  };
  assert.equal(evaluateCapability(context, documents).reason, "PROVIDER_DISABLED");
  for (const reason of ["SCHEDULE_CLOSED", "OVER_BUDGET"]) {
    const reordered = clone(documents);
    reordered.provider.denyReasonPrecedence = [reason,
      ...reordered.provider.denyReasonPrecedence.filter((candidate) => candidate !== reason)];
    assert.equal(validateProvider(reordered.provider), true, validationMessage(validateProvider));
    assert.deepEqual(evaluateCapability(context, reordered), {allowed: false, reason});
  }
});

test("incomplete or malformed deny precedence cannot suppress a denial", () => {
  const precedence = documents.provider.denyReasonPrecedence;
  const allowed = documents.evaluationFixtures.cases[0].context;
  for (const value of [undefined, null, {}, "OVER_BUDGET", [],
    precedence.filter((reason) => reason !== "OVER_BUDGET"),
    [...precedence.slice(1), precedence[1]],
    [...precedence.slice(1), "UNKNOWN_REASON"]]) {
    const invalid = clone(documents);
    invalid.provider.denyReasonPrecedence = value;
    assert.equal(validateProvider(invalid.provider), false);
    for (const context of [allowed, {...allowed, withinBudget: false}]) {
      assert.deepEqual(evaluateCapability(context, invalid), {
        allowed: false, reason: "CONTEXT_NOT_ALLOWED",
      });
    }
  }
});

test("retention schema and parser accept only bounded fixed day/hour/minute durations", () => {
  const durations = [
    ["P0D", 0], ["PT0M", 0], ["P1D", 86400000], ["PT2H", 7200000],
    ["PT3M", 180000], ["PT2H3M", 7380000], ["P1DT3M", 86580000],
    ["P1DT2H", 93600000], ["P1DT2H3M", 93780000],
    ["P999999DT999999H999999M", 90059909940000],
  ];
  for (const [duration, expected] of durations) {
    const policy = clone(documents.retention);
    policy.profiles[0].duration = duration;
    assert.equal(validateRetention(policy), true, `${duration}: ${validationMessage(validateRetention)}`);
    assert.equal(durationMilliseconds(duration), expected, duration);
    const fixture = {createdAt: "2026-01-01T00:00:00Z"};
    const expiry = Date.parse(fixture.createdAt) + expected;
    const profile = {...policy.profiles[0], expiryBasis: "CREATED_AT"};
    assert.equal(isExpired({...fixture, evaluatedAt: new Date(expiry - 1).toISOString()}, profile), false);
    assert.equal(isExpired({...fixture, evaluatedAt: new Date(expiry).toISOString()}, profile), true);
  }
  for (const duration of ["P1Y", "P1M", "P1W", "PT1S", "P1DT1S", "P1.5D",
    "PT0.5H", "P", "PT", "P1DT", "P-1D", "P1000000D", "PT1000000M",
    "P999999999999999999999D", "P1D\n", "P1D\r", "P1D\r\n", "P1D\u2028", "P1D\u2029", " P1D", "", null, 1]) {
    const policy = clone(documents.retention);
    policy.profiles[0].duration = duration;
    expectInvalid(validateRetention, policy, /duration/);
    assert.throws(() => durationMilliseconds(duration), /unsupported reference duration/);
  }
  const prohibited = documents.retention.profiles.find((profile) => profile.duration === "PROHIBITED");
  assert.equal(validateRetention(documents.retention), true);
  assert.equal(isExpired({}, prohibited), true);
  for (const duration of ["P0D", "P1D", "PT1H"]) {
    const invalid = clone(documents.retention);
    invalid.profiles = [{...prohibited, duration}];
    expectInvalid(validateRetention, invalid, /expiryBasis/);
    assert.throws(() => checkContracts({ajv, documents: {...documents, retention: invalid}, schemas}),
      /retention policy:.*expiryBasis/);
  }
  for (const expiryBasis of ["CREATED_AT", "SESSION_END", "DELIVERY_COMPLETED_AT"]) {
    const invalid = clone(documents.retention);
    invalid.profiles = [{...prohibited, expiryBasis}];
    expectInvalid(validateRetention, invalid, /expiryBasis/);
  }
});

test("every declared expiry basis rejects missing and invalid dates", () => {
  const basisFields = {
    CREATED_AT: "createdAt", LAST_ACTIVITY_AT: "lastActivityAt", SESSION_END: "sessionEndedAt",
    DELIVERY_COMPLETED_AT: "deliveryCompletedAt", RUN_COMPLETED_AT: "runCompletedAt",
    DELETION_FAILURE_AT: "deletionFailureAt",
  };
  const declared = schemas.retention.properties.profiles.items.properties.expiryBasis.enum;
  assert.deepEqual(Object.keys(basisFields).sort(), declared.filter((basis) => basis !== "NEVER_PERSIST").sort());
  for (const [expiryBasis, field] of Object.entries(basisFields)) {
    const profile = {...documents.retention.profiles[0], expiryBasis, duration: "P1D"};
    const fixture = {[field]: "2026-01-01T00:00:00Z", evaluatedAt: "2026-01-02T00:00:00Z"};
    assert.equal(isExpired(fixture, profile), true, expiryBasis);
    for (const value of [undefined, null, "", "invalid-date", 0, false]) {
      assert.throws(() => isExpired({...fixture, [field]: value}, profile), /expiry basis date|invalid retention date/);
      assert.throws(() => isExpired({...fixture, evaluatedAt: value}, profile), /invalid retention date/);
    }
  }
});

test("assessment decisions follow explicit rule restrictions for both providers", () => {
  for (const [targetProvider, targetModel] of [
    ["LOCAL", "local-approved-model"], ["OPENAI", "cloud-approved-model"],
  ]) {
    const eligible = documents.evaluationFixtures.cases.find(
      (fixture) => fixture.name === "cloud-identity-free-text-explicitly-eligible").context;
    const context = {...eligible, targetProvider, targetModel, activeAssessment: true};
    for (const activeAssessment of ["ALLOW", "DENY"]) {
      const policy = clone(documents);
      for (const rule of policy.provider.allowRules) {
        if (rule.provider === targetProvider) rule.activeAssessment = activeAssessment;
      }
      assert.equal(validateProvider(policy.provider), true, validationMessage(validateProvider));
      assert.deepEqual(evaluateCapability(context, policy), activeAssessment === "ALLOW"
        ? {allowed: true, reason: "EXPLICIT_ALLOW"}
        : {allowed: false, reason: "ACTIVE_ASSESSMENT"});
      assert.equal(evaluateCapability({...context, activeAssessment: false}, policy).allowed, true);
      assert.equal(evaluateCapability({...context, withinBudget: false}, policy).allowed, false);
    }
  }
  // The reference policy still denies Cloud processing during assessment.
  const cloud = documents.evaluationFixtures.cases.find(
    (fixture) => fixture.name === "active-assessment-denies-cloud");
  assert.deepEqual(evaluateCapability(cloud.context, documents), cloud.expected);
});

test("demo profile and fixed inputs validate against the unchanged Issue 30 contracts", () => {
  assert.match(checkDemo(demo), /8 synthetic cases, 2 providers, no live calls/);
  const original = JSON.stringify(demo.seed);
  for (const fixture of demo.seed.cases) {
    // Modes share the same source messages. Compare adds two independently
    // eligible legs, never an altered prompt or the other model's response.
    for (const providers of [["LOCAL"], ["OPENAI"], ["LOCAL", "OPENAI"]]) {
      for (const provider of providers) {
        const context = demoContext(demo.profile, fixture, provider);
        assert.equal(context.targetModel, provider === "LOCAL" ? demo.profile.local.model : demo.profile.openai.model);
        assert.deepEqual(evaluateCapability(context, demoDocuments(demo)), {allowed: true, reason: "EXPLICIT_ALLOW"});
        assert.equal(inputDigest(fixture.messages), fixture.inputSha256);
      }
    }
  }
  assert.equal(JSON.stringify(demo.seed), original);
  assert.throws(() => demoContext(demo.profile, demo.seed.cases[0], "Compare"), /unknown demo provider/);
});

test("demo eligibility rejects unsafe context changes for each provider without fallback", () => {
  const cases = [
    [{policyVersion: "teaching-policy.v1"}, "POLICY_VERSION_MISMATCH"],
    [{retentionPolicyVersion: "retention-policy.v2"}, "POLICY_VERSION_MISMATCH"],
    [{clientPolicyOverrideRequested: true}, "CLIENT_POLICY_OVERRIDE"],
    [{providerFeatureEnabled: false}, "PROVIDER_DISABLED"],
    [{scheduleOpen: false}, "SCHEDULE_CLOSED"],
    [{withinBudget: false}, "OVER_BUDGET"],
    [{quotaAvailable: false}, "QUOTA_UNAVAILABLE"],
    [{activeAssessment: true}, "ACTIVE_ASSESSMENT"],
    [{targetModel: "unapproved-model"}, "MODEL_NOT_ALLOWED"],
    [{dataClass: "OPERATIONAL_METADATA"}, "PROVIDER_PROCESSING_PROHIBITED"],
  ];
  for (const provider of ["LOCAL", "OPENAI"]) {
    const context = demoContext(demo.profile, demo.seed.cases[0], provider);
    for (const [change, reason] of cases) {
      assert.deepEqual(evaluateCapability({...context, ...change}, demoDocuments(demo)),
        {allowed: false, reason}, `${provider}: ${JSON.stringify(change)}`);
    }
    for (const change of [
      {accessClass: "STUDENT"}, {accessClass: "OPERATOR"},
      {workflow: "RESEARCH_EVALUATION"}, {workflow: "ASSIGNMENT_VERIFICATION"},
      {inputType: "AUDIO_REFERENCE", dataClass: "TEMPORARY_SPEECH_AUDIO"},
      {inputType: "UPLOAD_REFERENCE", dataClass: "TEMPORARY_UPLOAD", artifactState: "TEMPORARY_UPLOAD"},
    ]) {
      assert.equal(evaluateCapability({...context, ...change}, demoDocuments(demo)).allowed, false);
    }
    for (const field of ["withinBudget", "quotaAvailable", "courseRef"]) {
      const incomplete = {...context};
      delete incomplete[field];
      assert.equal(evaluateCapability(incomplete, demoDocuments(demo)).allowed, false);
    }
  }
});

test("demo documents reject expanded permissions, stale versions, malformed or injected fields", () => {
  const mutations = [
    (d) => { delete d.profile.local; },
    (d) => { d.profile.apiKey = "synthetic-disallowed-field"; },
    (d) => { d.profile.openai.model = "cloud-approved-model"; },
    (d) => { d.profile.local.model = "unapproved-local-model"; },
    (d) => { d.profile.local.comparisonModel = "unapproved-comparison-model"; },
    (d) => { d.profile.capabilities.image = "ENABLED"; },
    (d) => { d.profile.fallback = "OPENAI"; },
    (d) => { d.profile.policyBundle.retentionPolicyVersion = "retention-policy.v2"; },
    (d) => { d.profile.evaluationContext.policyVersion = "teaching-policy.v1"; },
    (d) => { d.profile.evaluationContext.courseRef = "course-private"; },
    (d) => { d.profile.evaluationContext.workflow = "ASSIGNMENT_VERIFICATION"; },
    (d) => { d.provider.providerPolicyVersion = "provider-eligibility.v1"; },
    (d) => { d.provider.allowRules[0].models.push("extra-model"); },
    (d) => { d.provider.allowRules[1].accessClasses.push("STUDENT"); },
    (d) => { d.provider.allowRules[1].inputTypes.push("AUDIO_REFERENCE"); },
    (d) => { d.provider.allowRules[1].activeAssessment = "ALLOW"; },
    (d) => { d.provider.allowRules[1].requireWithinBudget = false; },
    (d) => { d.provider.allowRules.push(clone(d.provider.allowRules[0])); },
    (d) => { d.provider.allowRules[1].id = d.provider.allowRules[0].id; },
    (d) => { d.profile.limits.maxResidentPrimaryModels = 2; },
    (d) => { d.profile.local.contextTokens = 1024; },
    (d) => { d.profile.limits.maxEstimatedUsdPerRequest = 0.0001; },
    (d) => { d.profile.limits.maxEstimatedUsdPerComparisonRun = 0.001; },
    (d) => { d.profile.speech.cloudAudio = "ALLOWED"; },
    (d) => { d.profile.speech.stt.continuousListening = true; },
    (d) => { d.profile.speech.tts.retentionProfile = "SESSION_TEXT"; },
    (d) => { d.profile.speech.cleanup = ["DELIVERY"]; },
    (d) => { d.profile.retention.persistentIdentity = true; },
    (d) => { d.profile.metadata.missingValues = "ZERO"; },
  ];
  for (const mutate of mutations) {
    const candidate = {...demo, profile: clone(demo.profile), provider: clone(demo.provider), seed: clone(demo.seed)};
    mutate(candidate);
    assert.throws(() => checkDemo(candidate), undefined, mutate.toString());
  }
});

test("fixed comparison seed rejects drift, duplicate cases, unsupported inputs and missing coverage", () => {
  const mutations = [
    (s) => { s.policyVersion = "teaching-policy.v1"; },
    (s) => { s.cases = s.cases.slice(0, 5); },
    (s) => { s.cases.push(...clone(s.cases)); },
    (s) => { s.cases[1].id = s.cases[0].id; },
    (s) => { s.cases[1] = {...clone(s.cases[0]), id: "duplicate-input"}; },
    (s) => { s.cases[0].messages[1].content += " changed"; },
    (s) => { s.cases[0].messages[1].image = "synthetic.png"; },
    (s) => { s.cases[0].messages.reverse(); },
    (s) => { s.cases[0].provenance = "STUDENT_SUBMISSION"; },
    (s) => { s.cases.forEach((c) => { c.difficulty = "STANDARD"; }); },
    (s) => { s.cases.forEach((c) => { c.workflow = "COURSE_QA"; }); },
  ];
  for (const mutate of mutations) {
    const candidate = {...demo, seed: clone(demo.seed)};
    mutate(candidate.seed);
    assert.throws(() => checkDemo(candidate), undefined, mutate.toString());
  }
});
