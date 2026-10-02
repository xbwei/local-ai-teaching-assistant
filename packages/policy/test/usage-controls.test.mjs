import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyUsageControls,
  createCapabilityEvaluator,
  createDemoCapabilityContext,
  createInstructorPolicyService,
  createProviderUsageService,
  defaultInstructorPolicy,
  defaultProviderUsagePolicy,
  isSafeProviderUsagePolicy,
} from "../dist/index.js";

const configuration = JSON.parse(
  readFileSync(
    new URL("../../runtime/examples/openai-demo.example.json", import.meta.url),
    "utf8",
  ),
);
const uuid = (number) =>
  `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
const admission = (number, update = {}) => ({
  contractVersion: "provider-usage-admission.v1",
  runRef: `run-${uuid(number)}`,
  interactionRef: `interaction-${uuid(number)}`,
  attemptRef: `attempt-${uuid(number)}`,
  sessionRef: `session-${uuid(1)}`,
  provider: "OPENAI",
  model: "gpt-5.6-luna",
  inputTokens: 4,
  maxOutputTokens: 6,
  policyVersion: "instructor-policy.v1",
  configurationVersion: "openai-demo.v1",
  context: {
    courseRef: "course-synthetic-demo",
    workflow: "COURSE_QA",
    comparison: false,
  },
  ...update,
});

function memoryRepository() {
  const entries = new Map();
  const sum = (records, key) =>
    records.reduce((total, record) => total + (record[key] ?? 0), 0);
  const aggregate = (provider, day, week, comparisonRef) => {
    const all = [...entries.values()];
    const providerRows = all.filter(
      (entry) => entry.record.provider === provider,
    );
    const daily = providerRows.filter((entry) => entry.record.day === day);
    const weekly = providerRows.filter((entry) => entry.record.week === week);
    const comparisonDaily = daily.filter((entry) => entry.record.comparison);
    const comparisonWeekly = weekly.filter((entry) => entry.record.comparison);
    return {
      ok: true,
      value: {
        activeGlobal: all.filter((entry) => entry.record.outcome === "RESERVED")
          .length,
        activeProvider: providerRows.filter(
          (entry) => entry.record.outcome === "RESERVED",
        ).length,
        dailyRequests: daily.length,
        dailyTokens: sum(
          daily.map((entry) => entry.record),
          "totalTokens",
        ),
        weeklyTokens: sum(
          weekly.map((entry) => entry.record),
          "totalTokens",
        ),
        dailyEstimatedCostNanoUsd: sum(
          daily.map((entry) => entry.record),
          "estimatedCostNanoUsd",
        ),
        weeklyEstimatedCostNanoUsd: sum(
          weekly.map((entry) => entry.record),
          "estimatedCostNanoUsd",
        ),
        comparisonDailyRequests: new Set(
          comparisonDaily.map(
            (entry) => entry.command.request.context.comparisonRef,
          ),
        ).size,
        comparisonRunEstimatedCostNanoUsd: sum(
          providerRows
            .filter(
              (entry) =>
                entry.command.request.context.comparisonRef === comparisonRef,
            )
            .map((entry) => entry.record),
          "estimatedCostNanoUsd",
        ),
        comparisonDailyEstimatedCostNanoUsd: sum(
          comparisonDaily.map((entry) => entry.record),
          "estimatedCostNanoUsd",
        ),
        comparisonWeeklyEstimatedCostNanoUsd: sum(
          comparisonWeekly.map((entry) => entry.record),
          "estimatedCostNanoUsd",
        ),
      },
    };
  };
  return {
    entries,
    reserve(command) {
      const existing = entries.get(command.request.attemptRef);
      if (existing)
        return existing.command.digest === command.digest
          ? { ok: true, value: structuredClone(existing.record) }
          : { ok: false, code: "CONFLICT" };
      const { request, record, limits } = command;
      const totals = aggregate(
        request.provider,
        record.day,
        record.week,
        request.context.comparisonRef,
      ).value;
      const records = [...entries.values()];
      const sessionCount = records.filter(
        (entry) =>
          entry.command.request.provider === request.provider &&
          entry.command.request.sessionRef === request.sessionRef &&
          entry.record.day === record.day,
      ).length;
      const courseCount = records.filter(
        (entry) =>
          entry.command.request.provider === request.provider &&
          entry.record.courseRef === record.courseRef &&
          entry.record.day === record.day,
      ).length;
      const cost = record.estimatedCostNanoUsd ?? 0;
      for (const [denied, code] of [
        [totals.activeGlobal >= limits.globalConcurrency, "CONCURRENCY_LIMIT"],
        [
          totals.activeProvider >= limits.providerConcurrency,
          "CONCURRENCY_LIMIT",
        ],
        [sessionCount >= limits.sessionDailyRequests, "SESSION_LIMIT"],
        [courseCount >= limits.courseDailyRequests, "COURSE_LIMIT"],
        [
          totals.dailyTokens + record.totalTokens > limits.dailyTokens,
          "DAILY_TOKEN_LIMIT",
        ],
        [
          totals.weeklyTokens + record.totalTokens > limits.weeklyTokens,
          "WEEKLY_TOKEN_LIMIT",
        ],
        [
          limits.dailyEstimatedCostNanoUsd !== null &&
            totals.dailyEstimatedCostNanoUsd + cost >
              limits.dailyEstimatedCostNanoUsd,
          "DAILY_BUDGET_LIMIT",
        ],
        [
          limits.weeklyEstimatedCostNanoUsd !== null &&
            totals.weeklyEstimatedCostNanoUsd + cost >
              limits.weeklyEstimatedCostNanoUsd,
          "WEEKLY_BUDGET_LIMIT",
        ],
        [
          request.context.comparison &&
            totals.comparisonRunEstimatedCostNanoUsd + cost >
              limits.comparisonCostPerRunNanoUsd,
          "COMPARISON_LIMIT",
        ],
        [
          request.context.comparison &&
            totals.comparisonDailyRequests >=
              limits.comparisonRunsPerSessionDaily,
          "COMPARISON_LIMIT",
        ],
        [
          request.context.comparison &&
            totals.comparisonDailyEstimatedCostNanoUsd + cost >
              limits.comparisonDailyEstimatedCostNanoUsd,
          "COMPARISON_LIMIT",
        ],
        [
          request.context.comparison &&
            totals.comparisonWeeklyEstimatedCostNanoUsd + cost >
              limits.comparisonWeeklyEstimatedCostNanoUsd,
          "COMPARISON_LIMIT",
        ],
      ])
        if (denied) return { ok: false, code };
      entries.set(request.attemptRef, {
        command: structuredClone(command),
        record: structuredClone(record),
      });
      return { ok: true, value: structuredClone(record) };
    },
    read(attemptRef) {
      const entry = entries.get(attemptRef);
      return entry
        ? { ok: true, value: structuredClone(entry.record) }
        : { ok: false, code: "NOT_FOUND" };
    },
    finalize(attemptRef, _digest, record) {
      const entry = entries.get(attemptRef);
      if (!entry || entry.record.outcome !== "RESERVED")
        return { ok: false, code: "CONFLICT" };
      entry.record = structuredClone(record);
      return { ok: true, value: structuredClone(record) };
    },
    reconcile(attemptRef, _expectedDigest, record) {
      const entry = entries.get(attemptRef);
      if (!entry || entry.record.outcome !== "COMPLETED")
        return { ok: false, code: "CONFLICT" };
      entry.record = structuredClone(record);
      return { ok: true, value: structuredClone(record) };
    },
    aggregate,
    summary() {
      return { ok: false, code: "SERVICE_UNAVAILABLE" };
    },
  };
}

const terminal = (attemptRef, update = {}) => ({
  contractVersion: "provider-usage-terminal.v1",
  attemptRef,
  outcome: "COMPLETED",
  providerContact: "MAY_HAVE_OCCURRED",
  ...update,
});

test("reviewed usage policy preserves the bounded memory envelope and request bounds", () => {
  assert.equal(isSafeProviderUsagePolicy(defaultProviderUsagePolicy), true);
  assert.equal(defaultProviderUsagePolicy.concurrency.global, 1);
  assert.equal(defaultProviderUsagePolicy.concurrency.local, 1);
  assert.equal(defaultProviderUsagePolicy.perRequest.maxInputTokens, 3584);
  assert.equal(defaultProviderUsagePolicy.perRequest.maxOutputTokens, 512);
  assert.equal(
    defaultProviderUsagePolicy.pricing.representation,
    "ESTIMATE_NOT_PROVIDER_BILLING",
  );
  assert.equal(
    isSafeProviderUsagePolicy({
      ...structuredClone(defaultProviderUsagePolicy),
      concurrency: { global: 2, local: 2, openai: 1 },
    }),
    false,
  );
});

test("exact request/token limit is accepted and one-over is rejected", () => {
  const repository = memoryRepository();
  const service = createProviderUsageService(repository);
  const exact = service.admit(
    admission(1, { inputTokens: 3584, maxOutputTokens: 512 }),
  );
  assert.equal(exact.ok, true);
  assert.equal(
    service.admit(admission(2, { inputTokens: 3585 })).code,
    "REQUEST_LIMIT",
  );
  assert.equal(
    service.admit(admission(3, { maxOutputTokens: 513 })).code,
    "REQUEST_LIMIT",
  );
});

test("missing usage and failed/cancelled/timeout provider contact keep conservative reservations", () => {
  for (const outcome of ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]) {
    const repository = memoryRepository();
    const service = createProviderUsageService(repository);
    const request = admission(outcome.length);
    const admitted = service.admit(request);
    assert.equal(admitted.ok, true);
    const result = service.finalize(terminal(request.attemptRef, { outcome }));
    assert.equal(result.ok, true);
    assert.equal(result.value.usageBasis, "CONSERVATIVE_ESTIMATE");
    assert.equal(result.value.totalTokens, 10);
    assert.ok(result.value.estimatedCostNanoUsd > 0);
  }
  const repository = memoryRepository();
  const service = createProviderUsageService(repository);
  const request = admission(9);
  service.admit(request);
  const beforeProvider = service.finalize(
    terminal(request.attemptRef, {
      outcome: "CANCELLED",
      providerContact: "NOT_STARTED",
    }),
  );
  assert.equal(beforeProvider.value.usageBasis, "NOT_INVOKED");
  assert.equal(beforeProvider.value.totalTokens, 0);
  assert.equal(beforeProvider.value.estimatedCostNanoUsd, 0);
});

test("completed missing metadata reconciles once provider-reported usage arrives", () => {
  const repository = memoryRepository();
  let instant = new Date("2026-12-31T23:59:59.000Z");
  const service = createProviderUsageService(
    repository,
    defaultProviderUsagePolicy,
    () => instant,
  );
  const request = admission(10);
  service.admit(request);
  const completed = service.finalize(terminal(request.attemptRef));
  assert.equal(completed.value.usageBasis, "CONSERVATIVE_ESTIMATE");
  instant = new Date("2027-01-01T00:00:01.000Z");
  const reconciled = service.reconcile({
    contractVersion: "provider-usage-reconciliation.v1",
    attemptRef: request.attemptRef,
    usage: {
      providerReported: true,
      inputTokens: 3,
      cachedInputTokens: 1,
      outputTokens: 2,
      totalTokens: 5,
    },
  });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.value.usageBasis, "PROVIDER_REPORTED");
  assert.equal(reconciled.value.totalTokens, 5);
  assert.equal(reconciled.value.day, "2026-12-31");
  assert.equal(reconciled.value.week, "2026-W53");
});

test("retry attempt is idempotent and never double-counts while distinct retry is accounted", () => {
  const repository = memoryRepository();
  let instant = new Date("2026-09-05T12:00:00.000Z");
  const service = createProviderUsageService(
    repository,
    undefined,
    () => instant,
  );
  const request = admission(11);
  assert.equal(service.admit(request).ok, true);
  instant = new Date("2026-09-05T12:00:01.000Z");
  assert.equal(service.admit(structuredClone(request)).ok, true);
  assert.equal(repository.entries.size, 1);
  service.finalize(
    terminal(request.attemptRef, {
      outcome: "CANCELLED",
      providerContact: "NOT_STARTED",
    }),
  );
  const retry = admission(12, {
    runRef: request.runRef,
    interactionRef: request.interactionRef,
  });
  assert.equal(service.admit(retry).ok, true);
  assert.equal(repository.entries.size, 2);
  assert.equal(service.admit({ ...retry, inputTokens: 5 }).code, "CONFLICT");
});

test("daily and ISO-week rollover are deterministic UTC boundaries", () => {
  const repository = memoryRepository();
  let instant = new Date("2027-01-03T23:59:59.999Z");
  const service = createProviderUsageService(
    repository,
    defaultProviderUsagePolicy,
    () => instant,
  );
  const first = admission(13);
  service.admit(first);
  service.finalize(
    terminal(first.attemptRef, {
      outcome: "CANCELLED",
      providerContact: "NOT_STARTED",
    }),
  );
  assert.equal(
    repository.entries.get(first.attemptRef).record.week,
    "2026-W53",
  );
  instant = new Date("2027-01-04T00:00:00.000Z");
  const second = admission(14);
  service.admit(second);
  assert.equal(
    repository.entries.get(second.attemptRef).record.day,
    "2027-01-04",
  );
  assert.equal(
    repository.entries.get(second.attemptRef).record.week,
    "2027-W01",
  );
});

test("session and course request limits count admitted attempts exactly", () => {
  const policy = structuredClone(defaultProviderUsagePolicy);
  policy.requests.perSessionDaily = 1;
  policy.requests.perCourseDaily = 2;
  const repository = memoryRepository();
  const service = createProviderUsageService(repository, policy);
  const first = admission(30);
  assert.equal(service.admit(first).ok, true);
  service.finalize(
    terminal(first.attemptRef, {
      outcome: "CANCELLED",
      providerContact: "NOT_STARTED",
    }),
  );
  assert.equal(service.admit(admission(31)).code, "SESSION_LIMIT");
  const second = admission(32, { sessionRef: `session-${uuid(2)}` });
  assert.equal(service.admit(second).ok, true);
  service.finalize(
    terminal(second.attemptRef, {
      outcome: "CANCELLED",
      providerContact: "NOT_STARTED",
    }),
  );
  const third = admission(33, { sessionRef: `session-${uuid(3)}` });
  assert.equal(service.admit(third).code, "COURSE_LIMIT");
});

test("warning and bounded Compare hard-stop states are distinct", () => {
  const warningPolicy = structuredClone(defaultProviderUsagePolicy);
  warningPolicy.thresholds.openai.dailyTokens = 10;
  warningPolicy.thresholds.openai.weeklyTokens = 100;
  const warningRepository = memoryRepository();
  const warning = createProviderUsageService(warningRepository, warningPolicy);
  const warningRequest = admission(34, { inputTokens: 4, maxOutputTokens: 4 });
  warning.admit(warningRequest);
  warning.finalize(terminal(warningRequest.attemptRef));
  assert.equal(warning.state("OPENAI").value, "WARNING");

  const comparePolicy = structuredClone(defaultProviderUsagePolicy);
  comparePolicy.comparison.maxEstimatedCostNanoUsdPerRun = 8_000;
  comparePolicy.comparison.dailyEstimatedCostNanoUsd = 8_000;
  comparePolicy.comparison.weeklyEstimatedCostNanoUsd = 8_000;
  const compareRepository = memoryRepository();
  const compare = createProviderUsageService(compareRepository, comparePolicy);
  const comparison = (number) =>
    admission(number, {
      context: {
        courseRef: "course-synthetic-demo",
        workflow: "COURSE_QA",
        comparison: true,
        comparisonRef: `comparison-${uuid(number)}`,
      },
    });
  const firstCompare = comparison(35);
  assert.equal(compare.admit(firstCompare).ok, true);
  compare.finalize(terminal(firstCompare.attemptRef));
  assert.equal(compare.state("OPENAI", true).value, "HARD_STOP");
  assert.equal(compare.state("OPENAI", false).value, "AVAILABLE");
  assert.equal(compare.admit(comparison(36)).code, "COMPARISON_LIMIT");
});

test("Local accounting records safe operational metrics without dollar cost", () => {
  const repository = memoryRepository();
  const service = createProviderUsageService(repository);
  const request = admission(37, {
    provider: "LOCAL",
    model: "gemma4:12b-mlx",
  });
  assert.equal(service.admit(request).value.estimatedCostNanoUsd, null);
  const completed = service.finalize(
    terminal(request.attemptRef, {
      usage: {
        providerReported: true,
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
      },
      latencyMs: 125,
      localResources: {
        status: "MEASURED",
        processMemoryBytes: 1024,
        systemMemoryPressure: "NORMAL",
        swapDeltaBytes: 0,
      },
    }),
  );
  assert.equal(completed.ok, true);
  assert.equal(completed.value.estimatedCostNanoUsd, null);
  assert.equal(completed.value.costBasis, null);
  assert.equal(completed.value.latencyMs, 125);
  assert.equal(completed.value.localResources.systemMemoryPressure, "NORMAL");
});

test("OpenAI hard stop removes Cloud while Local remains", () => {
  const policy = structuredClone(defaultProviderUsagePolicy);
  policy.thresholds.openai.dailyTokens = 10;
  policy.thresholds.openai.weeklyTokens = 10;
  const repository = memoryRepository();
  const usage = createProviderUsageService(
    repository,
    policy,
    () => new Date("2026-09-05T12:00:00.000Z"),
  );
  const request = admission(15);
  assert.equal(usage.admit(request).ok, true);
  usage.finalize(terminal(request.attemptRef));
  const snapshot = usage.capabilityControls(
    createDemoCapabilityContext("INSTRUCTOR"),
  );
  assert.equal(snapshot.value.openai, "HARD_STOP");
  assert.equal(snapshot.value.local, "AVAILABLE");

  const evaluator = createCapabilityEvaluator(configuration);
  const instructorPolicy = {
    ...structuredClone(defaultInstructorPolicy),
    cloudEnabled: true,
  };
  const policyRepository = {
    read: () => ({
      ok: true,
      value: {
        contractVersion: "instructor-policy-state.v1",
        version: 1,
        digest: "sha256:" + "a".repeat(64),
        activatedAt: "2026-09-05T12:00:00.000Z",
        policy: instructorPolicy,
      },
    }),
    history: () => ({ ok: true, value: [] }),
    activate: () => ({ ok: false, code: "CONFLICT" }),
    rollback: () => ({ ok: false, code: "NOT_FOUND" }),
  };
  const controls = createInstructorPolicyService(
    policyRepository,
    evaluator,
    () => new Date("2026-09-05T12:00:00.000Z"),
  );
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
  const capability = controls.capability(
    createDemoCapabilityContext("INSTRUCTOR"),
    applyUsageControls(ready, snapshot.value),
  );
  assert.deepEqual(
    capability.value.providers.map((provider) => provider.id),
    ["LOCAL"],
  );
});

test("client-supplied usage/cost/private fields cannot expand admission", () => {
  const service = createProviderUsageService(memoryRepository());
  for (const extra of [
    { estimatedCostNanoUsd: 0 },
    { prompt: "synthetic-private-prompt" },
    { studentIdentity: "synthetic-student" },
    { credential: "synthetic-secret" },
    { ip: "192.0.2.10" },
  ])
    assert.equal(
      service.admit({ ...admission(20), ...extra }).code,
      "INVALID_REQUEST",
    );
});
