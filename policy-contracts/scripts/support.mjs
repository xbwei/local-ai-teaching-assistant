import {readFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function readJson(relativePath) {
  const fullPath = join(root, relativePath);
  try {
    return JSON.parse(await readFile(fullPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to read or parse JSON contract ${relativePath}: ${detail}`,
      {cause: error},
    );
  }
}

export async function loadContracts() {
  const schemaNames = [
    "common",
    "data-classification",
    "provider-eligibility",
    "retention",
    "grade-boundary",
    "policy-bundle",
    "capability-evaluation",
    "capability-decision",
    "evaluation-cases",
    "interaction-record",
  ];
  const schemas = Object.fromEntries(
    await Promise.all(
      schemaNames.map(async (name) => [
        name,
        await readJson(`schemas/v1/${name}.schema.json`),
      ]),
    ),
  );
  const ajv = new Ajv2020({allErrors: true, strict: true});
  addFormats(ajv);
  for (const schema of Object.values(schemas)) {
    ajv.addSchema(schema);
  }

  const documents = {
    bundle: await readJson("policies/v1/policy-bundle.json"),
    classification: await readJson(
      "policies/v1/data-classification.policy.json",
    ),
    provider: await readJson("policies/v1/provider-eligibility.policy.json"),
    retention: await readJson("policies/v1/retention.policy.json"),
    grading: await readJson("policies/v1/grade-boundary.policy.json"),
    evaluationFixtures: await readJson(
      "fixtures/v1/provider-evaluation-cases.json",
    ),
    retentionFixtures: await readJson("fixtures/v1/retention-cases.json"),
    interactionFixtures: await readJson(
      "fixtures/v1/interaction-records.json",
    ),
    decisionFixtures: await readJson(
      "fixtures/v1/capability-decisions.json",
    ),
  };
  return {ajv, documents, schemas};
}

export function validationMessage(validate) {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"}: ${error.message}`)
    .join("; ");
}

export function assertValid(ajv, schemaId, value, label) {
  const validate = ajv.getSchema(schemaId);
  if (!validate) {
    throw new Error(`${label}: schema was not registered: ${schemaId}`);
  }
  if (!validate(value)) {
    throw new Error(`${label}: ${validationMessage(validate)}`);
  }
}

const nonEmptyString = (value) => typeof value === "string" && value.length > 0;
const ruleArrayFields = [
  "models", "dataClasses", "accessClasses", "workflows", "learningModes",
  "inputTypes", "artifactStates",
];
const ruleRequirements = [
  "requireFeatureEnabled", "requireScheduleOpen", "requireWithinBudget",
  "requireQuotaAvailable",
];

function completeRule(rule) {
  return Boolean(rule) && nonEmptyString(rule.id) &&
    ["LOCAL", "OPENAI"].includes(rule.provider) &&
    ["ALLOW", "DENY"].includes(rule.activeAssessment) &&
    ruleRequirements.every((field) => rule[field] === true) &&
    ruleArrayFields.every((field) =>
      Array.isArray(rule[field]) && rule[field].length > 0 &&
      rule[field].every(nonEmptyString));
}

const versionFields = [
  "policyVersion", "classificationVersion", "retentionPolicyVersion",
  "gradingBoundaryVersion",
];

function completeContext(context) {
  return Boolean(context) &&
    versionFields.every((field) => nonEmptyString(context[field])) &&
    ["accessClass", "courseRef", "moduleRef", "workflow", "learningMode",
      "inputType", "dataClass", "artifactState", "targetModel"].every(
      (field) => nonEmptyString(context[field])) &&
    context.contractVersion === "capability-evaluation.v1" &&
    ["LOCAL", "OPENAI"].includes(context.targetProvider) &&
    ["providerFeatureEnabled", "scheduleOpen", "withinBudget", "quotaAvailable",
      "activeAssessment", "clientPolicyOverrideRequested"].every(
      (field) => typeof context[field] === "boolean");
}

function completeDocuments(documents) {
  return Boolean(documents?.bundle) &&
    versionFields.every((field) => nonEmptyString(documents.bundle[field])) &&
    Array.isArray(documents.classification?.classes) &&
    documents.classification.classes.every((entry) => entry &&
      nonEmptyString(entry.id) &&
      ["LOCAL_ONLY", "CLOUD_EXPLICIT_ALLOW", "PROHIBITED"].includes(entry.providerProcessing)) &&
    documents.provider?.defaultProvider === "LOCAL" &&
    documents.provider?.cloudDefault === "DENY" &&
    documents.provider?.fallback === "PROHIBITED" &&
    Array.isArray(documents.provider?.allowRules) &&
    documents.provider.allowRules.every(completeRule);
}

export function evaluateCapability(context, documents) {
  const failClosed = {allowed: false, reason: "CONTEXT_NOT_ALLOWED"};
  // Defensive checks also apply to callers that bypass document validation.
  if (!completeContext(context) || !completeDocuments(documents)) {
    return failClosed;
  }
  const {bundle, classification, provider} = documents;
  const dataClass = classification.classes.find(
    (candidate) => candidate.id === context.dataClass,
  );
  const cloud = context.targetProvider === "OPENAI";
  const classRules = provider.allowRules.filter((rule) =>
    rule.provider === context.targetProvider && rule.dataClasses.includes(context.dataClass));
  const modelRules = classRules.filter((rule) => rule.models.includes(context.targetModel));
  const contextRules = modelRules.filter((rule) =>
    rule.accessClasses.includes(context.accessClass) &&
    rule.workflows.includes(context.workflow) &&
    rule.learningModes.includes(context.learningMode) &&
    rule.inputTypes.includes(context.inputType) &&
    rule.artifactStates.includes(context.artifactState));
  const matchingRule = contextRules.find((rule) =>
    rule.activeAssessment === "ALLOW" || !context.activeAssessment);
  const contextNotAllowed = classRules.length === 0 ||
    (modelRules.length > 0 && contextRules.length === 0);
  // Collect applicable reasons first; only the policy determines their order.
  const denials = {
    POLICY_VERSION_MISMATCH: versionFields.some((field) => context[field] !== bundle[field]),
    CLIENT_POLICY_OVERRIDE: context.clientPolicyOverrideRequested,
    UNKNOWN_DATA_CLASS: !dataClass,
    PROVIDER_PROCESSING_PROHIBITED: dataClass?.providerProcessing === "PROHIBITED",
    LOCAL_ONLY_DATA: cloud && dataClass?.providerProcessing === "LOCAL_ONLY",
    PROVIDER_DISABLED: !context.providerFeatureEnabled,
    SCHEDULE_CLOSED: !context.scheduleOpen,
    ACTIVE_ASSESSMENT: context.activeAssessment && contextRules.length > 0 && !matchingRule,
    OVER_BUDGET: !context.withinBudget,
    QUOTA_UNAVAILABLE: !context.quotaAvailable,
    MODEL_NOT_ALLOWED: classRules.length > 0 && modelRules.length === 0,
    CLOUD_NOT_EXPLICITLY_ALLOWED: cloud && contextNotAllowed,
    CONTEXT_NOT_ALLOWED: !cloud && contextNotAllowed,
  };
  const precedence = provider.denyReasonPrecedence;
  // An incomplete/unknown ordering must never suppress a denial into an allow.
  if (!Array.isArray(precedence) ||
      precedence.length !== Object.keys(denials).length ||
      new Set(precedence).size !== precedence.length ||
      !precedence.every((reason) => Object.hasOwn(denials, reason))) {
    return failClosed;
  }
  const reason = precedence.find((candidate) => denials[candidate]);
  if (reason) {
    return {allowed: false, reason};
  }
  return matchingRule ? {allowed: true, reason: "EXPLICIT_ALLOW"} : failClosed;
}

export function durationMilliseconds(duration) {
  const match = typeof duration === "string" &&
    /^P(?=[0-9T])(?:([0-9]{1,6})D)?(?:T(?=[0-9])(?:([0-9]{1,6})H)?(?:([0-9]{1,6})M)?)?$/.exec(duration);
  if (!match) {
    throw new Error(`unsupported reference duration: ${duration}`);
  }
  const [, days = "0", hours = "0", minutes = "0"] = match;
  return (
    Number(days) * 86_400_000 +
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000
  );
}

export function isExpired(fixture, profile) {
  if (!fixture || !profile) {
    throw new Error("retention expiry requires a fixture and profile");
  }
  if (profile.duration === "PROHIBITED") {
    return true;
  }
  const basisFields = {
    CREATED_AT: "createdAt",
    LAST_ACTIVITY_AT: "lastActivityAt",
    SESSION_END: "sessionEndedAt",
    DELIVERY_COMPLETED_AT: "deliveryCompletedAt",
    RUN_COMPLETED_AT: "runCompletedAt",
    DELETION_FAILURE_AT: "deletionFailureAt",
  };
  const basisField = Object.hasOwn(basisFields, profile.expiryBasis)
    ? basisFields[profile.expiryBasis] : undefined;
  if (!basisField) {
    throw new Error(`unsupported expiry basis for profile ${profile.id}`);
  }
  const basis = fixture[basisField];
  if (!basis) {
    throw new Error(
      `missing ${basisField} expiry basis date for profile ${profile.id}`,
    );
  }
  const basisTime = new Date(basis).getTime();
  const evaluatedTime = new Date(fixture.evaluatedAt).getTime();
  if (typeof basis !== "string" || typeof fixture.evaluatedAt !== "string" ||
      Number.isNaN(basisTime) || Number.isNaN(evaluatedTime)) {
    throw new Error(`invalid retention date for profile ${profile.id}`);
  }
  return (
    evaluatedTime >= basisTime + durationMilliseconds(profile.duration)
  );
}
