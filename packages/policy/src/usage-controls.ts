import { createHash } from "node:crypto";
import {
  canonicalJson,
  reviewedPolicyRuntimeContract,
  isUsageAdmissionRequest,
  isUsageReconciliation,
  isUsageTerminalUpdate,
  type CapabilityAvailability,
  type LocalResourceMetadata,
  type ProviderId,
  type ProviderUsage,
  type ProviderUsagePolicy,
  type ProviderUsageRecord,
  type ProviderUsageRepository,
  type ProviderUsageSummary,
  type UsageAdmissionRequest,
  type UsageReconciliation,
  type UsageRepositoryResult,
  type UsageState,
  type UsageTerminalUpdate,
} from "@laita/contracts";
import type {
  CapabilityControlState,
  CapabilityRequestContext,
} from "./index.ts";

export const defaultProviderUsagePolicy = Object.freeze({
  contractVersion: "provider-usage-policy.v1",
  policyVersion: "provider-usage-policy.v1",
  rolloverTimeZone: "UTC",
  perRequest: {
    maxInputTokens:
      reviewedPolicyRuntimeContract.successor.limits.maxInputTokensPerProvider,
    maxOutputTokens: 512,
    maxEstimatedCostNanoUsd: 10_000_000,
  },
  requests: { perSessionDaily: 20, perCourseDaily: 200 },
  concurrency: { global: 1, local: 1, openai: 1 },
  thresholds: {
    warningPercent: 80,
    local: { dailyTokens: 100_000, weeklyTokens: 500_000 },
    openai: {
      dailyTokens: 100_000,
      weeklyTokens: 500_000,
      dailyEstimatedCostNanoUsd: 1_000_000_000,
      weeklyEstimatedCostNanoUsd: 5_000_000_000,
    },
  },
  comparison: {
    maxRunsPerSessionDaily: 10,
    maxEstimatedCostNanoUsdPerRun: 100_000_000,
    dailyEstimatedCostNanoUsd: 250_000_000,
    weeklyEstimatedCostNanoUsd: 1_000_000_000,
  },
  pricing: {
    basis: "openai-gpt-5.6-luna-estimate.v1",
    model: "gpt-5.6-luna",
    inputNanoUsdPerToken: 200,
    cachedInputNanoUsdPerToken: 20,
    outputNanoUsdPerToken: 1200,
    representation: "ESTIMATE_NOT_PROVIDER_BILLING",
  },
} as const satisfies ProviderUsagePolicy);

export type UsageServiceResult<T> =
  | UsageRepositoryResult<T>
  | {
      readonly ok: false;
      readonly code: "INVALID_REQUEST" | "REQUEST_LIMIT";
    };

export interface UsageCapabilitySnapshot {
  readonly contractVersion: "provider-usage-capability.v1";
  readonly local: UsageState;
  readonly openai: UsageState;
  readonly controls: Pick<CapabilityControlState, "local" | "openai">;
}

const digest = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

function utcKeys(now: Date): { day: string; week: string } {
  if (!Number.isFinite(now.valueOf())) throw new Error();
  const day = now.toISOString().slice(0, 10);
  const date = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(
    ((date.valueOf() - yearStart.valueOf()) / 86_400_000 + 1) / 7,
  );
  return {
    day,
    week: `${date.getUTCFullYear()}-W${String(weekNumber).padStart(2, "0")}`,
  };
}

function estimateCost(
  policy: ProviderUsagePolicy,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): number {
  const uncached = inputTokens - cachedInputTokens;
  return (
    uncached * policy.pricing.inputNanoUsdPerToken +
    cachedInputTokens * policy.pricing.cachedInputNanoUsdPerToken +
    outputTokens * policy.pricing.outputNanoUsdPerToken
  );
}

function stateFor(
  used: readonly [number, number][],
  warningPercent: number,
): UsageState {
  if (used.some(([value, limit]) => value >= limit)) return "HARD_STOP";
  if (used.some(([value, limit]) => value * 100 >= limit * warningPercent))
    return "WARNING";
  return "AVAILABLE";
}

function completeUsage(
  usage: ProviderUsage | undefined,
): usage is ProviderUsage & {
  inputTokens: number;
  outputTokens: number;
  providerReported: true;
} {
  return (
    usage?.providerReported === true &&
    Number.isSafeInteger(usage.inputTokens) &&
    Number.isSafeInteger(usage.outputTokens)
  );
}

export function isSafeProviderUsagePolicy(
  value: unknown,
): value is ProviderUsagePolicy {
  try {
    if (!value || typeof value !== "object") return false;
    const policy = value as ProviderUsagePolicy;
    const positive = (entry: unknown) =>
      Number.isSafeInteger(entry) && Number(entry) > 0;
    return (
      policy.contractVersion === "provider-usage-policy.v1" &&
      policy.policyVersion === "provider-usage-policy.v1" &&
      policy.rolloverTimeZone === "UTC" &&
      [
        policy.perRequest.maxInputTokens,
        policy.perRequest.maxOutputTokens,
        policy.perRequest.maxEstimatedCostNanoUsd,
        policy.requests.perSessionDaily,
        policy.requests.perCourseDaily,
        policy.concurrency.global,
        policy.concurrency.local,
        policy.concurrency.openai,
        policy.thresholds.local.dailyTokens,
        policy.thresholds.local.weeklyTokens,
        policy.thresholds.openai.dailyTokens,
        policy.thresholds.openai.weeklyTokens,
        policy.thresholds.openai.dailyEstimatedCostNanoUsd,
        policy.thresholds.openai.weeklyEstimatedCostNanoUsd,
        policy.comparison.maxRunsPerSessionDaily,
        policy.comparison.maxEstimatedCostNanoUsdPerRun,
        policy.comparison.dailyEstimatedCostNanoUsd,
        policy.comparison.weeklyEstimatedCostNanoUsd,
      ].every(positive) &&
      Number.isSafeInteger(policy.thresholds.warningPercent) &&
      policy.thresholds.warningPercent >= 1 &&
      policy.thresholds.warningPercent < 100 &&
      policy.concurrency.global === 1 &&
      policy.concurrency.local === 1 &&
      policy.concurrency.openai === 1 &&
      policy.perRequest.maxInputTokens <= 3584 &&
      policy.perRequest.maxOutputTokens <= 512 &&
      policy.perRequest.maxEstimatedCostNanoUsd <= 10_000_000 &&
      policy.requests.perSessionDaily <= policy.requests.perCourseDaily &&
      policy.thresholds.local.dailyTokens <=
        policy.thresholds.local.weeklyTokens &&
      policy.thresholds.openai.dailyTokens <=
        policy.thresholds.openai.weeklyTokens &&
      policy.thresholds.openai.dailyEstimatedCostNanoUsd <=
        policy.thresholds.openai.weeklyEstimatedCostNanoUsd &&
      policy.comparison.maxEstimatedCostNanoUsdPerRun <= 100_000_000 &&
      policy.comparison.maxEstimatedCostNanoUsdPerRun <=
        policy.comparison.dailyEstimatedCostNanoUsd &&
      policy.comparison.dailyEstimatedCostNanoUsd <=
        policy.comparison.weeklyEstimatedCostNanoUsd &&
      policy.pricing.basis === "openai-gpt-5.6-luna-estimate.v1" &&
      policy.pricing.model === "gpt-5.6-luna" &&
      policy.pricing.inputNanoUsdPerToken === 200 &&
      policy.pricing.cachedInputNanoUsdPerToken === 20 &&
      policy.pricing.outputNanoUsdPerToken === 1200 &&
      policy.pricing.representation === "ESTIMATE_NOT_PROVIDER_BILLING"
    );
  } catch {
    return false;
  }
}

export function createProviderUsageService(
  repository: ProviderUsageRepository,
  policy: ProviderUsagePolicy = defaultProviderUsagePolicy,
  now: () => Date = () => new Date(),
) {
  if (!isSafeProviderUsagePolicy(policy))
    throw new Error("Unsafe provider usage policy");
  function admit(value: unknown): UsageServiceResult<ProviderUsageRecord> {
    if (!isUsageAdmissionRequest(value))
      return { ok: false, code: "INVALID_REQUEST" };
    const request = value;
    if (
      request.inputTokens > policy.perRequest.maxInputTokens ||
      request.maxOutputTokens > policy.perRequest.maxOutputTokens
    )
      return { ok: false, code: "REQUEST_LIMIT" };
    const instant = now();
    const { day, week } = utcKeys(instant);
    const estimatedCostNanoUsd =
      request.provider === "OPENAI"
        ? estimateCost(policy, request.inputTokens, 0, request.maxOutputTokens)
        : null;
    if (
      estimatedCostNanoUsd !== null &&
      estimatedCostNanoUsd > policy.perRequest.maxEstimatedCostNanoUsd
    )
      return { ok: false, code: "REQUEST_LIMIT" };
    const timestamp = instant.toISOString();
    const record: ProviderUsageRecord = Object.freeze({
      contractVersion: "provider-usage-record.v1",
      runRef: request.runRef,
      interactionRef: request.interactionRef,
      attemptRef: request.attemptRef,
      provider: request.provider,
      model: request.model,
      inputTokens: request.inputTokens,
      outputTokens: request.maxOutputTokens,
      totalTokens: request.inputTokens + request.maxOutputTokens,
      estimatedCostNanoUsd,
      costBasis: request.provider === "OPENAI" ? policy.pricing.basis : null,
      costRepresentation:
        request.provider === "OPENAI" ? policy.pricing.representation : null,
      usageBasis: "RESERVED_ESTIMATE",
      policyVersion: request.policyVersion,
      configurationVersion: request.configurationVersion,
      courseRef: request.context.courseRef,
      workflow: request.context.workflow,
      comparison: request.context.comparison,
      outcome: "RESERVED",
      latencyMs: null,
      localResources: null,
      day,
      week,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return repository.reserve({
      request,
      record,
      digest: digest(request),
      limits: {
        globalConcurrency: policy.concurrency.global,
        providerConcurrency:
          request.provider === "LOCAL"
            ? policy.concurrency.local
            : policy.concurrency.openai,
        sessionDailyRequests: policy.requests.perSessionDaily,
        courseDailyRequests: policy.requests.perCourseDaily,
        dailyTokens:
          request.provider === "LOCAL"
            ? policy.thresholds.local.dailyTokens
            : policy.thresholds.openai.dailyTokens,
        weeklyTokens:
          request.provider === "LOCAL"
            ? policy.thresholds.local.weeklyTokens
            : policy.thresholds.openai.weeklyTokens,
        dailyEstimatedCostNanoUsd:
          request.provider === "OPENAI"
            ? policy.thresholds.openai.dailyEstimatedCostNanoUsd
            : null,
        weeklyEstimatedCostNanoUsd:
          request.provider === "OPENAI"
            ? policy.thresholds.openai.weeklyEstimatedCostNanoUsd
            : null,
        comparisonRunsPerSessionDaily: request.context.comparison
          ? policy.comparison.maxRunsPerSessionDaily
          : null,
        comparisonCostPerRunNanoUsd: request.context.comparison
          ? policy.comparison.maxEstimatedCostNanoUsdPerRun
          : null,
        comparisonDailyEstimatedCostNanoUsd: request.context.comparison
          ? policy.comparison.dailyEstimatedCostNanoUsd
          : null,
        comparisonWeeklyEstimatedCostNanoUsd: request.context.comparison
          ? policy.comparison.weeklyEstimatedCostNanoUsd
          : null,
      },
    });
  }

  function normalizedTerminal(
    current: ProviderUsageRecord,
    update: UsageTerminalUpdate,
  ): ProviderUsageRecord | null {
    if (current.outcome !== "RESERVED") return null;
    const reported = completeUsage(update.usage);
    const notInvoked = update.providerContact === "NOT_STARTED";
    const inputTokens = reported
      ? update.usage.inputTokens
      : notInvoked
        ? 0
        : current.inputTokens;
    const outputTokens = reported
      ? update.usage.outputTokens
      : notInvoked
        ? 0
        : current.outputTokens;
    const cached = reported ? (update.usage.cachedInputTokens ?? 0) : 0;
    const estimatedCostNanoUsd =
      current.provider === "OPENAI"
        ? notInvoked
          ? 0
          : reported
            ? estimateCost(policy, inputTokens, cached, outputTokens)
            : current.estimatedCostNanoUsd
        : null;
    if (current.provider === "OPENAI" && update.localResources !== undefined)
      return null;
    return Object.freeze({
      ...current,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCostNanoUsd,
      usageBasis: notInvoked
        ? "NOT_INVOKED"
        : reported
          ? "PROVIDER_REPORTED"
          : "CONSERVATIVE_ESTIMATE",
      outcome: update.outcome,
      latencyMs: update.latencyMs ?? null,
      localResources:
        current.provider === "LOCAL" ? (update.localResources ?? null) : null,
      updatedAt: now().toISOString(),
    });
  }

  function finalize(value: unknown): UsageServiceResult<ProviderUsageRecord> {
    if (!isUsageTerminalUpdate(value))
      return { ok: false, code: "INVALID_REQUEST" };
    const current = repository.read(value.attemptRef);
    if (!current.ok) return current;
    const updated = normalizedTerminal(current.value, value);
    if (!updated) {
      return current.value.outcome === value.outcome
        ? current
        : { ok: false, code: "CONFLICT" };
    }
    return repository.finalize(
      value.attemptRef,
      digest(current.value),
      updated,
    );
  }

  function reconcile(value: unknown): UsageServiceResult<ProviderUsageRecord> {
    if (!isUsageReconciliation(value))
      return { ok: false, code: "INVALID_REQUEST" };
    const update = value as UsageReconciliation;
    const current = repository.read(update.attemptRef);
    if (!current.ok) return current;
    if (current.value.outcome !== "COMPLETED" || !completeUsage(update.usage))
      return { ok: false, code: "CONFLICT" };
    const inputTokens = update.usage.inputTokens;
    const outputTokens = update.usage.outputTokens;
    const cached = update.usage.cachedInputTokens ?? 0;
    const record: ProviderUsageRecord = Object.freeze({
      ...current.value,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCostNanoUsd:
        current.value.provider === "OPENAI"
          ? estimateCost(policy, inputTokens, cached, outputTokens)
          : null,
      usageBasis: "PROVIDER_REPORTED",
      updatedAt: now().toISOString(),
    });
    return repository.reconcile(
      update.attemptRef,
      digest(current.value),
      record,
    );
  }

  function state(
    provider: ProviderId,
    comparison = false,
  ): UsageRepositoryResult<UsageState> {
    const { day, week } = utcKeys(now());
    const result = repository.aggregate(provider, day, week);
    if (!result.ok) return result;
    const aggregate = result.value;
    const limits: [number, number][] = [
      [
        aggregate.dailyTokens,
        provider === "LOCAL"
          ? policy.thresholds.local.dailyTokens
          : policy.thresholds.openai.dailyTokens,
      ],
      [
        aggregate.weeklyTokens,
        provider === "LOCAL"
          ? policy.thresholds.local.weeklyTokens
          : policy.thresholds.openai.weeklyTokens,
      ],
    ];
    if (provider === "OPENAI") {
      limits.push(
        [
          aggregate.dailyEstimatedCostNanoUsd,
          policy.thresholds.openai.dailyEstimatedCostNanoUsd,
        ],
        [
          aggregate.weeklyEstimatedCostNanoUsd,
          policy.thresholds.openai.weeklyEstimatedCostNanoUsd,
        ],
      );
      if (comparison)
        limits.push(
          [
            aggregate.comparisonDailyEstimatedCostNanoUsd,
            policy.comparison.dailyEstimatedCostNanoUsd,
          ],
          [
            aggregate.comparisonWeeklyEstimatedCostNanoUsd,
            policy.comparison.weeklyEstimatedCostNanoUsd,
          ],
        );
    }
    return {
      ok: true,
      value: stateFor(limits, policy.thresholds.warningPercent),
    };
  }

  function capabilityControls(
    context: Pick<CapabilityRequestContext, "moduleRef">,
  ): UsageRepositoryResult<UsageCapabilitySnapshot> {
    const comparison = context.moduleRef === "module-fixed-comparison";
    const local = state("LOCAL", comparison);
    if (!local.ok) return local;
    const openai = state("OPENAI", comparison);
    if (!openai.ok) return openai;
    return {
      ok: true,
      value: Object.freeze({
        contractVersion: "provider-usage-capability.v1",
        local: local.value,
        openai: openai.value,
        controls: {
          local: {
            featureEnabled: true,
            scheduleOpen: true,
            withinBudget: local.value !== "HARD_STOP",
            quotaAvailable: local.value !== "HARD_STOP",
            state: "READY" as const,
          },
          openai: {
            featureEnabled: true,
            scheduleOpen: true,
            withinBudget: openai.value !== "HARD_STOP",
            quotaAvailable: openai.value !== "HARD_STOP",
            state: "READY" as const,
          },
        },
      }),
    };
  }

  function summary(): UsageServiceResult<ProviderUsageSummary> {
    const instant = now();
    const { day, week } = utcKeys(instant);
    const local = state("LOCAL");
    if (!local.ok) return local;
    const openai = state("OPENAI");
    if (!openai.ok) return openai;
    const comparison = state("OPENAI", true);
    if (!comparison.ok) return comparison;
    return repository.summary(
      day,
      week,
      instant.toISOString(),
      policy.policyVersion,
      {
        local: local.value,
        openai: openai.value,
        comparison: comparison.value,
      },
    );
  }

  return Object.freeze({
    admit,
    finalize,
    reconcile,
    state,
    capabilityControls,
    summary,
  });
}

export function applyUsageControls(
  base: Partial<CapabilityControlState>,
  usage: UsageCapabilitySnapshot,
): Partial<CapabilityControlState> {
  return {
    ...base,
    local: {
      ...usage.controls.local,
      ...base.local,
      withinBudget: usage.controls.local.withinBudget,
      quotaAvailable: usage.controls.local.quotaAvailable,
    },
    openai: {
      ...usage.controls.openai,
      ...base.openai,
      withinBudget: usage.controls.openai.withinBudget,
      quotaAvailable: usage.controls.openai.quotaAvailable,
    },
  };
}

export type UsageCapabilityReader = (
  context: CapabilityRequestContext,
) => CapabilityAvailability | undefined;
