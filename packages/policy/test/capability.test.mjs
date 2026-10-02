import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isCapabilityAvailability,
  reviewedPolicyRuntimeContract,
} from "@laita/contracts";
import { createCapabilityEvaluator } from "../dist/index.js";

const configuration = () =>
  JSON.parse(
    readFileSync(
      new URL(
        "../../runtime/examples/openai-demo.example.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
const evaluator = () => {
  const value = createCapabilityEvaluator(configuration());
  assert.ok(value);
  return value;
};
const context = (overrides = {}) => ({
  accessClass: "INSTRUCTOR",
  courseRef: "course-synthetic-demo",
  moduleRef: "module-fixed-comparison",
  workflow: "COURSE_QA",
  learningMode: "DIRECT_EXPLANATION",
  inputType: "TEXT",
  dataClass: "IDENTITY_FREE_USER_TEXT",
  artifactState: "NONE",
  activeAssessment: false,
  ...overrides,
});
const controls = (overrides = {}) => ({
  emergencyStop: false,
  local: {
    featureEnabled: true,
    scheduleOpen: true,
    withinBudget: true,
    quotaAvailable: true,
    state: "READY",
    ...overrides.local,
  },
  openai: {
    featureEnabled: true,
    scheduleOpen: true,
    withinBudget: true,
    quotaAvailable: true,
    state: "READY",
    ...overrides.openai,
  },
  ...Object.fromEntries(
    Object.entries(overrides).filter(
      ([key]) => !["local", "openai"].includes(key),
    ),
  ),
});

test("authorized instructor demo is driven by reviewed model rules and is deterministic", () => {
  const service = evaluator();
  const first = service.availability(context(), controls());
  const second = service.availability(structuredClone(context()), controls());
  assert.deepEqual(second, first);
  assert.equal(isCapabilityAvailability(first), true);
  assert.deepEqual(
    first.providers.map(({ id, models }) => [
      id,
      models.map(({ id: model }) => model),
    ]),
    [
      ["LOCAL", [...reviewedPolicyRuntimeContract.demoModels.local]],
      ["OPENAI", [...reviewedPolicyRuntimeContract.demoModels.openai]],
    ],
  );
  assert.deepEqual(
    first.modes.map(({ id }) => id),
    ["LOCAL", "OPENAI", "COMPARE"],
  );
  assert.equal(
    first.identity.policy.runtimeDigest,
    reviewedPolicyRuntimeContract.provenance.sourceDigest,
  );
  assert.match(first.identity.configuration.digest, /^sha256:[a-f0-9]{64}$/);
});

test("privacy-sensitive Local failure stays Local-only without Cloud fallback", () => {
  const result = evaluator().availability(
    context({ dataClass: "PRIVACY_SENSITIVE_STUDENT_CONTENT" }),
    controls({ local: { state: "UNAVAILABLE" } }),
  );
  assert.equal(isCapabilityAvailability(result), true);
  assert.deepEqual(result.providers, []);
  assert.deepEqual(result.modes, []);
  assert.equal(JSON.stringify(result).includes("OPENAI"), false);
  assert.equal(result.guidance, "NO_PROVIDER_AVAILABLE");
});

test("model-specific health removes an unavailable candidate and authorizes only READY", () => {
  const service = evaluator();
  const state = controls({
    local: {
      runtime: {
        selectedModel: "gemma4:12b-mlx",
        models: [
          { model: "gemma4:12b-mlx", state: "READY" },
          { model: "llama3.1:8b", state: "UNAVAILABLE" },
        ],
      },
    },
    openai: {
      runtime: {
        selectedModel: "gpt-5.6-luna",
        models: [{ model: "gpt-5.6-luna", state: "READY" }],
      },
    },
  });
  const availability = service.availability(context(), state);
  assert.deepEqual(
    availability.providers
      .find(({ id }) => id === "LOCAL")
      .models.map(({ id }) => id),
    ["gemma4:12b-mlx"],
  );
  const denied = service.authorizeSelection(
    context(),
    state,
    { provider: "LOCAL", model: "llama3.1:8b" },
    availability.identity,
  );
  assert.equal(denied.allowed, false);
});

test("model-specific health rejects nested null entries without throwing", () => {
  const malformed = controls({
    local: {
      runtime: {
        selectedModel: "gemma4:12b-mlx",
        models: [null],
      },
    },
  });
  let result;
  assert.doesNotThrow(() => {
    result = evaluator().availability(context(), malformed);
  });
  assert.deepEqual(result.providers, []);
  assert.deepEqual(result.modes, []);
});

test("assessment and Local-only contexts omit OpenAI regardless of otherwise eligible fields", () => {
  for (const changed of [
    context({ activeAssessment: true }),
    context({ dataClass: "IDENTITY_MINIMIZED_USER_TEXT" }),
    context({
      dataClass: "TEMPORARY_UPLOAD",
      inputType: "UPLOAD_REFERENCE",
      artifactState: "TEMPORARY_UPLOAD",
    }),
  ]) {
    const result = evaluator().availability(changed, controls());
    assert.equal(JSON.stringify(result).includes("OPENAI"), false);
  }
});

test("schedule, feature, quota, budget, health and emergency controls fail closed independently", () => {
  const cases = [
    controls({ openai: { scheduleOpen: false } }),
    controls({ openai: { featureEnabled: false } }),
    controls({ openai: { withinBudget: false } }),
    controls({ openai: { quotaAvailable: false } }),
    controls({ openai: { state: "UNAVAILABLE" } }),
    controls({ emergencyStop: true }),
  ];
  for (const state of cases) {
    const result = evaluator().availability(context(), state);
    assert.equal(JSON.stringify(result).includes("OPENAI"), false);
  }
  const cloudFailure = evaluator().availability(
    context(),
    controls({ openai: { state: "UNAVAILABLE" } }),
  );
  assert.deepEqual(
    cloudFailure.providers.map(({ id }) => id),
    ["LOCAL"],
  );
  const localFailure = evaluator().availability(
    context(),
    controls({ local: { state: "UNAVAILABLE" } }),
  );
  assert.deepEqual(
    localFailure.providers.map(({ id }) => id),
    ["LOCAL", "OPENAI"],
  );
  assert.deepEqual(
    localFailure.modes.map(({ id }) => id),
    ["OPENAI"],
  );
});

test("loading, switching and busy are explicit safe Local progress states", () => {
  for (const state of ["LOADING", "SWITCHING", "BUSY"]) {
    const result = evaluator().availability(
      context(),
      controls({
        local: { state },
        openai: { state: "UNAVAILABLE" },
      }),
    );
    assert.equal(result.providers[0].state, state);
    assert.equal(result.guidance, "LOCAL_PROGRESS");
    assert.equal(JSON.stringify(result).includes("OPENAI"), false);
  }
});

test("unknown contexts, unauthorized roles and arbitrary models are rejected", () => {
  const service = evaluator();
  for (const invalid of [
    context({ dataClass: "CLIENT_INVENTED_CLASS" }),
    context({ accessClass: "STUDENT" }),
    context({ courseRef: "course-unapproved" }),
    context({ moduleRef: "module-unapproved" }),
    context({ workflow: "FACULTY_AUTHORING" }),
    context({ learningMode: "SOCRATIC" }),
    context({ inputType: "KNOWLEDGE_REFERENCE" }),
    context({ artifactState: "MINIMIZED_DERIVATION" }),
  ]) {
    const result = service.availability(invalid, controls());
    assert.deepEqual(result.providers, []);
    assert.deepEqual(result.modes, []);
  }
  const denied = service.authorizeSelection(
    context(),
    controls(),
    { provider: "LOCAL", model: "client-invented-model" },
    service.identity,
  );
  assert.equal(denied.allowed, false);
  assert.deepEqual(denied.reasonCodes, ["MODEL_NOT_ALLOWED"]);
  for (const [changedContext, changedSelection] of [
    [
      { ...context(), policyVersion: "client-policy.v99" },
      { provider: "LOCAL", model: "gemma4:12b-mlx" },
    ],
    [
      context(),
      {
        provider: "LOCAL",
        model: "gemma4:12b-mlx",
        providerHealth: "READY",
      },
    ],
    [context(), { provider: "CLIENT_PROVIDER", model: "gemma4:12b-mlx" }],
  ]) {
    const changed = service.authorizeSelection(
      changedContext,
      controls(),
      changedSelection,
      service.identity,
    );
    assert.equal(changed.allowed, false);
    assert.deepEqual(changed.reasonCodes, ["CLIENT_POLICY_OVERRIDE"]);
  }
});

test("accessors and hostile objects cannot supply or crash policy authority", () => {
  const service = evaluator();
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("synthetic hostile input");
      },
    },
  );
  assert.doesNotThrow(() =>
    service.authorizeSelection(hostile, controls(), hostile, service.identity),
  );
  const denied = service.authorizeSelection(
    context(),
    controls(),
    Object.defineProperties(
      {},
      {
        provider: {
          enumerable: true,
          get() {
            throw new Error("must not read");
          },
        },
        model: { enumerable: true, value: "gemma4:12b-mlx" },
      },
    ),
    service.identity,
  );
  assert.equal(denied.allowed, false);
  assert.deepEqual(denied.reasonCodes, ["CLIENT_POLICY_OVERRIDE"]);
  const unavailable = service.availability(context(), hostile);
  assert.deepEqual(unavailable.providers, []);
  assert.equal(isCapabilityAvailability(unavailable), true);

  const cyclic = structuredClone(service.identity);
  cyclic.policy.cyclic = cyclic;
  assert.doesNotThrow(() =>
    service.authorizeSelection(
      context(),
      controls(),
      { provider: "LOCAL", model: "gemma4:12b-mlx" },
      cyclic,
    ),
  );
  let deeplyNested = structuredClone(service.identity);
  for (let depth = 0; depth < 20_000; depth++)
    deeplyNested = { nested: deeplyNested };
  assert.doesNotThrow(() =>
    service.authorizeSelection(
      context(),
      controls(),
      { provider: "LOCAL", model: "gemma4:12b-mlx" },
      deeplyNested,
    ),
  );
});

test("unknown policy identity and client-modified configuration identity fail closed", () => {
  const service = evaluator();
  const stalePolicy = structuredClone(service.identity);
  stalePolicy.policy.policyVersion = "unknown-policy.v99";
  const changedConfiguration = structuredClone(service.identity);
  changedConfiguration.configuration.digest = `sha256:${"0".repeat(64)}`;
  for (const [presented, reason] of [
    [undefined, "POLICY_VERSION_MISMATCH"],
    [stalePolicy, "POLICY_VERSION_MISMATCH"],
    [changedConfiguration, "CLIENT_POLICY_OVERRIDE"],
    [
      { ...service.identity, injectedPolicyField: true },
      "CLIENT_POLICY_OVERRIDE",
    ],
  ]) {
    const decision = service.authorizeSelection(
      context(),
      controls(),
      { provider: "LOCAL", model: "gemma4:12b-mlx" },
      presented,
    );
    assert.equal(decision.allowed, false);
    assert.deepEqual(decision.reasonCodes, [reason]);
  }
});

test("invalid or mismatched runtime configuration cannot create an evaluator", () => {
  for (const value of [
    undefined,
    {},
    {
      ...configuration(),
      provenance: {
        demoProfileVersion: "demo-profile.v1",
        policyVersion: "demo-policy.v1",
      },
    },
    { ...configuration(), clientPolicyOverrideRequested: false },
  ]) {
    assert.equal(createCapabilityEvaluator(value), null);
  }
});

test("response projection excludes credentials, budgets, unrestricted catalogs and policy rules", () => {
  const source = configuration();
  source.providers.openai.secretReference.id =
    "synthetic-secret-reference-marker";
  const service = createCapabilityEvaluator(source);
  assert.ok(service);
  const serialized = JSON.stringify(
    service.availability(context(), controls()),
  );
  for (const marker of [
    "secretReference",
    "synthetic-secret-reference-marker",
    "withinBudget",
    "quotaAvailable",
    "allowRules",
    "denyReasonPrecedence",
    "maxEstimatedUsd",
    "pricing",
  ])
    assert.equal(serialized.includes(marker), false);
});

test("browser conditions deny the server-only policy package", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=browser",
      "--input-type=module",
      "-e",
      'import "@laita/policy";',
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
});
