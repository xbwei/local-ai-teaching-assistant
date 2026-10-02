import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createCapabilityEvaluator,
  createDemoCapabilityContext,
  createInstructorPolicyService,
  defaultInstructorPolicy,
  instructorPolicyDigest,
  isSafeInstructorPolicy,
  scheduleIsOpen,
  successorInstructorPolicy,
} from "../dist/index.js";

const configuration = JSON.parse(
  readFileSync(
    new URL("../../runtime/examples/openai-demo.example.json", import.meta.url),
    "utf8",
  ),
);
const clone = (value) => structuredClone(value);
const changed = (update) => ({
  ...clone(defaultInstructorPolicy),
  ...update,
});
const state = (version, policy, activatedAt = "2026-09-04T12:00:00.000Z") => ({
  contractVersion: "instructor-policy-state.v1",
  version,
  digest: instructorPolicyDigest(policy),
  activatedAt,
  policy: clone(policy),
});
function memoryRepository(initial = defaultInstructorPolicy) {
  const versions = [state(1, initial)];
  const history = [];
  return {
    read: () => ({ ok: true, value: versions.at(-1) }),
    history: () => ({ ok: true, value: clone(history) }),
    activate(expectedVersion, policy, actorRole, change, timestamp) {
      if (versions.at(-1).version !== expectedVersion)
        return { ok: false, code: "CONFLICT" };
      const next = state(expectedVersion + 1, policy, timestamp);
      versions.push(next);
      history.unshift({
        contractVersion: "instructor-policy-history.v1",
        version: next.version,
        previousVersion: expectedVersion,
        actorRole,
        change,
        timestamp,
        policyDigest: next.digest,
      });
      return { ok: true, value: clone(next) };
    },
    rollback(expectedVersion, actorRole, timestamp) {
      if (versions.at(-1).version !== expectedVersion)
        return { ok: false, code: "CONFLICT" };
      const previous = versions.find(
        (candidate) => candidate.version === expectedVersion - 1,
      );
      if (!previous) return { ok: false, code: "NOT_FOUND" };
      return this.activate(
        expectedVersion,
        previous.policy,
        actorRole,
        "ROLLBACK",
        timestamp,
      );
    },
  };
}
const ready = {
  local: {
    featureEnabled: true,
    scheduleOpen: true,
    withinBudget: true,
    quotaAvailable: true,
    state: "READY",
  },
  openai: {
    featureEnabled: true,
    scheduleOpen: true,
    withinBudget: true,
    quotaAvailable: true,
    state: "READY",
  },
};

test("schedule uses a half-open instant boundary and validates IANA offsets across DST", () => {
  const policy = changed({
    schedule: {
      timeZone: "America/New_York",
      startsAt: "2026-11-01T01:30:00-04:00",
      endsAt: "2026-11-01T01:30:00-05:00",
    },
  });
  assert.equal(isSafeInstructorPolicy(policy), true);
  assert.equal(scheduleIsOpen(policy, new Date("2026-11-01T05:29:59Z")), false);
  assert.equal(scheduleIsOpen(policy, new Date("2026-11-01T05:30:00Z")), true);
  assert.equal(scheduleIsOpen(policy, new Date("2026-11-01T06:29:59Z")), true);
  assert.equal(scheduleIsOpen(policy, new Date("2026-11-01T06:30:00Z")), false);
  assert.equal(
    isSafeInstructorPolicy({
      ...policy,
      schedule: { ...policy.schedule, endsAt: "2026-11-01T01:30:00-04:00" },
    }),
    false,
  );
  assert.equal(
    isSafeInstructorPolicy({
      ...policy,
      schedule: { ...policy.schedule, timeZone: "Unknown/Zone" },
    }),
    false,
  );
});

test("approved model controls only narrow the reviewed evaluator and hidden model requests fail closed", () => {
  const evaluator = createCapabilityEvaluator(configuration);
  assert.ok(evaluator);
  const repository = memoryRepository(
    changed({
      cloudEnabled: true,
      models: {
        local: ["gemma4:12b-mlx"],
        activeLocal: "gemma4:12b-mlx",
        openai: ["gpt-5.6-luna"],
      },
    }),
  );
  const service = createInstructorPolicyService(
    repository,
    evaluator,
    () => new Date("2026-09-04T12:00:00Z"),
  );
  const context = createDemoCapabilityContext("INSTRUCTOR");
  const capability = service.capability(context, ready);
  assert.equal(capability.ok, true);
  assert.deepEqual(
    capability.value.providers.map((provider) => [
      provider.id,
      provider.models.map((model) => model.id),
    ]),
    [
      ["LOCAL", ["gemma4:12b-mlx"]],
      ["OPENAI", ["gpt-5.6-luna"]],
    ],
  );
  for (const selection of [
    { provider: "LOCAL", model: "hidden-local" },
    { provider: "OPENAI", model: "gpt-hidden" },
  ]) {
    const decision = service.authorizeSelection(
      context,
      selection,
      evaluator.identity,
      ready,
    );
    assert.equal(decision.ok, true);
    assert.equal(decision.value.allowed, false);
  }
  const outsideComparison = {
    ...context,
    moduleRef: "module-outside-fixed-comparison",
  };
  for (const selection of [
    { provider: "LOCAL", model: "llama3.1:8b" },
    { provider: "OPENAI", model: "gpt-5.6-luna" },
  ]) {
    const decision = service.authorizeSelection(
      outsideComparison,
      selection,
      evaluator.identity,
      ready,
    );
    assert.equal(decision.ok, true);
    assert.equal(decision.value.allowed, false);
  }
  assert.equal(
    isSafeInstructorPolicy({
      ...clone(defaultInstructorPolicy),
      models: {
        local: ["arbitrary-model"],
        activeLocal: "arbitrary-model",
        openai: ["gpt-5.6-luna"],
      },
    }),
    false,
  );
});

test("emergency Cloud disable is immediate for new evaluations and leaves Local intact", () => {
  const evaluator = createCapabilityEvaluator(configuration);
  assert.ok(evaluator);
  const repository = memoryRepository(changed({ cloudEnabled: true }));
  const service = createInstructorPolicyService(repository, evaluator);
  const context = createDemoCapabilityContext("INSTRUCTOR");
  const before = service.capability(context, ready);
  assert.deepEqual(
    before.value.providers.map((provider) => provider.id),
    ["LOCAL", "OPENAI"],
  );
  assert.equal(service.emergencyDisable(1, "ADMIN").ok, true);
  const after = service.capability(context, ready);
  assert.deepEqual(
    after.value.providers.map((provider) => provider.id),
    ["LOCAL"],
  );
  assert.deepEqual(
    after.value.modes.map((mode) => mode.id),
    ["LOCAL"],
  );
});

test("student and shared-kiosk contexts receive no comparison or model catalog", () => {
  const evaluator = createCapabilityEvaluator(configuration);
  assert.ok(evaluator);
  const service = createInstructorPolicyService(
    memoryRepository(changed({ cloudEnabled: true })),
    evaluator,
  );
  for (const accessClass of ["STUDENT", "ANONYMOUS_SESSION"]) {
    const result = service.capability(
      createDemoCapabilityContext(accessClass),
      ready,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.providers, []);
    assert.deepEqual(result.value.modes, []);
  }
});

test("preview is side-effect free and equals the capability after exact digest activation", () => {
  const evaluator = createCapabilityEvaluator(configuration);
  assert.ok(evaluator);
  const repository = memoryRepository();
  const instant = new Date("2026-09-04T12:00:00Z");
  const service = createInstructorPolicyService(
    repository,
    evaluator,
    () => instant,
  );
  const policy = changed({ cloudEnabled: true });
  const preview = service.preview(1, policy, ready);
  assert.equal(preview.ok, true);
  assert.equal(repository.read().value.version, 1);
  assert.deepEqual(
    service.activate(1, "sha256:" + "0".repeat(64), policy, "INSTRUCTOR"),
    { ok: false, code: "INVALID_POLICY" },
  );
  const activated = service.activate(
    1,
    preview.value.policyDigest,
    policy,
    "INSTRUCTOR",
  );
  assert.equal(activated.ok, true);
  const actual = service.capability(
    createDemoCapabilityContext("INSTRUCTOR"),
    ready,
  );
  assert.deepEqual(actual.value, preview.value.capability);
});

test("each course, role, workflow, learning mode, input and data-class control fails closed", () => {
  const evaluator = createCapabilityEvaluator(configuration);
  assert.ok(evaluator);
  for (const eligibility of [
    { courseRefs: ["other-course"] },
    { accessClasses: [] },
    { workflows: [] },
    { learningModes: [] },
    { inputTypes: [] },
    { dataClasses: [] },
  ]) {
    const policy = clone(defaultInstructorPolicy);
    policy.eligibility = { ...policy.eligibility, ...eligibility };
    assert.equal(isSafeInstructorPolicy(policy), false);
  }
});

test("service initialization rejects unavailable or unsafe active policy state", () => {
  const evaluator = createCapabilityEvaluator(configuration);
  assert.ok(evaluator);
  assert.throws(
    () =>
      createInstructorPolicyService(
        {
          ...memoryRepository(),
          read: () => ({ ok: false, code: "SERVICE_UNAVAILABLE" }),
        },
        evaluator,
      ),
    /unavailable or unsafe/u,
  );
  const unsafe = clone(defaultInstructorPolicy);
  unsafe.models.activeLocal = "hidden-local";
  assert.throws(
    () => createInstructorPolicyService(memoryRepository(unsafe), evaluator),
    /unavailable or unsafe/u,
  );
});

test("successor instructor controls preserve frozen v2 and v4 explicit Owner Cloud authority", () => {
  assert.equal(isSafeInstructorPolicy(defaultInstructorPolicy), true);
  assert.deepEqual(defaultInstructorPolicy.eligibility.dataClasses, [
    "IDENTITY_FREE_USER_TEXT",
  ]);
  assert.equal(isSafeInstructorPolicy(successorInstructorPolicy), true);
  for (const version of [2, 4]) {
    const evaluator = createCapabilityEvaluator({
      ...configuration,
      provenance: {
        demoProfileVersion: `demo-profile.v${version}`,
        policyVersion: `demo-policy.v${version}`,
      },
    });
    assert.ok(evaluator);
    const policy = {
      ...clone(successorInstructorPolicy),
      cloudEnabled: true,
      schedule: {
        timeZone: "UTC",
        startsAt: "2026-09-04T11:00:00Z",
        endsAt: "2026-09-04T13:00:00Z",
      },
    };
    const service = createInstructorPolicyService(
      memoryRepository(policy),
      evaluator,
      () => new Date("2026-09-04T12:00:00Z"),
    );
    const minimized = {
      ...createDemoCapabilityContext("INSTRUCTOR"),
      dataClass: "IDENTITY_MINIMIZED_USER_TEXT",
    };
    const result = service.capability(minimized, ready);
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.value.providers.map((p) => [p.id, p.models.map((m) => m.id)]),
      version === 4
        ? [
            ["LOCAL", policy.models.local],
            ["OPENAI", policy.models.openai],
          ]
        : [],
    );
    assert.deepEqual(
      result.value.modes.map((m) => m.id),
      version === 4 ? ["LOCAL", "OPENAI", "COMPARE"] : [],
    );
    for (const selection of [
      { provider: "LOCAL", model: policy.models.activeLocal },
      { provider: "OPENAI", model: "gpt-5.6-luna" },
      { provider: "LOCAL", model: "llama3.1:8b" },
      { provider: "UNKNOWN", model: policy.models.activeLocal },
      { provider: "LOCAL", model: "unapproved" },
    ]) {
      assert.equal(
        service.authorizeSelection(
          minimized,
          selection,
          evaluator.identity,
          ready,
        ).value.allowed,
        version === 4 &&
          ((selection.provider === "LOCAL" &&
            policy.models.local.includes(selection.model)) ||
            (selection.provider === "OPENAI" &&
              policy.models.openai.includes(selection.model))),
      );
    }
    const free = service.capability(
      createDemoCapabilityContext("INSTRUCTOR"),
      ready,
    );
    assert.deepEqual(
      free.value.modes.map((m) => m.id),
      ["LOCAL", "OPENAI", "COMPARE"],
    );
    for (const override of [
      { accessClass: "STUDENT" },
      { accessClass: "ANONYMOUS_SESSION" },
      { dataClass: "PRIVACY_SENSITIVE_STUDENT_CONTENT" },
      { dataClass: "UNKNOWN" },
      { courseRef: "course-unapproved" },
      { workflow: "FACULTY_AUTHORING" },
      { learningMode: "SOCRATIC" },
      { inputType: "UPLOAD_REFERENCE" },
      { activeAssessment: true },
    ]) {
      assert.deepEqual(
        service.capability({ ...minimized, ...override }, ready).value
          .providers,
        [],
      );
    }
    for (const field of [
      "featureEnabled",
      "withinBudget",
      "quotaAvailable",
      "state",
    ]) {
      const health = {
        ...ready,
        local: {
          ...ready.local,
          [field]: field === "state" ? "UNAVAILABLE" : false,
        },
      };
      const unavailable = service.capability(minimized, health).value;
      assert.equal(
        unavailable.providers.some((p) => p.id === "OPENAI"),
        version === 4,
      );
      assert.deepEqual(
        unavailable.modes.map((m) => m.id),
        version === 4 ? ["OPENAI"] : [],
      );
      assert.equal(
        service.authorizeSelection(
          minimized,
          { provider: "LOCAL", model: policy.models.activeLocal },
          evaluator.identity,
          health,
        ).value.allowed,
        false,
      );
    }
    const closed = createInstructorPolicyService(
      memoryRepository(policy),
      evaluator,
      () => new Date("2026-09-04T13:00:00Z"),
    );
    assert.deepEqual(closed.capability(minimized, ready).value.modes, []);
    assert.equal(
      closed.authorizeSelection(
        minimized,
        { provider: "LOCAL", model: policy.models.activeLocal },
        evaluator.identity,
        ready,
      ).value.allowed,
      false,
    );
    assert.equal(service.emergencyDisable(1, "ADMIN").ok, true);
    assert.deepEqual(
      service.capability(minimized, ready).value.modes.map((m) => m.id),
      version === 4 ? ["LOCAL"] : [],
    );
  }
});
