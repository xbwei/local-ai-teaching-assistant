import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

const policyRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(policyRoot, "..");
const defaultOutput = join(
  repositoryRoot,
  "packages/contracts/src/policy-contract.generated.ts",
);

const sources = [
  "types/policy-v1.ts",
  "schemas/v1/common.schema.json",
  "schemas/v1/capability-evaluation.schema.json",
  "schemas/v1/capability-decision.schema.json",
  "policies/v1/policy-bundle.json",
  "policies/v1/data-classification.policy.json",
  "policies/v1/provider-eligibility.policy.json",
  "fixtures/v1/capability-decisions.json",
  "demo/v2/demo-profile.json",
  "demo/v2/provider-eligibility.policy.json",
  "demo/v4/demo-profile.json",
  "demo/v4/provider-eligibility.policy.json",
  "demo/v4/comparison-seed.json",
];

const normalizeLineEndings = (text) => text.replace(/\r\n?/g, "\n");

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJson(value[key])]),
    );
  }
  return value;
}

export async function renderRuntimeContract(root = policyRoot) {
  const rawContents = await Promise.all(
    sources.map((source) => readFile(join(root, source), "utf8")),
  );
  const contents = rawContents.map(normalizeLineEndings);
  const [
    types,
    commonText,
    evaluationText,
    decisionText,
    bundleText,
    classificationText,
    providerText,
    decisionFixturesText,
    demoProfileText,
    demoProviderText,
    successorProfileText,
    successorProviderText,
    successorSeedText,
  ] = contents;
  const commonSchema = JSON.parse(commonText);
  const evaluationSchema = JSON.parse(evaluationText);
  const decisionSchema = JSON.parse(decisionText);
  const bundle = JSON.parse(bundleText);
  const classification = JSON.parse(classificationText);
  const provider = JSON.parse(providerText);
  const decisionFixtures = JSON.parse(decisionFixturesText);
  const demoProfile = JSON.parse(demoProfileText);
  const demoProvider = JSON.parse(demoProviderText);
  const demoBundle = demoProfile.policyBundle;
  if (
    bundle.schemaVersion !== "policy-bundle-schema.v1" ||
    classification.schemaVersion !== "data-classification-schema.v1" ||
    provider.schemaVersion !== "provider-eligibility-schema.v1" ||
    provider.fallback !== "PROHIBITED" ||
    bundle.providerPolicyVersion !== provider.providerPolicyVersion ||
    bundle.classificationVersion !== classification.classificationVersion ||
    demoProfile.profileVersion !== "demo-profile.v2" ||
    demoBundle?.schemaVersion !== "policy-bundle-schema.v1" ||
    demoProvider.schemaVersion !== "provider-eligibility-schema.v1" ||
    demoProvider.fallback !== "PROHIBITED" ||
    demoBundle.providerPolicyVersion !== demoProvider.providerPolicyVersion ||
    demoBundle.classificationVersion !== classification.classificationVersion
  ) {
    throw new Error(
      "reviewed provider policy identity or no-fallback invariant is invalid",
    );
  }
  const digest = createHash("sha256").update(contents.join("\0")).digest("hex");
  const successorProfile = JSON.parse(successorProfileText);
  const successorProvider = JSON.parse(successorProviderText);
  const successorSeed = JSON.parse(successorSeedText);
  if (successorProfile.profileVersion !== "demo-profile.v4" ||
      successorProfile.policyBundle.policyVersion !== "demo-policy.v4" ||
      successorProvider.fallback !== "PROHIBITED" ||
      successorProfile.policyBundle.providerPolicyVersion !== successorProvider.providerPolicyVersion ||
      successorProfile.limits.localIdleUnloadSeconds !== 600 ||
      successorProfile.limits.maxInputTokensPerProvider !== 3584 ||
      successorProfile.limits.maxResidentPrimaryModels !== 1 ||
      successorSeed.profileVersion !== successorProfile.profileVersion)
    throw new Error("reviewed successor identity, limits or no-fallback invariant is invalid");
  const generated = {
    successor: {
      identity: {
        profileVersion: successorProfile.profileVersion,
        ...Object.fromEntries(Object.entries(successorProfile.policyBundle).filter(([key]) => key.endsWith("Version"))),
        fallback: successorProvider.fallback,
      },
      providerPolicy: stableJson(successorProvider),
      speech: stableJson(successorProfile.speech),
      limits: stableJson(successorProfile.limits),
      seed: stableJson(successorSeed),
    },
    provenance: {
      contractVersion: "policy-runtime-link.v1",
      sourceFiles: sources,
      sourceDigest: `sha256:${digest}`,
    },
    identity: {
      policyVersion: bundle.policyVersion,
      classificationVersion: bundle.classificationVersion,
      providerPolicyVersion: bundle.providerPolicyVersion,
      retentionPolicyVersion: bundle.retentionPolicyVersion,
      gradingBoundaryVersion: bundle.gradingBoundaryVersion,
      fallback: provider.fallback,
    },
    demoIdentity: {
      profileVersion: demoProfile.profileVersion,
      policyVersion: demoBundle.policyVersion,
      classificationVersion: demoBundle.classificationVersion,
      providerPolicyVersion: demoBundle.providerPolicyVersion,
      retentionPolicyVersion: demoBundle.retentionPolicyVersion,
      gradingBoundaryVersion: demoBundle.gradingBoundaryVersion,
      fallback: demoProvider.fallback,
    },
    commonSchema: stableJson(commonSchema),
    capabilityEvaluationSchema: stableJson(evaluationSchema),
    capabilityDecisionSchema: stableJson(decisionSchema),
    capabilityDecisionFixtures: stableJson(decisionFixtures),
    dataClassificationPolicy: stableJson(classification),
    demoProviderEligibilityPolicy: stableJson(demoProvider),
    demoEvaluationContext: stableJson(demoProfile.evaluationContext),
    demoModels: stableJson({
      local: [demoProfile.local.model, demoProfile.local.comparisonModel],
      openai: [demoProfile.openai.model],
    }),
  };
  const output = [
    "// Generated from reviewed policy-contracts by generate-runtime-contract.mjs.",
    "// Do not edit. Run the generator or its --check mode instead.",
    "",
    types.trim(),
    "",
    `export const reviewedPolicyRuntimeContract = ${JSON.stringify(stableJson(generated), null, 2)} as const;`,
    "",
  ].join("\n");
  return format(output, { parser: "typescript" });
}

export async function checkRuntimeContract(
  root = policyRoot,
  output = defaultOutput,
) {
  const expected = await renderRuntimeContract(root);
  const actual = normalizeLineEndings(
    await readFile(output, "utf8").catch(() => ""),
  );
  if (actual !== expected) {
    throw new Error(
      "runtime policy contract is missing or drifted; regenerate it from policy-contracts",
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] === "--check") {
    await checkRuntimeContract();
    console.log("Runtime policy-contract linkage passed.");
  } else if (process.argv.length === 2) {
    await writeFile(defaultOutput, await renderRuntimeContract(policyRoot));
    console.log("Generated runtime policy contract.");
  } else {
    throw new Error("usage: generate-runtime-contract.mjs [--check]");
  }
}
