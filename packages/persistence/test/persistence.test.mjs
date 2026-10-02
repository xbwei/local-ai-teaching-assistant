import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  rmSync,
  realpathSync,
  readdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { initializeRuntimePaths } from "@laita/runtime";
import { initializePersistence } from "@laita/persistence";
import { canonicalJson } from "@laita/contracts";
import { migrate, migrations } from "../dist/migrations.js";

const unavailable = { ok: false, code: "SERVICE_UNAVAILABLE" };
function fixture(t) {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "teaching-sqlite-test-")),
  );
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  });
  const result = initializeRuntimePaths(root);
  assert.equal(result.ok, true);
  return {
    root,
    paths: result.value,
    file: path.join(root, "data", "foundation.sqlite"),
  };
}
const version = (db) => db.prepare("PRAGMA user_version").get().user_version;
const rows = (db) =>
  db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
const tables = (db) =>
  db
    .prepare("SELECT name FROM sqlite_schema ORDER BY name")
    .all()
    .map((row) => row.name);
const sha256 = (value) =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const usageUuid = (number) =>
  `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
function usageCommand(number, update = {}) {
  const request = {
    contractVersion: "provider-usage-admission.v1",
    runRef: `run-${usageUuid(number)}`,
    interactionRef: `interaction-${usageUuid(number)}`,
    attemptRef: `attempt-${usageUuid(number)}`,
    sessionRef: `session-${usageUuid(1)}`,
    provider: "OPENAI",
    model: "gpt-5.6-luna",
    inputTokens: 4,
    maxOutputTokens: 6,
    policyVersion: "instructor-policy.v1",
    configurationVersion: "openai-demo.v1",
    context: {
      courseRef: "course-synthetic-demo",
      workflow: "COURSE_QA",
      comparison: true,
      comparisonRef: `comparison-${usageUuid(number)}`,
    },
    ...update.request,
  };
  const record = {
    contractVersion: "provider-usage-record.v1",
    runRef: request.runRef,
    interactionRef: request.interactionRef,
    attemptRef: request.attemptRef,
    provider: request.provider,
    model: request.model,
    inputTokens: request.inputTokens,
    outputTokens: request.maxOutputTokens,
    totalTokens: request.inputTokens + request.maxOutputTokens,
    estimatedCostNanoUsd: 8000,
    costBasis: "openai-gpt-5.6-luna-estimate.v1",
    costRepresentation: "ESTIMATE_NOT_PROVIDER_BILLING",
    usageBasis: "RESERVED_ESTIMATE",
    policyVersion: request.policyVersion,
    configurationVersion: request.configurationVersion,
    courseRef: request.context.courseRef,
    workflow: request.context.workflow,
    comparison: request.context.comparison,
    outcome: "RESERVED",
    latencyMs: null,
    localResources: null,
    day: "2026-09-05",
    week: "2026-W36",
    createdAt: "2026-09-05T12:00:00.000Z",
    updatedAt: "2026-09-05T12:00:00.000Z",
    ...update.record,
  };
  const command = {
    request,
    record,
    digest: "",
    limits: {
      globalConcurrency: 1,
      providerConcurrency: 1,
      sessionDailyRequests: 20,
      courseDailyRequests: 200,
      dailyTokens: 20,
      weeklyTokens: 100,
      dailyEstimatedCostNanoUsd: 1_000_000,
      weeklyEstimatedCostNanoUsd: 5_000_000,
      comparisonRunsPerSessionDaily: 10,
      comparisonCostPerRunNanoUsd: 100_000,
      comparisonDailyEstimatedCostNanoUsd: 500_000,
      comparisonWeeklyEstimatedCostNanoUsd: 1_000_000,
      ...update.limits,
    },
  };
  command.digest = sha256(request);
  return command;
}

test("real disk SQLite initialization is minimal, durable, idempotent and closes safely", (t) => {
  const { root, paths, file } = fixture(t);
  let original;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = initializePersistence(paths);
    assert.equal(result.ok, true);
    assert.equal(result.value.isReady(), true);
    assert.equal(JSON.stringify(result.value), "{}");
    assert.equal(result.value.close().ok, true);
    assert.equal(result.value.close().ok, true);
    assert.equal(result.value.isReady(), false);
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(version(database), 4);
      assert.deepEqual(tables(database), [
        "history_answers",
        "history_conversation_order",
        "history_conversations",
        "history_events",
        "history_feedback",
        "history_outcome_order",
        "history_turns",
        "history_usage_interaction",
        "policy_active",
        "policy_history",
        "policy_versions",
        "provider_usage",
        "provider_usage_active",
        "provider_usage_comparison",
        "provider_usage_reconciliations",
        "provider_usage_scope_day",
        "provider_usage_week",
        "schema_migrations",
        "sqlite_autoindex_history_answers_1",
        "sqlite_autoindex_history_conversations_1",
        "sqlite_autoindex_history_events_1",
        "sqlite_autoindex_history_feedback_1",
        "sqlite_autoindex_history_turns_1",
        "sqlite_autoindex_provider_usage_1",
        "sqlite_autoindex_provider_usage_reconciliations_1",
        "sqlite_sequence",
      ]);
      assert.equal(rows(database).length, 4);
      assert.match(
        database
          .prepare(
            "EXPLAIN QUERY PLAN SELECT count(*) FROM provider_usage WHERE outcome = 'RESERVED' AND provider = ?",
          )
          .get("OPENAI").detail,
        /provider_usage_active/u,
      );
      assert.match(
        database
          .prepare(
            "EXPLAIN QUERY PLAN SELECT count(*) FROM provider_usage WHERE provider = 'OPENAI' AND comparison = 1 AND comparison_ref = ?",
          )
          .get(`comparison-${usageUuid(1)}`).detail,
        /provider_usage_comparison/u,
      );
      if (original) assert.deepEqual(rows(database), original);
      original = rows(database);
    } finally {
      database.close();
    }
  }
  assert.deepEqual(readdirSync(root).sort(), ["data", "tmp"]);
  assert.deepEqual(readdirSync(path.join(root, "data")), ["foundation.sqlite"]);
  assert.deepEqual(readdirSync(path.join(root, "tmp")), []);
});

test("synthetic migrations run in deterministic order and repeat without destructive reset", (t) => {
  const { paths, file } = fixture(t);
  const database = new DatabaseSync(paths.prepareDatabaseFile());
  const synthetic = [
    ...migrations,
    {
      version: 5,
      sql: "CREATE TABLE synthetic (id INTEGER PRIMARY KEY) STRICT",
    },
    { version: 6, sql: "INSERT INTO synthetic VALUES (7)" },
  ];
  try {
    migrate(database, synthetic);
    migrate(database, synthetic);
    assert.equal(version(database), 6);
    assert.deepEqual(
      rows(database).map((row) => row.version),
      [1, 2, 3, 4, 5, 6],
    );
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM synthetic").get().count,
      1,
    );
  } finally {
    database.close();
  }
  const again = new DatabaseSync(file);
  try {
    assert.equal(version(again), 6);
  } finally {
    again.close();
  }
  // Older application must not downgrade or silently reopen newer state as ready.
  assert.deepEqual(initializePersistence(paths), unavailable);
});

test("failed initial and later migration batches roll back DDL, rows and version atomically", (t) => {
  for (const initialized of [false, true]) {
    const { paths } = fixture(t);
    const database = new DatabaseSync(paths.prepareDatabaseFile());
    try {
      if (initialized) migrate(database);
      const before = tables(database);
      assert.throws(() =>
        migrate(database, [
          ...migrations,
          {
            version: 5,
            sql: "CREATE TABLE synthetic_partial (id INTEGER) STRICT",
          },
          { version: 6, sql: "INSERT INTO synthetic_missing VALUES (1)" },
        ]),
      );
      assert.equal(database.isTransaction, false);
      assert.equal(version(database), initialized ? 4 : 0);
      assert.deepEqual(tables(database), before);
      if (initialized) assert.equal(rows(database).length, 4);
      migrate(database);
      assert.equal(version(database), 4);
    } finally {
      database.close();
    }
  }
});

test("unknown, inconsistent and altered migration state fails closed without reset", (t) => {
  for (const sql of [
    "PRAGMA user_version = 99",
    "CREATE TABLE unexpected (id INTEGER)",
    "PRAGMA user_version = 0",
    "DELETE FROM schema_migrations",
    "UPDATE schema_migrations SET checksum = 'synthetic-changed'",
    "UPDATE schema_migrations SET version = 5 WHERE version = 2",
    "DROP TABLE schema_migrations",
    "ALTER TABLE schema_migrations ADD COLUMN unexpected TEXT",
  ]) {
    const { paths } = fixture(t);
    const database = new DatabaseSync(paths.prepareDatabaseFile());
    try {
      migrate(database);
      database.exec(sql);
      const before = version(database);
      assert.throws(() => migrate(database));
      assert.equal(version(database), before);
    } finally {
      database.close();
    }
    assert.deepEqual(initializePersistence(paths), unavailable);
  }
});

test("unknown unversioned schema and unordered or duplicate migration inputs are rejected", (t) => {
  const { paths } = fixture(t);
  const database = new DatabaseSync(paths.prepareDatabaseFile());
  try {
    for (const list of [
      [],
      [...migrations, { version: 6, sql: "SELECT 1" }],
      [...migrations, migrations[0]],
    ]) {
      assert.throws(() => migrate(database, list));
      assert.equal(version(database), 0);
      assert.deepEqual(tables(database), []);
    }
    database.exec("CREATE TABLE unknown_state (id INTEGER)");
    assert.throws(() => migrate(database));
    assert.deepEqual(tables(database), ["unknown_state"]);
    assert.equal(version(database), 0);
  } finally {
    database.close();
  }
});

test("database open, malformed bytes and locked migration fail with no raw details or fallback", (t) => {
  const { root, paths, file } = fixture(t);
  assert.deepEqual(
    initializePersistence({ prepareDatabaseFile: () => root }),
    unavailable,
  );
  assert.deepEqual(
    initializePersistence({
      prepareDatabaseFile: () => {
        throw new Error("synthetic-private-path SQLite detail");
      },
    }),
    unavailable,
  );
  writeFileSync(file, "synthetic-invalid-sqlite", { mode: 0o600 });
  assert.deepEqual(initializePersistence(paths), unavailable);
  rmSync(file);
  const database = new DatabaseSync(paths.prepareDatabaseFile());
  try {
    database.exec("BEGIN IMMEDIATE");
    assert.deepEqual(initializePersistence(paths), unavailable);
    database.exec("ROLLBACK");
    assert.deepEqual(tables(database), []);
  } finally {
    database.close();
  }
  const result = initializePersistence(paths);
  assert.equal(result.ok, true);
  result.value.close();
});

test("test database roots are independent and removed", (t) => {
  const first = fixture(t),
    second = fixture(t);
  const a = initializePersistence(first.paths),
    b = initializePersistence(second.paths);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  a.value.close();
  b.value.close();
  assert.notEqual(first.file, second.file);
  rmSync(first.root, { recursive: true });
  assert.equal(existsSync(first.root), false);
  const database = new DatabaseSync(second.file, { readOnly: true });
  try {
    assert.equal(version(database), 4);
  } finally {
    database.close();
  }
});

test("browser package conditions deny persistence", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=browser",
      "--input-type=module",
      "-e",
      'import "@laita/persistence";',
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
});

const initialPolicy = {
  contractVersion: "instructor-policy.v1",
  cloudEnabled: false,
  emergencyCloudDisabled: false,
  schedule: null,
  eligibility: {
    courseRefs: ["course-synthetic-demo"],
    accessClasses: ["INSTRUCTOR"],
    workflows: ["COURSE_QA", "CODING_COACH"],
    learningModes: ["DIRECT_EXPLANATION"],
    inputTypes: ["TEXT"],
    dataClasses: ["IDENTITY_FREE_USER_TEXT"],
  },
  models: {
    local: ["gemma4:12b-mlx", "llama3.1:8b"],
    activeLocal: "gemma4:12b-mlx",
    openai: ["gpt-5.6-luna"],
  },
  comparison: {
    enabled: true,
    courseRef: "course-synthetic-demo",
    moduleRef: "module-fixed-comparison",
    workflow: "COURSE_QA",
    learningMode: "DIRECT_EXPLANATION",
    inputType: "TEXT",
    dataClass: "IDENTITY_FREE_USER_TEXT",
    maxInputCharacters: 8192,
  },
};

test("policy state commits, conflicts and rollback are atomic and history is metadata-only", (t) => {
  const { paths, file } = fixture(t);
  const initialized = initializePersistence(paths);
  assert.equal(initialized.ok, true);
  const repository = initialized.value.policyState(initialPolicy);
  assert.equal(repository.read().value.version, 1);
  const enabled = { ...structuredClone(initialPolicy), cloudEnabled: true };
  const first = repository.activate(
    1,
    enabled,
    "INSTRUCTOR",
    "ACTIVATE",
    "2026-09-04T12:01:00.000Z",
  );
  assert.equal(first.ok, true);
  assert.equal(first.value.version, 2);
  assert.equal(first.value.policy.cloudEnabled, true);
  assert.deepEqual(
    repository.activate(
      1,
      { ...enabled, emergencyCloudDisabled: true },
      "ADMIN",
      "EMERGENCY_CLOUD_DISABLE",
      "2026-09-04T12:02:00.000Z",
    ),
    { ok: false, code: "CONFLICT" },
  );
  assert.equal(repository.read().value.version, 2);
  assert.equal(repository.read().value.policy.emergencyCloudDisabled, false);
  const rolledBack = repository.rollback(
    2,
    "ADMIN",
    "2026-09-04T12:03:00.000Z",
  );
  assert.equal(rolledBack.ok, true);
  assert.equal(rolledBack.value.version, 3);
  assert.deepEqual(rolledBack.value.policy, initialPolicy);
  const history = repository.history();
  assert.equal(history.ok, true);
  assert.deepEqual(
    history.value.map(({ version, previousVersion, actorRole, change }) => ({
      version,
      previousVersion,
      actorRole,
      change,
    })),
    [
      {
        version: 3,
        previousVersion: 2,
        actorRole: "ADMIN",
        change: "ROLLBACK",
      },
      {
        version: 2,
        previousVersion: 1,
        actorRole: "INSTRUCTOR",
        change: "ACTIVATE",
      },
    ],
  );
  const serialized = JSON.stringify(history.value);
  for (const prohibited of [
    "credential",
    "secret",
    "prompt",
    "student",
    "course-synthetic-demo",
  ])
    assert.equal(serialized.toLowerCase().includes(prohibited), false);
  initialized.value.close();
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM policy_versions").get()
        .count,
      3,
    );
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM policy_history").get()
        .count,
      2,
    );
  } finally {
    database.close();
  }
});

test("invalid or credential-bearing policy writes fail without partial persistence", (t) => {
  const { paths, file } = fixture(t);
  const initialized = initializePersistence(paths);
  assert.equal(initialized.ok, true);
  const repository = initialized.value.policyState(initialPolicy);
  const unsafe = {
    ...structuredClone(initialPolicy),
    credential: "synthetic-credential-marker",
  };
  assert.deepEqual(
    repository.activate(
      1,
      unsafe,
      "ADMIN",
      "ACTIVATE",
      "2026-09-04T12:01:00.000Z",
    ),
    { ok: false, code: "SERVICE_UNAVAILABLE" },
  );
  assert.equal(repository.read().value.version, 1);
  initialized.value.close();
  const bytes = readFileSync(file);
  assert.equal(
    bytes.includes(Buffer.from("synthetic-credential-marker")),
    false,
  );
});

test("independent repositories atomically admit one concurrent request and preserve exact limits", async (t) => {
  const { paths } = fixture(t);
  const first = initializePersistence(paths);
  const second = initializePersistence(paths);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const a = first.value.providerUsage();
  const b = second.value.providerUsage();
  const commands = [usageCommand(101), usageCommand(102)];
  const results = await Promise.all([
    Promise.resolve().then(() => a.reserve(commands[0])),
    Promise.resolve().then(() => b.reserve(commands[1])),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(
    results.filter((result) => !result.ok)[0].code,
    "CONCURRENCY_LIMIT",
  );
  const admitted = results[0].ok ? results[0] : results[1];
  const owner = results[0].ok ? a : b;
  const terminal = {
    ...admitted.value,
    outcome: "COMPLETED",
    usageBasis: "PROVIDER_REPORTED",
    inputTokens: 4,
    outputTokens: 6,
    totalTokens: 10,
    estimatedCostNanoUsd: 8000,
    updatedAt: "2026-09-05T12:01:00.000Z",
  };
  assert.equal(
    owner.finalize(admitted.value.attemptRef, sha256(admitted.value), terminal)
      .ok,
    true,
  );
  const exact = usageCommand(103);
  assert.equal(a.reserve(exact).ok, true);
  const exactTerminal = {
    ...exact.record,
    outcome: "COMPLETED",
    usageBasis: "PROVIDER_REPORTED",
    updatedAt: "2026-09-05T12:02:00.000Z",
  };
  assert.equal(
    a.finalize(exact.record.attemptRef, sha256(exact.record), exactTerminal).ok,
    true,
  );
  assert.equal(a.reserve(usageCommand(104)).code, "DAILY_TOKEN_LIMIT");
  first.value.close();
  second.value.close();
});

test("rollover, idempotency, reconciliation and privacy-safe summaries are durable", (t) => {
  const { paths, file } = fixture(t);
  const initialized = initializePersistence(paths);
  assert.equal(initialized.ok, true);
  const repository = initialized.value.providerUsage();
  const command = usageCommand(201);
  assert.equal(repository.reserve(command).ok, true);
  assert.equal(repository.reserve(structuredClone(command)).ok, true);
  const conflicting = structuredClone(command);
  conflicting.request.context.courseRef = "course-other-synthetic-demo";
  conflicting.record.courseRef = "course-other-synthetic-demo";
  conflicting.digest = sha256(conflicting.request);
  assert.equal(repository.reserve(conflicting).code, "CONFLICT");
  const completed = {
    ...command.record,
    outcome: "COMPLETED",
    usageBasis: "CONSERVATIVE_ESTIMATE",
    updatedAt: "2026-09-05T12:01:00.000Z",
  };
  assert.equal(
    repository.finalize(
      command.record.attemptRef,
      sha256(command.record),
      completed,
    ).ok,
    true,
  );
  const reconciled = {
    ...completed,
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
    estimatedCostNanoUsd: 4000,
    usageBasis: "PROVIDER_REPORTED",
    updatedAt: "2026-09-05T12:02:00.000Z",
  };
  assert.equal(
    repository.reconcile(
      command.record.attemptRef,
      sha256(completed),
      reconciled,
    ).ok,
    true,
  );
  assert.equal(
    repository.reconcile(command.record.attemptRef, sha256(completed), {
      ...reconciled,
      updatedAt: "2026-09-05T12:03:00.000Z",
    }).code,
    "CONFLICT",
  );
  assert.equal(repository.read(command.record.attemptRef).value.totalTokens, 5);
  const nextDay = usageCommand(202, {
    record: {
      day: "2026-09-06",
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    },
  });
  assert.equal(repository.reserve(nextDay).ok, true);
  const summary = repository.summary(
    "2026-09-05",
    "2026-W36",
    "2026-09-05T12:03:00.000Z",
    "provider-usage-policy.v1",
    { local: "AVAILABLE", openai: "WARNING", comparison: "WARNING" },
  );
  assert.equal(summary.ok, true);
  assert.equal(
    summary.value.costRepresentation,
    "ESTIMATE_NOT_PROVIDER_BILLING",
  );
  assert.equal(summary.value.providers[0].estimatedCostNanoUsd, null);
  const serialized = JSON.stringify(summary.value).toLowerCase();
  for (const prohibited of [
    "credential",
    "secret",
    "prompt",
    "response",
    "student",
    "192.0.2.10",
    "fingerprint",
    "billingaccount",
  ])
    assert.equal(serialized.includes(prohibited), false);
  initialized.value.close();
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare("SELECT count(*) AS count FROM provider_usage_reconciliations")
        .get().count,
      1,
    );
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM provider_usage").get()
        .count,
      2,
    );
  } finally {
    database.close();
  }
});

test("credential and client-supplied cost fields fail before usage persistence", (t) => {
  const { paths, file } = fixture(t);
  const initialized = initializePersistence(paths);
  assert.equal(initialized.ok, true);
  const repository = initialized.value.providerUsage();
  for (const [key, value] of [
    ["credential", "synthetic-secret-marker"],
    ["prompt", "synthetic-prompt-marker"],
    ["studentIdentity", "synthetic-student-marker"],
    ["ip", "192.0.2.10"],
    ["estimatedCostNanoUsd", 0],
  ]) {
    const command = usageCommand(301);
    command.request[key] = value;
    assert.equal(repository.reserve(command).code, "SERVICE_UNAVAILABLE");
  }
  initialized.value.close();
  const bytes = readFileSync(file).toString("utf8");
  for (const marker of [
    "synthetic-secret-marker",
    "synthetic-prompt-marker",
    "synthetic-student-marker",
    "192.0.2.10",
  ])
    assert.equal(bytes.includes(marker), false);
});

test("mismatched reservation identity and widened limits fail atomically", (t) => {
  const { paths } = fixture(t);
  const initialized = initializePersistence(paths);
  assert.equal(initialized.ok, true);
  const repository = initialized.value.providerUsage();
  for (const mutate of [
    (command) => {
      command.record.model = "client-selected-model";
    },
    (command) => {
      command.record.courseRef = "course-other-synthetic-demo";
    },
    (command) => {
      command.limits.globalConcurrency = 2;
    },
    (command) => {
      command.limits.dailyTokens = command.limits.weeklyTokens + 1;
    },
  ]) {
    const command = usageCommand(401);
    mutate(command);
    command.digest = sha256(command.request);
    assert.equal(repository.reserve(command).code, "SERVICE_UNAVAILABLE");
  }
  assert.equal(
    repository.read(usageCommand(401).record.attemptRef).code,
    "NOT_FOUND",
  );
  initialized.value.close();
});

test("summary treats malformed or incomplete Local resource state as unavailable", (t) => {
  const { paths, file } = fixture(t);
  const initialized = initializePersistence(paths);
  assert.equal(initialized.ok, true);
  const repository = initialized.value.providerUsage();
  const command = usageCommand(501, {
    request: { provider: "LOCAL", model: "gemma4:12b-mlx" },
    record: {
      provider: "LOCAL",
      model: "gemma4:12b-mlx",
      estimatedCostNanoUsd: null,
      costBasis: null,
      costRepresentation: null,
    },
    limits: {
      dailyEstimatedCostNanoUsd: null,
      weeklyEstimatedCostNanoUsd: null,
    },
  });
  assert.equal(repository.reserve(command).ok, true);
  const completed = {
    ...command.record,
    outcome: "COMPLETED",
    usageBasis: "PROVIDER_REPORTED",
    localResources: {
      status: "MEASURED",
      systemMemoryPressure: "NORMAL",
    },
    updatedAt: "2026-09-05T12:01:00.000Z",
  };
  assert.equal(
    repository.finalize(
      command.record.attemptRef,
      sha256(command.record),
      completed,
    ).ok,
    true,
  );
  const corruptor = new DatabaseSync(file);
  try {
    corruptor
      .prepare(
        "UPDATE provider_usage SET local_resources_json = ? WHERE attempt_ref = ?",
      )
      .run(
        JSON.stringify({ systemMemoryPressure: "NORMAL" }),
        command.record.attemptRef,
      );
  } finally {
    corruptor.close();
  }
  const summary = repository.summary(
    "2026-09-05",
    "2026-W36",
    "2026-09-05T12:02:00.000Z",
    "provider-usage-policy.v1",
    { local: "AVAILABLE", openai: "AVAILABLE", comparison: "AVAILABLE" },
  );
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.value.providers[0].localMemoryPressure, {
    normal: 0,
    warning: 0,
    critical: 0,
    unavailable: 1,
  });
  assert.equal(
    repository.read(command.record.attemptRef).code,
    "SERVICE_UNAVAILABLE",
  );
  initialized.value.close();
});
