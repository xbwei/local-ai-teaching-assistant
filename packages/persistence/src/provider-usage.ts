import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  isUsageAdmissionRequest,
  type LocalResourceMetadata,
  type ProviderId,
  type ProviderUsagePolicy,
  type ProviderUsageRecord,
  type ProviderUsageRepository,
  type ProviderUsageSummary,
  type UsageAggregate,
  type UsageLimitCode,
  type UsageRepositoryResult,
  type UsageReservationCommand,
  type UsageState,
} from "@laita/contracts";

const sha256 = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const timestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};
const integer = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const onlyKeys = (value: object, expected: readonly string[]) =>
  Object.keys(value).every((key) => expected.includes(key));
const localResourceKeys = [
  "status",
  "processMemoryBytes",
  "systemMemoryPressure",
  "swapDeltaBytes",
] as const;
function safeLocalResources(value: unknown): value is LocalResourceMetadata {
  if (
    !value ||
    typeof value !== "object" ||
    !onlyKeys(value, localResourceKeys)
  )
    return false;
  const resource = value as Partial<LocalResourceMetadata>;
  const hasMeasurements =
    resource.processMemoryBytes !== undefined ||
    resource.systemMemoryPressure !== undefined ||
    resource.swapDeltaBytes !== undefined;
  return (
    ["MEASURED", "NOT_AVAILABLE", "INTERRUPTED"].includes(
      resource.status ?? "",
    ) &&
    (resource.processMemoryBytes === undefined ||
      integer(resource.processMemoryBytes)) &&
    (resource.systemMemoryPressure === undefined ||
      ["NORMAL", "WARNING", "CRITICAL"].includes(
        resource.systemMemoryPressure,
      )) &&
    (resource.swapDeltaBytes === undefined ||
      integer(resource.swapDeltaBytes)) &&
    (resource.status === "MEASURED" ? hasMeasurements : !hasMeasurements)
  );
}
const recordKeys = [
  "contractVersion",
  "runRef",
  "interactionRef",
  "attemptRef",
  "provider",
  "model",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "estimatedCostNanoUsd",
  "costBasis",
  "costRepresentation",
  "usageBasis",
  "policyVersion",
  "configurationVersion",
  "courseRef",
  "workflow",
  "comparison",
  "outcome",
  "latencyMs",
  "localResources",
  "day",
  "week",
  "createdAt",
  "updatedAt",
] as const;

function safeRecord(value: unknown): value is ProviderUsageRecord {
  try {
    if (!value || typeof value !== "object" || !onlyKeys(value, recordKeys))
      return false;
    const record = value as Partial<ProviderUsageRecord>;
    const localCost =
      record.provider === "LOCAL" &&
      record.estimatedCostNanoUsd === null &&
      record.costBasis === null &&
      record.costRepresentation === null;
    const cloudCost =
      record.provider === "OPENAI" &&
      integer(record.estimatedCostNanoUsd) &&
      record.costBasis === "openai-gpt-5.6-luna-estimate.v1" &&
      record.costRepresentation === "ESTIMATE_NOT_PROVIDER_BILLING";
    const usageStateConsistent =
      (record.outcome === "RESERVED" &&
        record.usageBasis === "RESERVED_ESTIMATE") ||
      (record.outcome !== "RESERVED" &&
        record.usageBasis !== "RESERVED_ESTIMATE");
    const notInvokedConsistent =
      record.usageBasis !== "NOT_INVOKED" ||
      (record.inputTokens === 0 &&
        record.outputTokens === 0 &&
        record.totalTokens === 0 &&
        (record.provider === "LOCAL" || record.estimatedCostNanoUsd === 0));
    return (
      record.contractVersion === "provider-usage-record.v1" &&
      typeof record.runRef === "string" &&
      /^run-/u.test(record.runRef) &&
      typeof record.interactionRef === "string" &&
      /^interaction-/u.test(record.interactionRef) &&
      typeof record.attemptRef === "string" &&
      /^attempt-/u.test(record.attemptRef) &&
      (localCost || cloudCost) &&
      usageStateConsistent &&
      notInvokedConsistent &&
      typeof record.model === "string" &&
      record.model.length > 0 &&
      integer(record.inputTokens) &&
      integer(record.outputTokens) &&
      integer(record.totalTokens) &&
      record.totalTokens ===
        Number(record.inputTokens) + Number(record.outputTokens) &&
      [
        "RESERVED_ESTIMATE",
        "CONSERVATIVE_ESTIMATE",
        "PROVIDER_REPORTED",
        "NOT_INVOKED",
      ].includes(record.usageBasis ?? "") &&
      typeof record.policyVersion === "string" &&
      typeof record.configurationVersion === "string" &&
      typeof record.courseRef === "string" &&
      ["COURSE_QA", "CODING_COACH"].includes(record.workflow ?? "") &&
      typeof record.comparison === "boolean" &&
      ["RESERVED", "COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"].includes(
        record.outcome ?? "",
      ) &&
      (record.latencyMs === null || integer(record.latencyMs)) &&
      (record.localResources === null ||
        (record.provider === "LOCAL" &&
          safeLocalResources(record.localResources))) &&
      typeof record.day === "string" &&
      /^\d{4}-\d{2}-\d{2}$/u.test(record.day) &&
      typeof record.week === "string" &&
      /^\d{4}-W\d{2}$/u.test(record.week) &&
      timestamp(record.createdAt) &&
      timestamp(record.updatedAt)
    );
  } catch {
    return false;
  }
}

function safeLimits(limits: UsageReservationCommand["limits"]): boolean {
  if (!limits || typeof limits !== "object") return false;
  const nullablePositive = (value: unknown) =>
    value === null || (Number.isSafeInteger(value) && Number(value) > 0);
  return (
    onlyKeys(limits, [
      "globalConcurrency",
      "providerConcurrency",
      "sessionDailyRequests",
      "courseDailyRequests",
      "dailyTokens",
      "weeklyTokens",
      "dailyEstimatedCostNanoUsd",
      "weeklyEstimatedCostNanoUsd",
      "comparisonRunsPerSessionDaily",
      "comparisonCostPerRunNanoUsd",
      "comparisonDailyEstimatedCostNanoUsd",
      "comparisonWeeklyEstimatedCostNanoUsd",
    ]) &&
    [
      limits.globalConcurrency,
      limits.providerConcurrency,
      limits.sessionDailyRequests,
      limits.courseDailyRequests,
      limits.dailyTokens,
      limits.weeklyTokens,
    ].every((value) => Number.isSafeInteger(value) && Number(value) > 0) &&
    limits.globalConcurrency === 1 &&
    limits.providerConcurrency === 1 &&
    limits.sessionDailyRequests <= limits.courseDailyRequests &&
    limits.dailyTokens <= limits.weeklyTokens &&
    [
      limits.dailyEstimatedCostNanoUsd,
      limits.weeklyEstimatedCostNanoUsd,
      limits.comparisonRunsPerSessionDaily,
      limits.comparisonCostPerRunNanoUsd,
      limits.comparisonDailyEstimatedCostNanoUsd,
      limits.comparisonWeeklyEstimatedCostNanoUsd,
    ].every(nullablePositive) &&
    (limits.dailyEstimatedCostNanoUsd === null ||
      limits.weeklyEstimatedCostNanoUsd === null ||
      limits.dailyEstimatedCostNanoUsd <= limits.weeklyEstimatedCostNanoUsd) &&
    (limits.comparisonCostPerRunNanoUsd === null ||
      limits.comparisonDailyEstimatedCostNanoUsd === null ||
      limits.comparisonCostPerRunNanoUsd <=
        limits.comparisonDailyEstimatedCostNanoUsd) &&
    (limits.comparisonDailyEstimatedCostNanoUsd === null ||
      limits.comparisonWeeklyEstimatedCostNanoUsd === null ||
      limits.comparisonDailyEstimatedCostNanoUsd <=
        limits.comparisonWeeklyEstimatedCostNanoUsd)
  );
}

function requestMatchesRecord(command: UsageReservationCommand): boolean {
  const { request, record, limits } = command;
  const comparisonLimits = [
    limits.comparisonRunsPerSessionDaily,
    limits.comparisonCostPerRunNanoUsd,
    limits.comparisonDailyEstimatedCostNanoUsd,
    limits.comparisonWeeklyEstimatedCostNanoUsd,
  ];
  return (
    request.runRef === record.runRef &&
    request.interactionRef === record.interactionRef &&
    request.attemptRef === record.attemptRef &&
    request.provider === record.provider &&
    request.model === record.model &&
    request.inputTokens === record.inputTokens &&
    request.maxOutputTokens === record.outputTokens &&
    request.policyVersion === record.policyVersion &&
    request.configurationVersion === record.configurationVersion &&
    request.context.courseRef === record.courseRef &&
    request.context.workflow === record.workflow &&
    request.context.comparison === record.comparison &&
    (request.provider === "OPENAI"
      ? limits.dailyEstimatedCostNanoUsd !== null &&
        limits.weeklyEstimatedCostNanoUsd !== null
      : limits.dailyEstimatedCostNanoUsd === null &&
        limits.weeklyEstimatedCostNanoUsd === null) &&
    (request.context.comparison
      ? comparisonLimits.every((value) => value !== null)
      : comparisonLimits.every((value) => value === null))
  );
}

function rowRecord(
  row: Record<string, unknown> | undefined,
): ProviderUsageRecord | null {
  try {
    if (
      !row ||
      (typeof row.local_resources_json !== "string" &&
        row.local_resources_json !== null)
    )
      return null;
    const localResources =
      row.local_resources_json === null
        ? null
        : (JSON.parse(row.local_resources_json) as LocalResourceMetadata);
    const record: ProviderUsageRecord = {
      contractVersion: "provider-usage-record.v1",
      runRef: row.run_ref as `run-${string}`,
      interactionRef: row.interaction_ref as `interaction-${string}`,
      attemptRef: row.attempt_ref as `attempt-${string}`,
      provider: row.provider as ProviderId,
      model: row.model as string,
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      totalTokens: row.total_tokens as number,
      estimatedCostNanoUsd: row.estimated_cost_nano_usd as number | null,
      costBasis: row.cost_basis as ProviderUsageRecord["costBasis"],
      costRepresentation:
        row.cost_representation as ProviderUsageRecord["costRepresentation"],
      usageBasis: row.usage_basis as ProviderUsageRecord["usageBasis"],
      policyVersion: row.policy_version as string,
      configurationVersion: row.configuration_version as string,
      courseRef: row.course_ref as string,
      workflow: row.workflow as ProviderUsageRecord["workflow"],
      comparison: row.comparison === 1,
      outcome: row.outcome as ProviderUsageRecord["outcome"],
      latencyMs: row.latency_ms as number | null,
      localResources,
      day: row.day_key as string,
      week: row.week_key as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
    return safeRecord(record) && row.record_digest === sha256(record)
      ? Object.freeze(record)
      : null;
  } catch {
    return null;
  }
}

const selectRecord =
  "SELECT attempt_ref, record_digest, run_ref, interaction_ref, provider, model, course_ref, workflow, comparison, policy_version, configuration_version, outcome, usage_basis, input_tokens, output_tokens, total_tokens, estimated_cost_nano_usd, cost_basis, cost_representation, latency_ms, local_resources_json, day_key, week_key, created_at, updated_at FROM provider_usage";

function count(
  database: DatabaseSync,
  sql: string,
  ...parameters: (string | number)[]
): number {
  const value = database.prepare(sql).get(...parameters)?.value;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error();
  return value;
}

function sameIdentity(
  left: ProviderUsageRecord,
  right: ProviderUsageRecord,
): boolean {
  return [
    "runRef",
    "interactionRef",
    "attemptRef",
    "provider",
    "model",
    "policyVersion",
    "configurationVersion",
    "courseRef",
    "workflow",
    "comparison",
    "day",
    "week",
    "createdAt",
  ].every(
    (key) =>
      left[key as keyof ProviderUsageRecord] ===
      right[key as keyof ProviderUsageRecord],
  );
}

export function createProviderUsageRepository(
  database: DatabaseSync,
): ProviderUsageRepository {
  function read(
    attemptRef: string,
  ): UsageRepositoryResult<ProviderUsageRecord> {
    try {
      if (typeof attemptRef !== "string")
        return { ok: false, code: "NOT_FOUND" };
      const row = database
        .prepare(`${selectRecord} WHERE attempt_ref = ?`)
        .get(attemptRef);
      if (!row) return { ok: false, code: "NOT_FOUND" };
      const value = rowRecord(row);
      return value
        ? { ok: true, value }
        : { ok: false, code: "SERVICE_UNAVAILABLE" };
    } catch {
      return { ok: false, code: "SERVICE_UNAVAILABLE" };
    }
  }

  function reserve(
    command: UsageReservationCommand,
  ): UsageRepositoryResult<ProviderUsageRecord> {
    if (
      !isUsageAdmissionRequest(command?.request) ||
      !safeRecord(command?.record) ||
      !safeLimits(command?.limits) ||
      !requestMatchesRecord(command) ||
      command.record.outcome !== "RESERVED" ||
      command.digest !== sha256(command.request)
    )
      return { ok: false, code: "SERVICE_UNAVAILABLE" };
    const { request, record, limits } = command;
    try {
      database.exec("BEGIN IMMEDIATE");
      const existing = database
        .prepare(
          "SELECT admission_digest FROM provider_usage WHERE attempt_ref = ?",
        )
        .get(request.attemptRef);
      if (existing) {
        database.exec("ROLLBACK");
        return existing.admission_digest === command.digest
          ? read(request.attemptRef)
          : { ok: false, code: "CONFLICT" };
      }
      const checks: readonly [boolean, UsageLimitCode][] = [
        [
          count(
            database,
            "SELECT count(*) AS value FROM provider_usage WHERE outcome = 'RESERVED'",
          ) >= limits.globalConcurrency,
          "CONCURRENCY_LIMIT",
        ],
        [
          count(
            database,
            "SELECT count(*) AS value FROM provider_usage WHERE outcome = 'RESERVED' AND provider = ?",
            request.provider,
          ) >= limits.providerConcurrency,
          "CONCURRENCY_LIMIT",
        ],
        [
          count(
            database,
            "SELECT count(*) AS value FROM provider_usage WHERE provider = ? AND session_ref = ? AND day_key = ?",
            request.provider,
            request.sessionRef,
            record.day,
          ) >= limits.sessionDailyRequests,
          "SESSION_LIMIT",
        ],
        [
          count(
            database,
            "SELECT count(*) AS value FROM provider_usage WHERE provider = ? AND course_ref = ? AND day_key = ?",
            request.provider,
            request.context.courseRef,
            record.day,
          ) >= limits.courseDailyRequests,
          "COURSE_LIMIT",
        ],
        [
          count(
            database,
            "SELECT coalesce(sum(total_tokens), 0) AS value FROM provider_usage WHERE provider = ? AND day_key = ?",
            request.provider,
            record.day,
          ) +
            record.totalTokens >
            limits.dailyTokens,
          "DAILY_TOKEN_LIMIT",
        ],
        [
          count(
            database,
            "SELECT coalesce(sum(total_tokens), 0) AS value FROM provider_usage WHERE provider = ? AND week_key = ?",
            request.provider,
            record.week,
          ) +
            record.totalTokens >
            limits.weeklyTokens,
          "WEEKLY_TOKEN_LIMIT",
        ],
      ];
      for (const [denied, code] of checks) {
        if (denied) {
          database.exec("ROLLBACK");
          return { ok: false, code };
        }
      }
      if (request.provider === "OPENAI") {
        const cost = record.estimatedCostNanoUsd ?? 0;
        const costChecks: [boolean, UsageLimitCode][] = [
          [
            count(
              database,
              "SELECT coalesce(sum(estimated_cost_nano_usd), 0) AS value FROM provider_usage WHERE provider = 'OPENAI' AND day_key = ?",
              record.day,
            ) +
              cost >
              (limits.dailyEstimatedCostNanoUsd ?? 0),
            "DAILY_BUDGET_LIMIT",
          ],
          [
            count(
              database,
              "SELECT coalesce(sum(estimated_cost_nano_usd), 0) AS value FROM provider_usage WHERE provider = 'OPENAI' AND week_key = ?",
              record.week,
            ) +
              cost >
              (limits.weeklyEstimatedCostNanoUsd ?? 0),
            "WEEKLY_BUDGET_LIMIT",
          ],
        ];
        if (request.context.comparison) {
          const comparisonRef = request.context.comparisonRef!;
          const alreadyCounted =
            count(
              database,
              "SELECT count(*) AS value FROM provider_usage WHERE provider = 'OPENAI' AND comparison = 1 AND comparison_ref = ?",
              comparisonRef,
            ) > 0;
          costChecks.push(
            [
              !alreadyCounted &&
                count(
                  database,
                  "SELECT count(DISTINCT comparison_ref) AS value FROM provider_usage WHERE provider = 'OPENAI' AND comparison = 1 AND session_ref = ? AND day_key = ?",
                  request.sessionRef,
                  record.day,
                ) >= (limits.comparisonRunsPerSessionDaily ?? 0),
              "COMPARISON_LIMIT",
            ],
            [
              count(
                database,
                "SELECT coalesce(sum(estimated_cost_nano_usd), 0) AS value FROM provider_usage WHERE provider = 'OPENAI' AND comparison = 1 AND comparison_ref = ?",
                comparisonRef,
              ) +
                cost >
                (limits.comparisonCostPerRunNanoUsd ?? 0),
              "COMPARISON_LIMIT",
            ],
            [
              count(
                database,
                "SELECT coalesce(sum(estimated_cost_nano_usd), 0) AS value FROM provider_usage WHERE provider = 'OPENAI' AND comparison = 1 AND day_key = ?",
                record.day,
              ) +
                cost >
                (limits.comparisonDailyEstimatedCostNanoUsd ?? 0),
              "COMPARISON_LIMIT",
            ],
            [
              count(
                database,
                "SELECT coalesce(sum(estimated_cost_nano_usd), 0) AS value FROM provider_usage WHERE provider = 'OPENAI' AND comparison = 1 AND week_key = ?",
                record.week,
              ) +
                cost >
                (limits.comparisonWeeklyEstimatedCostNanoUsd ?? 0),
              "COMPARISON_LIMIT",
            ],
          );
        }
        for (const [denied, code] of costChecks) {
          if (denied) {
            database.exec("ROLLBACK");
            return { ok: false, code };
          }
        }
      }
      database
        .prepare(
          "INSERT INTO provider_usage (attempt_ref, admission_digest, record_digest, run_ref, interaction_ref, session_ref, provider, model, course_ref, workflow, comparison, comparison_ref, policy_version, configuration_version, outcome, usage_basis, input_tokens, output_tokens, total_tokens, estimated_cost_nano_usd, cost_basis, cost_representation, latency_ms, local_resources_json, day_key, week_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          record.attemptRef,
          command.digest,
          sha256(record),
          record.runRef,
          record.interactionRef,
          request.sessionRef,
          record.provider,
          record.model,
          record.courseRef,
          record.workflow,
          record.comparison ? 1 : 0,
          request.context.comparisonRef ?? null,
          record.policyVersion,
          record.configurationVersion,
          record.outcome,
          record.usageBasis,
          record.inputTokens,
          record.outputTokens,
          record.totalTokens,
          record.estimatedCostNanoUsd,
          record.costBasis,
          record.costRepresentation,
          record.latencyMs,
          null,
          record.day,
          record.week,
          record.createdAt,
          record.updatedAt,
        );
      database.exec("COMMIT");
      return read(record.attemptRef);
    } catch {
      if (database.isTransaction) database.exec("ROLLBACK");
      return { ok: false, code: "SERVICE_UNAVAILABLE" };
    }
  }

  function updateRecord(
    attemptRef: string,
    expectedDigest: string | undefined,
    record: ProviderUsageRecord,
    reconciliation: boolean,
  ): UsageRepositoryResult<ProviderUsageRecord> {
    if (!safeRecord(record) || record.attemptRef !== attemptRef)
      return { ok: false, code: "SERVICE_UNAVAILABLE" };
    try {
      database.exec("BEGIN IMMEDIATE");
      const current = rowRecord(
        database
          .prepare(`${selectRecord} WHERE attempt_ref = ?`)
          .get(attemptRef),
      );
      if (!current) {
        database.exec("ROLLBACK");
        return { ok: false, code: "NOT_FOUND" };
      }
      if (
        !sameIdentity(current, record) ||
        (expectedDigest !== undefined && sha256(current) !== expectedDigest)
      ) {
        database.exec("ROLLBACK");
        return { ok: false, code: "CONFLICT" };
      }
      if (reconciliation) {
        if (
          current.outcome !== "COMPLETED" ||
          record.outcome !== "COMPLETED" ||
          record.usageBasis !== "PROVIDER_REPORTED"
        ) {
          database.exec("ROLLBACK");
          return { ok: false, code: "CONFLICT" };
        }
        const revision =
          count(
            database,
            "SELECT count(*) AS value FROM provider_usage_reconciliations WHERE attempt_ref = ?",
            attemptRef,
          ) + 1;
        database
          .prepare(
            "INSERT INTO provider_usage_reconciliations (attempt_ref, revision, previous_digest, reconciled_digest, timestamp) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            attemptRef,
            revision,
            sha256(current),
            sha256(record),
            record.updatedAt,
          );
      } else if (
        current.outcome !== "RESERVED" ||
        record.outcome === "RESERVED"
      ) {
        database.exec("ROLLBACK");
        return { ok: false, code: "CONFLICT" };
      }
      database
        .prepare(
          "UPDATE provider_usage SET record_digest = ?, outcome = ?, usage_basis = ?, input_tokens = ?, output_tokens = ?, total_tokens = ?, estimated_cost_nano_usd = ?, latency_ms = ?, local_resources_json = ?, updated_at = ? WHERE attempt_ref = ?",
        )
        .run(
          sha256(record),
          record.outcome,
          record.usageBasis,
          record.inputTokens,
          record.outputTokens,
          record.totalTokens,
          record.estimatedCostNanoUsd,
          record.latencyMs,
          record.localResources === null
            ? null
            : JSON.stringify(record.localResources),
          record.updatedAt,
          attemptRef,
        );
      database.exec("COMMIT");
      return read(attemptRef);
    } catch {
      if (database.isTransaction) database.exec("ROLLBACK");
      return { ok: false, code: "SERVICE_UNAVAILABLE" };
    }
  }

  function aggregate(
    provider: ProviderId,
    day: string,
    week: string,
    comparisonRef?: string,
  ): UsageRepositoryResult<UsageAggregate> {
    try {
      const result: UsageAggregate = {
        activeGlobal: count(
          database,
          "SELECT count(*) AS value FROM provider_usage WHERE outcome = 'RESERVED'",
        ),
        activeProvider: count(
          database,
          "SELECT count(*) AS value FROM provider_usage WHERE outcome = 'RESERVED' AND provider = ?",
          provider,
        ),
        dailyRequests: count(
          database,
          "SELECT count(*) AS value FROM provider_usage WHERE provider = ? AND day_key = ?",
          provider,
          day,
        ),
        dailyTokens: count(
          database,
          "SELECT coalesce(sum(total_tokens), 0) AS value FROM provider_usage WHERE provider = ? AND day_key = ?",
          provider,
          day,
        ),
        weeklyTokens: count(
          database,
          "SELECT coalesce(sum(total_tokens), 0) AS value FROM provider_usage WHERE provider = ? AND week_key = ?",
          provider,
          week,
        ),
        dailyEstimatedCostNanoUsd: count(
          database,
          "SELECT coalesce(sum(estimated_cost_nano_usd), 0) AS value FROM provider_usage WHERE provider = ? AND day_key = ?",
          provider,
          day,
        ),
        weeklyEstimatedCostNanoUsd: count(
          database,
          "SELECT coalesce(sum(estimated_cost_nano_usd), 0) AS value FROM provider_usage WHERE provider = ? AND week_key = ?",
          provider,
          week,
        ),
        comparisonDailyRequests: count(
          database,
          "SELECT count(DISTINCT comparison_ref) AS value FROM provider_usage WHERE provider = ? AND comparison = 1 AND day_key = ?",
          provider,
          day,
        ),
        comparisonRunEstimatedCostNanoUsd: comparisonRef
          ? count(
              database,
              "SELECT coalesce(sum(estimated_cost_nano_usd), 0) AS value FROM provider_usage WHERE provider = ? AND comparison = 1 AND comparison_ref = ?",
              provider,
              comparisonRef,
            )
          : 0,
        comparisonDailyEstimatedCostNanoUsd: count(
          database,
          "SELECT coalesce(sum(estimated_cost_nano_usd), 0) AS value FROM provider_usage WHERE provider = ? AND comparison = 1 AND day_key = ?",
          provider,
          day,
        ),
        comparisonWeeklyEstimatedCostNanoUsd: count(
          database,
          "SELECT coalesce(sum(estimated_cost_nano_usd), 0) AS value FROM provider_usage WHERE provider = ? AND comparison = 1 AND week_key = ?",
          provider,
          week,
        ),
      };
      return { ok: true, value: Object.freeze(result) };
    } catch {
      return { ok: false, code: "SERVICE_UNAVAILABLE" };
    }
  }

  function summaryProvider(
    provider: ProviderId,
    day: string,
    week: string,
    state: UsageState,
  ): ProviderUsageSummary["providers"][number] {
    const outcomeCount = (outcome: ProviderUsageRecord["outcome"]) =>
      count(
        database,
        "SELECT count(*) AS value FROM provider_usage WHERE provider = ? AND week_key = ? AND outcome = ?",
        provider,
        week,
        outcome,
      );
    const average = database
      .prepare(
        "SELECT avg(latency_ms) AS value FROM provider_usage WHERE provider = ? AND week_key = ?",
      )
      .get(provider, week)?.value;
    if (
      average !== null &&
      average !== undefined &&
      typeof average !== "number"
    )
      throw new Error();
    const pressureCount = (pressure: "NORMAL" | "WARNING" | "CRITICAL") =>
      count(
        database,
        "SELECT count(*) AS value FROM provider_usage WHERE provider = 'LOCAL' AND week_key = ? AND CASE WHEN local_resources_json IS NULL THEN 0 WHEN json_valid(local_resources_json) = 0 THEN 0 WHEN json_extract(local_resources_json, '$.status') IS NOT 'MEASURED' THEN 0 ELSE json_extract(local_resources_json, '$.systemMemoryPressure') = ? END",
        week,
        pressure,
      );
    const unavailablePressure = () =>
      count(
        database,
        "SELECT count(*) AS value FROM provider_usage WHERE provider = 'LOCAL' AND week_key = ? AND CASE WHEN local_resources_json IS NULL THEN 1 WHEN json_valid(local_resources_json) = 0 THEN 1 WHEN json_extract(local_resources_json, '$.status') IS NOT 'MEASURED' THEN 1 WHEN json_extract(local_resources_json, '$.systemMemoryPressure') IS NULL THEN 1 ELSE 0 END",
        week,
      );
    return Object.freeze({
      provider,
      state,
      dailyRequests: count(
        database,
        "SELECT count(*) AS value FROM provider_usage WHERE provider = ? AND day_key = ?",
        provider,
        day,
      ),
      weeklyTokens: count(
        database,
        "SELECT coalesce(sum(total_tokens), 0) AS value FROM provider_usage WHERE provider = ? AND week_key = ?",
        provider,
        week,
      ),
      estimatedCostNanoUsd:
        provider === "OPENAI"
          ? count(
              database,
              "SELECT coalesce(sum(estimated_cost_nano_usd), 0) AS value FROM provider_usage WHERE provider = ? AND week_key = ?",
              provider,
              week,
            )
          : null,
      completed: outcomeCount("COMPLETED"),
      failed: outcomeCount("FAILED"),
      cancelled: outcomeCount("CANCELLED"),
      timedOut: outcomeCount("TIMEOUT"),
      missingUsage: count(
        database,
        "SELECT count(*) AS value FROM provider_usage WHERE provider = ? AND week_key = ? AND usage_basis = 'CONSERVATIVE_ESTIMATE'",
        provider,
        week,
      ),
      averageLatencyMs:
        typeof average === "number" ? Math.round(average) : null,
      localMemoryPressure:
        provider === "LOCAL"
          ? Object.freeze({
              normal: pressureCount("NORMAL"),
              warning: pressureCount("WARNING"),
              critical: pressureCount("CRITICAL"),
              unavailable: unavailablePressure(),
            })
          : null,
    });
  }

  return Object.freeze({
    reserve,
    read,
    finalize: (
      attemptRef: string,
      expectedDigest: string,
      record: ProviderUsageRecord,
    ) => updateRecord(attemptRef, expectedDigest, record, false),
    reconcile: (
      attemptRef: string,
      expectedDigest: string,
      record: ProviderUsageRecord,
    ) => updateRecord(attemptRef, expectedDigest, record, true),
    aggregate,
    summary(
      day: string,
      week: string,
      asOf: string,
      policyVersion: ProviderUsagePolicy["policyVersion"],
      states: { local: UsageState; openai: UsageState; comparison: UsageState },
    ): UsageRepositoryResult<ProviderUsageSummary> {
      try {
        const value: ProviderUsageSummary = Object.freeze({
          contractVersion: "provider-usage-summary.v1",
          asOf,
          policyVersion,
          costRepresentation: "ESTIMATE_NOT_PROVIDER_BILLING",
          providers: Object.freeze([
            summaryProvider("LOCAL", day, week, states.local),
            summaryProvider("OPENAI", day, week, states.openai),
          ]),
          comparison: Object.freeze({
            dailyRequests: count(
              database,
              "SELECT count(DISTINCT comparison_ref) AS value FROM provider_usage WHERE provider = 'OPENAI' AND comparison = 1 AND day_key = ?",
              day,
            ),
            weeklyEstimatedCostNanoUsd: count(
              database,
              "SELECT coalesce(sum(estimated_cost_nano_usd), 0) AS value FROM provider_usage WHERE provider = 'OPENAI' AND comparison = 1 AND week_key = ?",
              week,
            ),
            state: states.comparison,
          }),
        });
        return { ok: true, value };
      } catch {
        return { ok: false, code: "SERVICE_UNAVAILABLE" };
      }
    },
  });
}
