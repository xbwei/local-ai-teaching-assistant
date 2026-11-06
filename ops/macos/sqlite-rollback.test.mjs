import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  migrate,
  migrations,
} from "../../packages/persistence/dist/migrations.js";

const helper = path.resolve("ops/macos/sqlite-rollback.mjs");
const ledgerSql =
  "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL) STRICT";

function fixture(t) {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "sqlite-rollback-test-")),
  );
  chmodSync(root, 0o700);
  const runtime = path.join(root, "runtime");
  const backup = path.join(root, "backup");
  mkdirSync(runtime, { mode: 0o700 });
  mkdirSync(backup, { mode: 0o700 });
  const database = path.join(runtime, "foundation.sqlite");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, runtime, backup, database };
}

function createV1(file) {
  const database = new DatabaseSync(file);
  database.exec(`${ledgerSql}; PRAGMA user_version = 1`);
  database
    .prepare("INSERT INTO schema_migrations VALUES (1, ?)")
    .run(createHash("sha256").update(ledgerSql).digest("hex"));
  database.close();
  chmodSync(file, 0o600);
}

function schemaVersion(file) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database.prepare("PRAGMA user_version").get().user_version;
  } finally {
    database.close();
  }
}

function run(command, database, backup, environment = {}) {
  return spawnSync(process.execPath, [helper, command, database, backup], {
    encoding: "utf8",
    env: { ...process.env, LAITA_OPERATIONS_TESTING: "1", ...environment },
  });
}

function snapshotPaths(backup) {
  return {
    snapshot: path.join(backup, "sqlite-pre-migration.sqlite"),
    metadata: path.join(backup, "sqlite-pre-migration.json"),
    recovery: path.join(backup, "sqlite-failed-upgrade.sqlite"),
    recoveryMetadata: path.join(backup, "sqlite-failed-upgrade.json"),
  };
}

function migrateToCurrent(file) {
  const database = new DatabaseSync(file);
  try {
    migrate(database);
    database
      .prepare(
        "INSERT INTO policy_versions (version, policy_json, digest, activated_at) VALUES (1, '{}', 'synthetic-v3-state', '2026-09-05T00:00:00.000Z')",
      )
      .run();
  } finally {
    database.close();
  }
}

test("v1 snapshot restores after v5 migration while preserving failed-upgrade state", (t) => {
  const { database, backup } = fixture(t);
  createV1(database);
  assert.equal(run("snapshot", database, backup).status, 0);
  const artifacts = snapshotPaths(backup);
  assert.equal(schemaVersion(artifacts.snapshot), 1);
  migrateToCurrent(database);
  assert.equal(schemaVersion(database), 5);

  const restored = run("restore", database, backup);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(schemaVersion(database), 1);
  assert.equal(schemaVersion(artifacts.recovery), 5);
  const recovery = new DatabaseSync(artifacts.recovery, { readOnly: true });
  assert.equal(
    recovery.prepare("SELECT count(*) AS count FROM policy_versions").get()
      .count,
    1,
  );
  recovery.close();
  for (const file of Object.values(artifacts)) {
    assert.equal(existsSync(file), true);
    assert.equal(lstatSync(file).isFile(), true);
    assert.equal(lstatSync(file).nlink, 1);
    assert.equal(lstatSync(file).mode & 0o077, 0);
  }

  // This is the exact compatibility property required by the old v1 release.
  const oldRelease = new DatabaseSync(database, { readOnly: true });
  assert.equal(oldRelease.prepare("PRAGMA user_version").get().user_version, 1);
  assert.deepEqual(
    oldRelease
      .prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name),
    ["schema_migrations"],
  );
  oldRelease.close();
});

test("snapshot metadata, hash, schema and database corruption fail closed", (t) => {
  for (const mutation of ["hash", "schema", "database"]) {
    const { root, database, backup } = fixture(t);
    createV1(database);
    assert.equal(run("snapshot", database, backup).status, 0);
    const { snapshot, metadata } = snapshotPaths(backup);
    if (mutation === "database")
      writeFileSync(snapshot, "partial", { mode: 0o600 });
    else {
      const value = JSON.parse(readFileSync(metadata, "utf8"));
      if (mutation === "hash")
        value.databaseSha256 = `sha256:${"0".repeat(64)}`;
      else value.schemaVersion = 2;
      writeFileSync(metadata, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    }
    assert.notEqual(run("verify-snapshot", database, backup).status, 0);
    assert.equal(schemaVersion(database), 1);
    assert.equal(existsSync(root), true);
  }
});

test("altered known-version schema and ambiguous sidecars cannot be snapshotted", (t) => {
  for (const mutation of ["schema", "sidecar"]) {
    const { database, backup } = fixture(t);
    createV1(database);
    if (mutation === "schema") {
      const connection = new DatabaseSync(database);
      connection.exec(
        "ALTER TABLE schema_migrations ADD COLUMN unexpected TEXT",
      );
      connection.close();
    } else {
      writeFileSync(`${database}-journal`, "ambiguous", { mode: 0o600 });
    }
    assert.notEqual(run("snapshot", database, backup).status, 0);
    assert.equal(existsSync(snapshotPaths(backup).snapshot), false);
  }
});

test("symlink, hardlink and unsafe backup boundaries are rejected", (t) => {
  for (const kind of ["symlink", "hardlink", "permissions"]) {
    const { root, database, backup } = fixture(t);
    createV1(database);
    assert.equal(run("snapshot", database, backup).status, 0);
    const { snapshot } = snapshotPaths(backup);
    if (kind === "permissions") chmodSync(backup, 0o755);
    else {
      const moved = path.join(root, `moved-${kind}.sqlite`);
      renameSync(snapshot, moved);
      if (kind === "symlink") symlinkSync(moved, snapshot);
      else linkSync(moved, snapshot);
    }
    assert.notEqual(run("verify-snapshot", database, backup).status, 0);
    assert.equal(schemaVersion(database), 1);
  }
});

test("symlinked, hardlinked and non-quiescent live databases are rejected", (t) => {
  {
    const { root, database, backup } = fixture(t);
    createV1(database);
    const alias = path.join(root, "database-alias.sqlite");
    symlinkSync(database, alias);
    assert.notEqual(run("snapshot", alias, backup).status, 0);
    assert.equal(existsSync(snapshotPaths(backup).snapshot), false);
  }
  {
    const { root, database, backup } = fixture(t);
    createV1(database);
    linkSync(database, path.join(root, "database-hardlink.sqlite"));
    assert.notEqual(run("snapshot", database, backup).status, 0);
    assert.equal(existsSync(snapshotPaths(backup).snapshot), false);
  }
  {
    const { database, backup } = fixture(t);
    createV1(database);
    const connection = new DatabaseSync(database);
    connection.exec("BEGIN IMMEDIATE");
    try {
      assert.notEqual(run("snapshot", database, backup).status, 0);
      assert.equal(existsSync(snapshotPaths(backup).snapshot), false);
    } finally {
      connection.exec("ROLLBACK");
      connection.close();
    }
  }
});

test("partial snapshot and restore never replace the live database", (t) => {
  {
    const { database, backup } = fixture(t);
    createV1(database);
    assert.notEqual(
      run("snapshot", database, backup, {
        LAITA_TEST_FAIL_SNAPSHOT_BEFORE_RENAME: "1",
      }).status,
      0,
    );
    assert.equal(existsSync(snapshotPaths(backup).snapshot), false);
    assert.equal(schemaVersion(database), 1);
  }
  {
    const { database, backup } = fixture(t);
    createV1(database);
    assert.equal(run("snapshot", database, backup).status, 0);
    migrateToCurrent(database);
    assert.notEqual(
      run("restore", database, backup, {
        LAITA_TEST_FAIL_RECOVERY_BEFORE_RENAME: "1",
      }).status,
      0,
    );
    const artifacts = snapshotPaths(backup);
    assert.equal(schemaVersion(database), 5);
    assert.equal(schemaVersion(artifacts.snapshot), 1);
    assert.equal(existsSync(artifacts.recovery), false);
  }
  {
    const { database, backup } = fixture(t);
    createV1(database);
    assert.equal(run("snapshot", database, backup).status, 0);
    migrateToCurrent(database);
    assert.notEqual(
      run("restore", database, backup, {
        LAITA_TEST_FAIL_RESTORE_BEFORE_RENAME: "1",
      }).status,
      0,
    );
    const artifacts = snapshotPaths(backup);
    assert.equal(schemaVersion(database), 5);
    assert.equal(schemaVersion(artifacts.snapshot), 1);
    assert.equal(schemaVersion(artifacts.recovery), 5);
  }
});

test("same-schema rollback preserves both copies and successful promotion retains snapshot", (t) => {
  const { database, backup } = fixture(t);
  createV1(database);
  migrateToCurrent(database);
  assert.equal(run("snapshot", database, backup).status, 0);
  const artifacts = snapshotPaths(backup);
  assert.equal(schemaVersion(database), 5);
  assert.equal(schemaVersion(artifacts.snapshot), 5);
  assert.equal(existsSync(artifacts.recovery), false);

  assert.equal(run("restore", database, backup).status, 0);
  assert.equal(schemaVersion(database), 5);
  assert.equal(schemaVersion(artifacts.snapshot), 5);
  assert.equal(schemaVersion(artifacts.recovery), 5);
});

test("pre-v5 History backup restores after v5 while newer History remains in the recovery copy", (t) => {
  const { database, backup } = fixture(t);
  const db = new DatabaseSync(database);
  for (const migration of migrations.slice(0, 4)) {
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(
      migration.version,
      createHash("sha256").update(migration.sql).digest("hex"),
    );
    db.exec(`PRAGMA user_version=${migration.version}`);
  }
  db.exec(
    "INSERT INTO history_conversations(id,created) VALUES ('synthetic-legacy','2026-01-01'); INSERT INTO history_turns(id,conversation,created,input_type,text,outcome,recording) VALUES ('synthetic-old-turn','synthetic-legacy','2026-01-01','TYPED','Synthetic pre-v5 History','SUCCESS','RECORDED')",
  );
  db.close();
  chmodSync(database, 0o600);
  assert.equal(run("snapshot", database, backup).status, 0);
  migrateToCurrent(database);
  assert.equal(schemaVersion(database), 5);
  const newer = new DatabaseSync(database);
  newer.exec(
    "INSERT INTO history_turns(id,conversation,created,input_type,text,outcome,recording) VALUES ('synthetic-new-turn','synthetic-legacy','2026-01-02','TYPED','Synthetic post-backup History','SUCCESS','RECORDED')",
  );
  newer.close();
  assert.equal(run("restore", database, backup).status, 0);
  assert.equal(schemaVersion(database), 4);
  const restored = new DatabaseSync(database, { readOnly: true });
  assert.equal(
    restored.prepare("SELECT count(*) AS n FROM history_turns").get().n,
    1,
  );
  restored.close();
  const artifacts = snapshotPaths(backup);
  assert.equal(schemaVersion(artifacts.recovery), 5);
  const preserved = new DatabaseSync(artifacts.recovery, { readOnly: true });
  assert.equal(
    preserved.prepare("SELECT count(*) AS n FROM history_turns").get().n,
    2,
  );
  preserved.close();
});
