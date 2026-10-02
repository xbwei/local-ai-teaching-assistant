import type {
  ProviderId,
  ProviderUsage,
  LocalResourceMetadata,
} from "./provider.ts";
import type { Workflow } from "./policy-contract.generated.ts";

export type UsageState = "AVAILABLE" | "WARNING" | "HARD_STOP";
export type UsageOutcome = "COMPLETED" | "FAILED" | "CANCELLED" | "TIMEOUT";

export interface ProviderUsagePolicy {
  readonly contractVersion: "provider-usage-policy.v1";
  readonly policyVersion: "provider-usage-policy.v1";
  readonly rolloverTimeZone: "UTC";
  readonly perRequest: {
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly maxEstimatedCostNanoUsd: number;
  };
  readonly requests: {
    readonly perSessionDaily: number;
    readonly perCourseDaily: number;
  };
  readonly concurrency: {
    readonly global: number;
    readonly local: number;
    readonly openai: number;
  };
  readonly thresholds: {
    readonly warningPercent: number;
    readonly local: {
      readonly dailyTokens: number;
      readonly weeklyTokens: number;
    };
    readonly openai: {
      readonly dailyTokens: number;
      readonly weeklyTokens: number;
      readonly dailyEstimatedCostNanoUsd: number;
      readonly weeklyEstimatedCostNanoUsd: number;
    };
  };
  readonly comparison: {
    readonly maxRunsPerSessionDaily: number;
    readonly maxEstimatedCostNanoUsdPerRun: number;
    readonly dailyEstimatedCostNanoUsd: number;
    readonly weeklyEstimatedCostNanoUsd: number;
  };
  readonly pricing: {
    readonly basis: "openai-gpt-5.6-luna-estimate.v1";
    readonly model: "gpt-5.6-luna";
    readonly inputNanoUsdPerToken: 200;
    readonly cachedInputNanoUsdPerToken: 20;
    readonly outputNanoUsdPerToken: 1200;
    readonly representation: "ESTIMATE_NOT_PROVIDER_BILLING";
  };
}

export interface UsageAdmissionRequest {
  readonly contractVersion: "provider-usage-admission.v1";
  readonly runRef: `run-${string}`;
  readonly interactionRef: `interaction-${string}`;
  readonly attemptRef: `attempt-${string}`;
  readonly sessionRef: `session-${string}`;
  readonly provider: ProviderId;
  readonly model: string;
  readonly inputTokens: number;
  readonly maxOutputTokens: number;
  readonly policyVersion: string;
  readonly configurationVersion: string;
  readonly context: {
    readonly courseRef: string;
    readonly workflow: Workflow;
    readonly comparison: boolean;
    readonly comparisonRef?: `comparison-${string}`;
  };
}

export interface UsageTerminalUpdate {
  readonly contractVersion: "provider-usage-terminal.v1";
  readonly attemptRef: `attempt-${string}`;
  readonly outcome: UsageOutcome;
  readonly providerContact: "NOT_STARTED" | "MAY_HAVE_OCCURRED";
  readonly usage?: ProviderUsage;
  readonly latencyMs?: number;
  readonly localResources?: LocalResourceMetadata;
}

export interface UsageReconciliation {
  readonly contractVersion: "provider-usage-reconciliation.v1";
  readonly attemptRef: `attempt-${string}`;
  readonly usage: ProviderUsage & { readonly providerReported: true };
}

export interface ProviderUsageRecord {
  readonly contractVersion: "provider-usage-record.v1";
  readonly runRef: `run-${string}`;
  readonly interactionRef: `interaction-${string}`;
  readonly attemptRef: `attempt-${string}`;
  readonly provider: ProviderId;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly estimatedCostNanoUsd: number | null;
  readonly costBasis: "openai-gpt-5.6-luna-estimate.v1" | null;
  readonly costRepresentation: "ESTIMATE_NOT_PROVIDER_BILLING" | null;
  readonly usageBasis:
    | "RESERVED_ESTIMATE"
    | "CONSERVATIVE_ESTIMATE"
    | "PROVIDER_REPORTED"
    | "NOT_INVOKED";
  readonly policyVersion: string;
  readonly configurationVersion: string;
  readonly courseRef: string;
  readonly workflow: Workflow;
  readonly comparison: boolean;
  readonly outcome: "RESERVED" | UsageOutcome;
  readonly latencyMs: number | null;
  readonly localResources: LocalResourceMetadata | null;
  readonly day: string;
  readonly week: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProviderUsageSummary {
  readonly contractVersion: "provider-usage-summary.v1";
  readonly asOf: string;
  readonly policyVersion: "provider-usage-policy.v1";
  readonly costRepresentation: "ESTIMATE_NOT_PROVIDER_BILLING";
  readonly providers: readonly {
    readonly provider: ProviderId;
    readonly state: UsageState;
    readonly dailyRequests: number;
    readonly weeklyTokens: number;
    readonly estimatedCostNanoUsd: number | null;
    readonly completed: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly timedOut: number;
    readonly missingUsage: number;
    readonly averageLatencyMs: number | null;
    readonly localMemoryPressure: {
      readonly normal: number;
      readonly warning: number;
      readonly critical: number;
      readonly unavailable: number;
    } | null;
  }[];
  readonly comparison: {
    readonly dailyRequests: number;
    readonly weeklyEstimatedCostNanoUsd: number;
    readonly state: UsageState;
  };
}

export type UsageLimitCode =
  | "CONCURRENCY_LIMIT"
  | "SESSION_LIMIT"
  | "COURSE_LIMIT"
  | "DAILY_TOKEN_LIMIT"
  | "WEEKLY_TOKEN_LIMIT"
  | "DAILY_BUDGET_LIMIT"
  | "WEEKLY_BUDGET_LIMIT"
  | "COMPARISON_LIMIT";

export interface UsageReservationCommand {
  readonly request: UsageAdmissionRequest;
  readonly record: ProviderUsageRecord;
  readonly digest: `sha256:${string}`;
  readonly limits: {
    readonly globalConcurrency: number;
    readonly providerConcurrency: number;
    readonly sessionDailyRequests: number;
    readonly courseDailyRequests: number;
    readonly dailyTokens: number;
    readonly weeklyTokens: number;
    readonly dailyEstimatedCostNanoUsd: number | null;
    readonly weeklyEstimatedCostNanoUsd: number | null;
    readonly comparisonRunsPerSessionDaily: number | null;
    readonly comparisonCostPerRunNanoUsd: number | null;
    readonly comparisonDailyEstimatedCostNanoUsd: number | null;
    readonly comparisonWeeklyEstimatedCostNanoUsd: number | null;
  };
}

export interface UsageAggregate {
  readonly activeGlobal: number;
  readonly activeProvider: number;
  readonly dailyRequests: number;
  readonly weeklyTokens: number;
  readonly dailyTokens: number;
  readonly dailyEstimatedCostNanoUsd: number;
  readonly weeklyEstimatedCostNanoUsd: number;
  readonly comparisonDailyRequests: number;
  readonly comparisonRunEstimatedCostNanoUsd: number;
  readonly comparisonDailyEstimatedCostNanoUsd: number;
  readonly comparisonWeeklyEstimatedCostNanoUsd: number;
}

export type UsageRepositoryResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code:
        UsageLimitCode | "CONFLICT" | "NOT_FOUND" | "SERVICE_UNAVAILABLE";
    };

export interface ProviderUsageRepository {
  reserve(
    command: UsageReservationCommand,
  ): UsageRepositoryResult<ProviderUsageRecord>;
  finalize(
    attemptRef: string,
    expectedDigest: string,
    record: ProviderUsageRecord,
  ): UsageRepositoryResult<ProviderUsageRecord>;
  reconcile(
    attemptRef: string,
    expectedDigest: string,
    record: ProviderUsageRecord,
  ): UsageRepositoryResult<ProviderUsageRecord>;
  read(attemptRef: string): UsageRepositoryResult<ProviderUsageRecord>;
  aggregate(
    provider: ProviderId,
    day: string,
    week: string,
    comparisonRef?: string,
  ): UsageRepositoryResult<UsageAggregate>;
  summary(
    day: string,
    week: string,
    asOf: string,
    policyVersion: ProviderUsagePolicy["policyVersion"],
    states: {
      readonly local: UsageState;
      readonly openai: UsageState;
      readonly comparison: UsageState;
    },
  ): UsageRepositoryResult<ProviderUsageSummary>;
}

const keys = (value: object, expected: readonly string[]) =>
  Object.keys(value).every((key) => expected.includes(key));
const positiveInteger = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) > 0;
const nonnegativeInteger = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const reference = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(value);
const randomRef = (value: unknown, prefix: string) =>
  typeof value === "string" &&
  new RegExp(
    `^${prefix}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    "u",
  ).test(value);

function validProviderUsage(
  value: unknown,
  reported?: true,
): value is ProviderUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Partial<ProviderUsage>;
  return (
    keys(value, [
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "totalTokens",
      "providerReported",
    ]) &&
    typeof usage.providerReported === "boolean" &&
    (reported !== true || usage.providerReported === true) &&
    [
      usage.inputTokens,
      usage.cachedInputTokens,
      usage.outputTokens,
      usage.totalTokens,
    ].every((entry) => entry === undefined || nonnegativeInteger(entry)) &&
    (usage.cachedInputTokens === undefined ||
      (usage.inputTokens !== undefined &&
        usage.cachedInputTokens <= usage.inputTokens)) &&
    (usage.totalTokens === undefined ||
      usage.inputTokens === undefined ||
      usage.outputTokens === undefined ||
      usage.totalTokens === usage.inputTokens + usage.outputTokens)
  );
}

function validLocalResources(value: unknown): value is LocalResourceMetadata {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<LocalResourceMetadata>;
  const measured =
    item.processMemoryBytes !== undefined ||
    item.systemMemoryPressure !== undefined ||
    item.swapDeltaBytes !== undefined;
  return (
    keys(value, [
      "status",
      "processMemoryBytes",
      "systemMemoryPressure",
      "swapDeltaBytes",
    ]) &&
    ["MEASURED", "NOT_AVAILABLE", "INTERRUPTED"].includes(item.status ?? "") &&
    [item.processMemoryBytes, item.swapDeltaBytes].every(
      (entry) => entry === undefined || nonnegativeInteger(entry),
    ) &&
    (item.systemMemoryPressure === undefined ||
      ["NORMAL", "WARNING", "CRITICAL"].includes(item.systemMemoryPressure)) &&
    (item.status === "MEASURED" ? measured : !measured)
  );
}

export function isUsageAdmissionRequest(
  value: unknown,
): value is UsageAdmissionRequest {
  try {
    if (!value || typeof value !== "object") return false;
    const request = value as Partial<UsageAdmissionRequest>;
    const context = request.context;
    return (
      keys(value, [
        "contractVersion",
        "runRef",
        "interactionRef",
        "attemptRef",
        "sessionRef",
        "provider",
        "model",
        "inputTokens",
        "maxOutputTokens",
        "policyVersion",
        "configurationVersion",
        "context",
      ]) &&
      request.contractVersion === "provider-usage-admission.v1" &&
      randomRef(request.runRef, "run") &&
      randomRef(request.interactionRef, "interaction") &&
      randomRef(request.attemptRef, "attempt") &&
      randomRef(request.sessionRef, "session") &&
      (request.provider === "LOCAL" || request.provider === "OPENAI") &&
      ((request.provider === "LOCAL" &&
        ["gemma4:12b-mlx", "llama3.1:8b"].includes(request.model ?? "")) ||
        (request.provider === "OPENAI" && request.model === "gpt-5.6-luna")) &&
      positiveInteger(request.inputTokens) &&
      positiveInteger(request.maxOutputTokens) &&
      reference(request.policyVersion) &&
      reference(request.configurationVersion) &&
      Boolean(context) &&
      keys(context!, [
        "courseRef",
        "workflow",
        "comparison",
        "comparisonRef",
      ]) &&
      reference(context?.courseRef) &&
      ["COURSE_QA", "CODING_COACH"].includes(context?.workflow ?? "") &&
      typeof context?.comparison === "boolean" &&
      (context.comparison
        ? randomRef(context.comparisonRef, "comparison")
        : context.comparisonRef === undefined)
    );
  } catch {
    return false;
  }
}

export function isUsageTerminalUpdate(
  value: unknown,
): value is UsageTerminalUpdate {
  try {
    if (!value || typeof value !== "object") return false;
    const update = value as Partial<UsageTerminalUpdate>;
    return (
      keys(value, [
        "contractVersion",
        "attemptRef",
        "outcome",
        "providerContact",
        "usage",
        "latencyMs",
        "localResources",
      ]) &&
      update.contractVersion === "provider-usage-terminal.v1" &&
      randomRef(update.attemptRef, "attempt") &&
      ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"].includes(
        update.outcome ?? "",
      ) &&
      (update.providerContact === "NOT_STARTED" ||
        update.providerContact === "MAY_HAVE_OCCURRED") &&
      (update.providerContact !== "NOT_STARTED" ||
        (update.outcome !== "COMPLETED" &&
          update.usage === undefined &&
          update.localResources === undefined)) &&
      (update.usage === undefined || validProviderUsage(update.usage)) &&
      (update.latencyMs === undefined ||
        nonnegativeInteger(update.latencyMs)) &&
      (update.localResources === undefined ||
        validLocalResources(update.localResources))
    );
  } catch {
    return false;
  }
}

export function isUsageReconciliation(
  value: unknown,
): value is UsageReconciliation {
  try {
    if (!value || typeof value !== "object") return false;
    const update = value as Partial<UsageReconciliation>;
    return (
      keys(value, ["contractVersion", "attemptRef", "usage"]) &&
      update.contractVersion === "provider-usage-reconciliation.v1" &&
      randomRef(update.attemptRef, "attempt") &&
      validProviderUsage(update.usage, true)
    );
  } catch {
    return false;
  }
}

export function isProviderUsageSummary(
  value: unknown,
): value is ProviderUsageSummary {
  try {
    if (!value || typeof value !== "object") return false;
    const summary = value as Partial<ProviderUsageSummary>;
    if (
      !keys(value, [
        "contractVersion",
        "asOf",
        "policyVersion",
        "costRepresentation",
        "providers",
        "comparison",
      ]) ||
      summary.contractVersion !== "provider-usage-summary.v1" ||
      typeof summary.asOf !== "string" ||
      new Date(summary.asOf).toISOString() !== summary.asOf ||
      summary.policyVersion !== "provider-usage-policy.v1" ||
      summary.costRepresentation !== "ESTIMATE_NOT_PROVIDER_BILLING" ||
      !Array.isArray(summary.providers) ||
      summary.providers.length !== 2
    )
      return false;
    const seen = new Set<string>();
    for (const item of summary.providers) {
      if (
        !item ||
        typeof item !== "object" ||
        !keys(item, [
          "provider",
          "state",
          "dailyRequests",
          "weeklyTokens",
          "estimatedCostNanoUsd",
          "completed",
          "failed",
          "cancelled",
          "timedOut",
          "missingUsage",
          "averageLatencyMs",
          "localMemoryPressure",
        ]) ||
        !["LOCAL", "OPENAI"].includes(item.provider) ||
        seen.has(item.provider) ||
        !["AVAILABLE", "WARNING", "HARD_STOP"].includes(item.state) ||
        ![
          item.dailyRequests,
          item.weeklyTokens,
          item.completed,
          item.failed,
          item.cancelled,
          item.timedOut,
          item.missingUsage,
        ].every(nonnegativeInteger) ||
        (item.averageLatencyMs !== null &&
          !nonnegativeInteger(item.averageLatencyMs)) ||
        (item.provider === "LOCAL"
          ? item.estimatedCostNanoUsd !== null ||
            !item.localMemoryPressure ||
            typeof item.localMemoryPressure !== "object" ||
            !keys(item.localMemoryPressure, [
              "normal",
              "warning",
              "critical",
              "unavailable",
            ]) ||
            !Object.values(item.localMemoryPressure).every(nonnegativeInteger)
          : !nonnegativeInteger(item.estimatedCostNanoUsd) ||
            item.localMemoryPressure !== null)
      )
        return false;
      seen.add(item.provider);
    }
    const comparison = summary.comparison;
    return (
      seen.size === 2 &&
      Boolean(comparison) &&
      typeof comparison === "object" &&
      keys(comparison!, [
        "dailyRequests",
        "weeklyEstimatedCostNanoUsd",
        "state",
      ]) &&
      nonnegativeInteger(comparison?.dailyRequests) &&
      nonnegativeInteger(comparison?.weeklyEstimatedCostNanoUsd) &&
      ["AVAILABLE", "WARNING", "HARD_STOP"].includes(comparison?.state ?? "")
    );
  } catch {
    return false;
  }
}
