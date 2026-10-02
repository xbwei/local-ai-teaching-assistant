import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

// Internal, reviewed SQL only. Never configuration, uploads or model output.
interface Migration {
  version: number;
  sql: string;
}
const ledgerSql =
  "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL) STRICT";
export const migrations: readonly Migration[] = Object.freeze([
  Object.freeze({ version: 1, sql: ledgerSql }),
  Object.freeze({
    version: 2,
    sql: [
      "CREATE TABLE policy_versions (version INTEGER PRIMARY KEY, policy_json TEXT NOT NULL, digest TEXT NOT NULL, activated_at TEXT NOT NULL) STRICT",
      "CREATE TABLE policy_active (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL REFERENCES policy_versions(version)) STRICT",
      "CREATE TABLE policy_history (version INTEGER PRIMARY KEY REFERENCES policy_versions(version), previous_version INTEGER NOT NULL REFERENCES policy_versions(version), actor_role TEXT NOT NULL CHECK (actor_role IN ('ADMIN', 'INSTRUCTOR')), change_kind TEXT NOT NULL CHECK (change_kind IN ('ACTIVATE', 'ROLLBACK', 'EMERGENCY_CLOUD_DISABLE')), timestamp TEXT NOT NULL, policy_digest TEXT NOT NULL) STRICT",
    ].join(";"),
  }),
  Object.freeze({
    version: 3,
    sql: [
      "CREATE TABLE provider_usage (attempt_ref TEXT PRIMARY KEY, admission_digest TEXT NOT NULL, record_digest TEXT NOT NULL, run_ref TEXT NOT NULL, interaction_ref TEXT NOT NULL, session_ref TEXT NOT NULL, provider TEXT NOT NULL CHECK (provider IN ('LOCAL', 'OPENAI')), model TEXT NOT NULL, course_ref TEXT NOT NULL, workflow TEXT NOT NULL, comparison INTEGER NOT NULL CHECK (comparison IN (0, 1)), comparison_ref TEXT, policy_version TEXT NOT NULL, configuration_version TEXT NOT NULL, outcome TEXT NOT NULL CHECK (outcome IN ('RESERVED', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT')), usage_basis TEXT NOT NULL CHECK (usage_basis IN ('RESERVED_ESTIMATE', 'CONSERVATIVE_ESTIMATE', 'PROVIDER_REPORTED', 'NOT_INVOKED')), input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0), output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0), total_tokens INTEGER NOT NULL CHECK (total_tokens = input_tokens + output_tokens), estimated_cost_nano_usd INTEGER CHECK (estimated_cost_nano_usd IS NULL OR estimated_cost_nano_usd >= 0), cost_basis TEXT, cost_representation TEXT, latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0), local_resources_json TEXT, day_key TEXT NOT NULL, week_key TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK ((comparison = 1 AND comparison_ref IS NOT NULL) OR (comparison = 0 AND comparison_ref IS NULL)), CHECK ((provider = 'LOCAL' AND estimated_cost_nano_usd IS NULL AND cost_basis IS NULL AND cost_representation IS NULL) OR (provider = 'OPENAI' AND estimated_cost_nano_usd IS NOT NULL AND cost_basis IS NOT NULL AND cost_representation = 'ESTIMATE_NOT_PROVIDER_BILLING'))) STRICT",
      "CREATE INDEX provider_usage_scope_day ON provider_usage(provider, day_key, session_ref, course_ref)",
      "CREATE INDEX provider_usage_week ON provider_usage(provider, week_key)",
      "CREATE INDEX provider_usage_comparison ON provider_usage(comparison, comparison_ref, day_key, week_key)",
      "CREATE INDEX provider_usage_active ON provider_usage(provider) WHERE outcome = 'RESERVED'",
      "CREATE TABLE provider_usage_reconciliations (attempt_ref TEXT NOT NULL REFERENCES provider_usage(attempt_ref), revision INTEGER NOT NULL, previous_digest TEXT NOT NULL, reconciled_digest TEXT NOT NULL, timestamp TEXT NOT NULL, PRIMARY KEY (attempt_ref, revision)) STRICT",
    ].join(";"),
  }),
  Object.freeze({
    version: 4,
    sql: [
      "CREATE TABLE history_conversations (id TEXT PRIMARY KEY, created TEXT NOT NULL) STRICT",
      "CREATE TABLE history_turns (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conversation TEXT NOT NULL REFERENCES history_conversations(id), created TEXT NOT NULL, input_type TEXT NOT NULL, text TEXT, outcome TEXT NOT NULL, recording TEXT NOT NULL, correlation TEXT, interaction TEXT, course TEXT, lab TEXT, sources TEXT NOT NULL DEFAULT '[]', review TEXT NOT NULL DEFAULT 'PENDING', note TEXT NOT NULL DEFAULT '', suspected INTEGER NOT NULL DEFAULT 0, suspicion_reason TEXT NOT NULL DEFAULT '', suspicion_source TEXT) STRICT",
      "CREATE INDEX history_conversation_order ON history_turns(conversation, ordinal)",
      "CREATE INDEX history_usage_interaction ON provider_usage(interaction_ref)",
      "CREATE INDEX history_outcome_order ON history_turns(outcome, ordinal)",
      "CREATE TABLE history_answers (turn TEXT NOT NULL REFERENCES history_turns(id), leg TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(turn, leg)) STRICT",
      "CREATE TABLE history_events (turn TEXT NOT NULL REFERENCES history_turns(id), ordinal INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(turn, ordinal)) STRICT",
      "CREATE TABLE history_feedback (turn TEXT NOT NULL REFERENCES history_turns(id), leg TEXT NOT NULL, vote TEXT, report INTEGER NOT NULL, reason TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY(turn, leg)) STRICT",
    ].join(";"),
  }),
]);
const checksum = (sql: string) =>
  createHash("sha256").update(sql).digest("hex");

// Internal test seam permits synthetic DDL/rollback fixtures without product tables.
export function migrate(
  database: DatabaseSync,
  ordered: readonly Migration[] = migrations,
): void {
  if (
    ordered.length < migrations.length ||
    migrations.some(
      (migration, index) =>
        ordered[index]?.version !== migration.version ||
        ordered[index]?.sql !== migration.sql,
    ) ||
    ordered.some((migration, index) => migration.version !== index + 1)
  )
    throw new Error();
  database.exec("BEGIN IMMEDIATE");
  try {
    const version = database.prepare("PRAGMA user_version").get()!.user_version;
    if (
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 0 ||
      version > ordered.length
    )
      throw new Error();
    if (version === 0) {
      // Never claim an unknown/unversioned database, even if a ledger is absent.
      if (database.prepare("SELECT name FROM sqlite_schema LIMIT 1").get())
        throw new Error();
    } else {
      const schema = database
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE name = 'schema_migrations' AND type = 'table'",
        )
        .get();
      if (schema?.sql !== ledgerSql) throw new Error();
      // Known versions contain only reviewed migration objects.
      if (
        version <= migrations.length &&
        database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all()
          .map((row) => row.name)
          .join(",") !==
          (version === 1
            ? "schema_migrations"
            : version === 2
              ? "policy_active,policy_history,policy_versions,schema_migrations"
              : version === 3
                ? "policy_active,policy_history,policy_versions,provider_usage,provider_usage_active,provider_usage_comparison,provider_usage_reconciliations,provider_usage_scope_day,provider_usage_week,schema_migrations"
                : "history_answers,history_conversation_order,history_conversations,history_events,history_feedback,history_outcome_order,history_turns,history_usage_interaction,policy_active,policy_history,policy_versions,provider_usage,provider_usage_active,provider_usage_comparison,provider_usage_reconciliations,provider_usage_scope_day,provider_usage_week,schema_migrations")
      )
        throw new Error();
      const rows = database
        .prepare(
          "SELECT version, checksum FROM schema_migrations ORDER BY version LIMIT ?",
        )
        .all(ordered.length + 1);
      if (
        rows.length !== version ||
        rows.some(
          (row, index) =>
            row.version !== index + 1 ||
            row.checksum !== checksum(ordered[index]!.sql),
        )
      )
        throw new Error();
    }
    for (const migration of ordered.slice(version)) {
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)",
        )
        .run(migration.version, checksum(migration.sql));
      database.exec(`PRAGMA user_version = ${migration.version}`);
    }
    database.exec("COMMIT");
  } catch {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw new Error();
  }
}
