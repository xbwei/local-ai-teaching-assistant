import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {pathToFileURL} from "node:url";
import {checkContracts} from "./check-contracts.mjs";
import {assertValid, evaluateCapability, loadContracts, readJson} from "./support.mjs";

// Offline contract checks only. No provider SDK, I/O to services, or runtime policy.
export async function loadDemo() {
  const contracts = await loadContracts();
  for (const name of ["demo-profile", "demo-comparison-seed"]) {
    const schema = await readJson(`schemas/v2/${name}.schema.json`);
    contracts.ajv.addSchema(schema);
    contracts.schemas[name] = schema;
  }
  return {
    ...contracts,
    profile: await readJson("demo/v2/demo-profile.json"),
    provider: await readJson("demo/v2/provider-eligibility.policy.json"),
    seed: await readJson("demo/v2/comparison-seed.json"),
  };
}

export function inputDigest(messages) {
  return `sha256:${createHash("sha256").update(JSON.stringify(messages), "utf8").digest("hex")}`;
}
// separate demo provider specialization. This is NOT an application loader.
export function demoDocuments({documents, profile, provider}) {
  return {...documents, bundle: profile.policyBundle, provider};
}

export function demoContext(profile, fixture, targetProvider) {
  assert.ok(["LOCAL", "OPENAI"].includes(targetProvider), "unknown demo provider");
  return {
    ...profile.evaluationContext,
    workflow: fixture.workflow,
    targetProvider,
    targetModel: targetProvider === "LOCAL" ? profile.local.model : profile.openai.model,
  };
}

export function checkDemo(demo) {
  const {ajv, schemas, documents, profile, provider, seed} = demo;
  checkContracts(demo);
  const validate = (name, value, label = name) =>
    assertValid(ajv, schemas[name].$id, value, label);
  validate("demo-profile", profile);
  validate("demo-comparison-seed", seed);
  validate("provider-eligibility", provider, "demo provider policy");

  assert.equal(profile.basePolicyVersion, documents.bundle.policyVersion, "base policy version");
  assert.equal(profile.policyBundle.policyVersion, "demo-policy.v2", "demo policy version");
  assert.equal(provider.providerPolicyVersion, "demo-provider-eligibility.v2", "demo provider version");
  assert.equal(profile.policyBundle.providerPolicyVersion, provider.providerPolicyVersion);
  for (const field of ["classificationVersion", "retentionPolicyVersion", "gradingBoundaryVersion", "documents"]) {
    assert.deepEqual(profile.policyBundle[field], documents.bundle[field], `inherited bundle ${field}`);
  }
  for (const field of ["policyVersion", "classificationVersion", "retentionPolicyVersion", "gradingBoundaryVersion"]) {
    assert.equal(profile.evaluationContext[field], profile.policyBundle[field], `demo context ${field}`);
  }
  assert.equal(seed.profileVersion, profile.profileVersion);
  assert.equal(seed.policyVersion, profile.policyBundle.policyVersion);
  assert.equal(seed.seedVersion, profile.comparison.seedVersion);
  assert.equal(profile.evaluationContext.courseRef, "course-synthetic-demo");
  assert.equal(profile.evaluationContext.moduleRef, "module-fixed-comparison");
  assert.equal(profile.evaluationContext.targetProvider, "LOCAL");
  assert.equal(profile.evaluationContext.targetModel, profile.local.model);
  assert.notEqual(profile.local.model, profile.local.comparisonModel);
  assert.equal(profile.evaluationContext.clientPolicyOverrideRequested, false);

  // The schema permits broader deployments; this particular demo must not.
  assert.equal(provider.allowRules.length, 2, "exactly two demo allow rules");
  assert.equal(new Set(provider.allowRules.map((rule) => rule.id)).size, 2, "unique rule ids");
  assert.deepEqual(provider.denyReasonPrecedence, documents.provider.denyReasonPrecedence);
  for (const targetProvider of ["LOCAL", "OPENAI"]) {
    const rules = provider.allowRules.filter((rule) => rule.provider === targetProvider);
    assert.equal(rules.length, 1, `one ${targetProvider} rule`);
    const rule = rules[0];
    assert.deepEqual(rule.models, targetProvider === "LOCAL"
      ? [profile.local.model, profile.local.comparisonModel]
      : [profile.openai.model]);
    for (const [field, expected] of Object.entries({
      accessClasses: ["INSTRUCTOR"], workflows: ["COURSE_QA", "CODING_COACH"],
      learningModes: ["DIRECT_EXPLANATION"], inputTypes: ["TEXT"],
      dataClasses: ["IDENTITY_FREE_USER_TEXT"], artifactStates: ["NONE"],
    })) {
      assert.deepEqual(rule[field], expected, `demo rule ${field}`);
    }
    assert.equal(rule.activeAssessment, "DENY");
  }

  assert.ok(profile.limits.maxInputTokensPerProvider + profile.limits.maxOutputTokens <=
    profile.local.contextTokens, "input and output must fit Local context");
  assert.deepEqual(evaluateCapability({
    ...profile.evaluationContext,
    targetModel: profile.local.comparisonModel,
  }, demoDocuments(demo)), {allowed: true, reason: "EXPLICIT_ALLOW"},
  "comparison Local model must be explicitly allowlisted");
  const rates = profile.openai.pricing;
  const maxRequestCost = (profile.limits.maxInputTokensPerProvider * rates.input +
    profile.limits.maxOutputTokens * rates.output) / 1_000_000;
  assert.ok(maxRequestCost <= profile.limits.maxEstimatedUsdPerRequest, "request estimate exceeds cap");
  assert.ok(maxRequestCost * seed.cases.length <= profile.limits.maxEstimatedUsdPerComparisonRun,
    "fixed seed estimate exceeds run cap");

  const profiles = new Map(documents.retention.profiles.map((entry) => [entry.id, entry]));
  for (const id of [profile.retention.sessionText, profile.retention.feasibilityMetadata,
    profile.retention.syntheticResult, profile.speech.stt.retentionProfile, profile.speech.tts.retentionProfile]) {
    assert.ok(profiles.has(id), `unknown retention profile ${id}`);
    assert.equal(profiles.get(id).storageLocation, "LOCAL_ONLY");
  }
  for (const id of [profile.speech.stt.retentionProfile, profile.speech.tts.retentionProfile]) {
    const retention = profiles.get(id);
    assert.equal(retention.contentPersistence, "TRANSIENT_ONLY");
    assert.equal(retention.onSessionEnd, "DELETE");
    assert.equal(retention.onSessionReset, "DELETE");
    for (const trigger of retention.deletionTriggers) {
      assert.ok(profile.speech.cleanup.includes(trigger), `missing audio cleanup ${trigger}`);
    }
  }
  const audioClass = documents.classification.classes.find((entry) => entry.id === profile.speech.audioDataClass);
  assert.equal(audioClass.providerProcessing, "LOCAL_ONLY");

  assert.equal(new Set(seed.cases.map((fixture) => fixture.id)).size, seed.cases.length, "unique case ids");
  assert.equal(new Set(seed.cases.map((fixture) => fixture.inputSha256)).size, seed.cases.length, "unique inputs");
  assert.ok(seed.cases.some((fixture) => fixture.difficulty === "HARD"), "hard case required");
  for (const workflow of ["COURSE_QA", "CODING_COACH"]) {
    assert.ok(seed.cases.some((fixture) => fixture.workflow === workflow), `missing ${workflow}`);
  }
  const effective = demoDocuments(demo);
  assert.deepEqual(evaluateCapability(profile.evaluationContext, effective),
    {allowed: true, reason: "EXPLICIT_ALLOW"}, "base demo context denied");
  for (const fixture of seed.cases) {
    assert.deepEqual(fixture.messages.map((message) => message.role), ["system", "user"]);
    assert.equal(fixture.messages[0].content, seed.cases[0].messages[0].content, "shared system instruction");
    assert.equal(inputDigest(fixture.messages), fixture.inputSha256, `input digest ${fixture.id}`);
    for (const targetProvider of ["LOCAL", "OPENAI"]) {
      const context = demoContext(profile, fixture, targetProvider);
      validate("capability-evaluation", context, `${fixture.id} ${targetProvider}`);
      assert.deepEqual(evaluateCapability(context, effective), {allowed: true, reason: "EXPLICIT_ALLOW"},
        `${fixture.id} ${targetProvider}: demo policy denied`);
    }
  }
  return `Demo contract check passed (${seed.cases.length} synthetic cases, 2 providers, no live calls).`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(checkDemo(await loadDemo()));
}
