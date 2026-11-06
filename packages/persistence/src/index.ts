import {
  createHistoryRepository,
  type HistoryRepository,
  type HistoryScope,
} from "./history.ts";
import {
  createOwnerAuthRepository,
  type OwnerAuthRepository,
} from "./owner-auth.ts";
import { DatabaseSync } from "node:sqlite";
import type { FoundationResult, RuntimePaths } from "@laita/runtime";
import { migrate } from "./migrations.ts";
import {
  createPolicyStateRepository,
  type PolicyStateRepository,
} from "./policy-state.ts";
import type { InstructorPolicyDocument } from "@laita/contracts";
import type { ProviderUsageRepository } from "@laita/contracts";
import { createProviderUsageRepository } from "./provider-usage.ts";

export interface Persistence {
  isReady(): boolean;
  policyState(initialPolicy: InstructorPolicyDocument): PolicyStateRepository;
  providerUsage(): ProviderUsageRepository;
  history(scope?: HistoryScope): HistoryRepository;
  ownerAuth(): OwnerAuthRepository;
  close(): FoundationResult<undefined>;
}
export function initializePersistence(
  paths: RuntimePaths,
): FoundationResult<Persistence> {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(paths.prepareDatabaseFile(), {
      timeout: 1000,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
    });
    // One process, one tiny startup transaction. No WAL/background checkpoint work.
    database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL");
    migrate(database);
    let ready = true;
    const connection = database;
    return {
      ok: true,
      value: Object.freeze({
        isReady: () => ready,
        policyState(initialPolicy: InstructorPolicyDocument) {
          if (!ready) throw new Error();
          return createPolicyStateRepository(connection, initialPolicy);
        },
        ownerAuth() {
          if (!ready) throw new Error();
          return createOwnerAuthRepository(connection);
        },
        history(scope?: HistoryScope) {
          if (!ready) throw new Error();
          return createHistoryRepository(connection, scope);
        },
        providerUsage() {
          if (!ready) throw new Error();
          return createProviderUsageRepository(connection);
        },
        close(): FoundationResult<undefined> {
          ready = false;
          try {
            if (connection.isOpen) connection.close();
            return { ok: true, value: undefined };
          } catch {
            return { ok: false, code: "SERVICE_UNAVAILABLE" };
          }
        },
      }),
    };
  } catch {
    try {
      database?.close();
    } catch {
      /* Never expose raw close diagnostics. */
    }
    return { ok: false, code: "SERVICE_UNAVAILABLE" };
  }
}

export type {
  PolicyStateRepository,
  PolicyStateResult,
} from "./policy-state.ts";
export { createProviderUsageRepository } from "./provider-usage.ts";

export {
  HistoryValidationError,
  type HistoryRepository,
  type HistoryScope,
} from "./history.ts";

export type { OwnerAuthRepository, OwnerCredential } from "./owner-auth.ts";
