import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  isInstructorPolicyDocument,
  type InstructorPolicyDocument,
  type InstructorPolicyHistoryEntry,
  type InstructorPolicyState,
} from "@laita/contracts";

export type PolicyStateResult =
  | { readonly ok: true; readonly value: InstructorPolicyState }
  | {
      readonly ok: false;
      readonly code: "CONFLICT" | "NOT_FOUND" | "SERVICE_UNAVAILABLE";
    };

export interface PolicyStateRepository {
  read(): PolicyStateResult;
  history():
    | {
        readonly ok: true;
        readonly value: readonly InstructorPolicyHistoryEntry[];
      }
    | { readonly ok: false; readonly code: "SERVICE_UNAVAILABLE" };
  activate(
    expectedVersion: number,
    policy: InstructorPolicyDocument,
    actorRole: "ADMIN" | "INSTRUCTOR",
    change: InstructorPolicyHistoryEntry["change"],
    timestamp: string,
  ): PolicyStateResult;
  rollback(
    expectedVersion: number,
    actorRole: "ADMIN" | "INSTRUCTOR",
    timestamp: string,
  ): PolicyStateResult;
}

function digest(policy: InstructorPolicyDocument): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(policy)).digest("hex")}`;
}

function validTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  )
    return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function createPolicyStateRepository(
  database: DatabaseSync,
  initialPolicy: InstructorPolicyDocument,
  now: () => Date = () => new Date(),
): PolicyStateRepository {
  if (!isInstructorPolicyDocument(initialPolicy)) throw new Error();
  const initialJson = JSON.stringify(initialPolicy);
  const initialDigest = digest(initialPolicy);
  try {
    database.exec("BEGIN IMMEDIATE");
    const active = database
      .prepare("SELECT version FROM policy_active WHERE singleton = 1")
      .get();
    if (!active) {
      if (database.prepare("SELECT version FROM policy_versions LIMIT 1").get())
        throw new Error();
      database
        .prepare(
          "INSERT INTO policy_versions (version, policy_json, digest, activated_at) VALUES (1, ?, ?, ?)",
        )
        .run(initialJson, initialDigest, now().toISOString());
      database
        .prepare("INSERT INTO policy_active (singleton, version) VALUES (1, 1)")
        .run();
    }
    database.exec("COMMIT");
  } catch {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw new Error();
  }

  function stateFromRow(
    row: Record<string, unknown> | undefined,
  ): InstructorPolicyState | null {
    try {
      if (
        !row ||
        typeof row.version !== "number" ||
        !Number.isSafeInteger(row.version) ||
        row.version < 1 ||
        typeof row.policy_json !== "string" ||
        typeof row.digest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(row.digest) ||
        !validTimestamp(row.activated_at)
      )
        return null;
      const policy: unknown = JSON.parse(row.policy_json);
      if (!isInstructorPolicyDocument(policy) || digest(policy) !== row.digest)
        return null;
      return Object.freeze({
        contractVersion: "instructor-policy-state.v1",
        version: row.version,
        digest: row.digest as `sha256:${string}`,
        activatedAt: row.activated_at,
        policy: structuredClone(policy),
      });
    } catch {
      return null;
    }
  }

  function read(): PolicyStateResult {
    try {
      const row = database
        .prepare(
          "SELECT v.version, v.policy_json, v.digest, v.activated_at FROM policy_active a JOIN policy_versions v ON v.version = a.version WHERE a.singleton = 1",
        )
        .get();
      const value = stateFromRow(row);
      return value
        ? { ok: true, value }
        : { ok: false, code: "SERVICE_UNAVAILABLE" };
    } catch {
      return { ok: false, code: "SERVICE_UNAVAILABLE" };
    }
  }

  function activate(
    expectedVersion: number,
    policy: InstructorPolicyDocument,
    actorRole: "ADMIN" | "INSTRUCTOR",
    change: InstructorPolicyHistoryEntry["change"],
    timestamp: string,
  ): PolicyStateResult {
    if (
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1 ||
      !isInstructorPolicyDocument(policy) ||
      !["ADMIN", "INSTRUCTOR"].includes(actorRole) ||
      !["ACTIVATE", "ROLLBACK", "EMERGENCY_CLOUD_DISABLE"].includes(change) ||
      !validTimestamp(timestamp)
    )
      return { ok: false, code: "SERVICE_UNAVAILABLE" };
    try {
      database.exec("BEGIN IMMEDIATE");
      const active = database
        .prepare("SELECT version FROM policy_active WHERE singleton = 1")
        .get();
      if (active?.version !== expectedVersion) {
        database.exec("ROLLBACK");
        return { ok: false, code: "CONFLICT" };
      }
      const version = expectedVersion + 1;
      const policyDigest = digest(policy);
      database
        .prepare(
          "INSERT INTO policy_versions (version, policy_json, digest, activated_at) VALUES (?, ?, ?, ?)",
        )
        .run(version, JSON.stringify(policy), policyDigest, timestamp);
      database
        .prepare(
          "INSERT INTO policy_history (version, previous_version, actor_role, change_kind, timestamp, policy_digest) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          version,
          expectedVersion,
          actorRole,
          change,
          timestamp,
          policyDigest,
        );
      const changed = database
        .prepare(
          "UPDATE policy_active SET version = ? WHERE singleton = 1 AND version = ?",
        )
        .run(version, expectedVersion);
      if (changed.changes !== 1) throw new Error();
      database.exec("COMMIT");
      return read();
    } catch {
      if (database.isTransaction) database.exec("ROLLBACK");
      return { ok: false, code: "SERVICE_UNAVAILABLE" };
    }
  }

  return Object.freeze({
    read,
    history():
      | {
          readonly ok: true;
          readonly value: readonly InstructorPolicyHistoryEntry[];
        }
      | { readonly ok: false; readonly code: "SERVICE_UNAVAILABLE" } {
      try {
        const rows = database
          .prepare(
            "SELECT version, previous_version, actor_role, change_kind, timestamp, policy_digest FROM policy_history ORDER BY version DESC LIMIT 100",
          )
          .all() as Record<string, unknown>[];
        const value: InstructorPolicyHistoryEntry[] = [];
        for (const row of rows) {
          if (
            typeof row.version !== "number" ||
            typeof row.previous_version !== "number" ||
            (row.actor_role !== "ADMIN" && row.actor_role !== "INSTRUCTOR") ||
            !["ACTIVATE", "ROLLBACK", "EMERGENCY_CLOUD_DISABLE"].includes(
              String(row.change_kind),
            ) ||
            !validTimestamp(row.timestamp) ||
            typeof row.policy_digest !== "string" ||
            !/^sha256:[a-f0-9]{64}$/u.test(row.policy_digest)
          )
            return { ok: false, code: "SERVICE_UNAVAILABLE" as const };
          value.push(
            Object.freeze({
              contractVersion: "instructor-policy-history.v1",
              version: row.version,
              previousVersion: row.previous_version,
              actorRole: row.actor_role,
              change: row.change_kind as InstructorPolicyHistoryEntry["change"],
              timestamp: row.timestamp,
              policyDigest: row.policy_digest as `sha256:${string}`,
            }),
          );
        }
        return { ok: true, value: Object.freeze(value) };
      } catch {
        return { ok: false, code: "SERVICE_UNAVAILABLE" as const };
      }
    },
    activate,
    rollback(
      expectedVersion: number,
      actorRole: "ADMIN" | "INSTRUCTOR",
      timestamp: string,
    ): PolicyStateResult {
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 2)
        return { ok: false, code: "NOT_FOUND" as const };
      try {
        const row = database
          .prepare("SELECT policy_json FROM policy_versions WHERE version = ?")
          .get(expectedVersion - 1);
        if (typeof row?.policy_json !== "string")
          return { ok: false, code: "NOT_FOUND" as const };
        const policy: unknown = JSON.parse(row.policy_json);
        if (!isInstructorPolicyDocument(policy))
          return { ok: false, code: "SERVICE_UNAVAILABLE" as const };
        return activate(
          expectedVersion,
          policy,
          actorRole,
          "ROLLBACK",
          timestamp,
        );
      } catch {
        return { ok: false, code: "SERVICE_UNAVAILABLE" as const };
      }
    },
  });
}
