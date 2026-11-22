import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrate, migrations } from "../dist/migrations.js";
import { createOwnerAuthRepository } from "../dist/owner-auth.js";

test("v6 practice accounts keep their credentials, default courses and revoked grants", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const { version, sql } of migrations.slice(0, 6)) {
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(
      version,
      createHash("sha256").update(sql).digest("hex"),
    );
    db.exec(`PRAGMA user_version=${version}`);
  }
  const ledger = db
    .prepare("SELECT * FROM schema_migrations ORDER BY version")
    .all();
  const legacy = {
    salt: "a".repeat(32),
    verifier: "b".repeat(64),
    revision: "c".repeat(32),
  };
  db.prepare("INSERT INTO demo_memberships VALUES (?, ?, ?, ?, ?, ?)").run(
    "demo-student",
    "IA340",
    legacy.salt,
    legacy.verifier,
    legacy.revision,
    0,
  );
  migrate(db);
  const repo = createOwnerAuthRepository(db);
  const student = "demo-student";
  assert.deepEqual(
    db
      .prepare(
        "SELECT * FROM schema_migrations WHERE version <= 6 ORDER BY version",
      )
      .all(),
    ledger,
  );
  assert.deepEqual(repo.demoAccount(student), {
    defaultCourse: "IA340",
    credential: legacy,
  });
  assert.deepEqual(repo.activeDemoCourses(student), []);
  assert.equal(repo.demoMembership(student, "IA340").revision, legacy.revision);
  assert.equal(repo.grantDemoMembership(student, "IA340").active, false);
  assert.equal(repo.grantDemoMembership("demo-teacher", "IA342"), undefined);
  assert.equal(repo.grantDemoMembership(student, "IA342").active, true);
  assert.deepEqual(repo.activeDemoCourses(student), ["IA342"]);

  const rotated = { ...legacy, revision: "d".repeat(32) };
  repo.configureDemo("IA342", legacy, rotated);
  assert.deepEqual(repo.demoAccount(student), {
    defaultCourse: "IA342",
    credential: rotated,
  });
  assert.equal(repo.demoMembership(student, "IA340").active, false);
  assert.equal(
    repo.demoMembership(student, "IA342").credentialRevision,
    rotated.revision,
  );
  const revision = repo.demoMembership(student, "IA342").revision;
  repo.setDemoMembershipActive(student, "IA342", false);
  repo.setDemoMembershipActive(student, "IA342", true);
  assert.notEqual(repo.demoMembership(student, "IA342").revision, revision);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("nonce storage failure rolls back the supported Node 24 transaction and permits subsequent legitimate use", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  migrate(db);
  const repo = createOwnerAuthRepository(db),
    digest = "a".repeat(64);
  db.exec(
    "CREATE TRIGGER synthetic_nonce_failure BEFORE INSERT ON canvas_nonces BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END",
  );
  assert.equal(repo.consumeNonce(digest, 1900000300, 1900000000), false);
  assert.equal(db.isTransaction, false);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM canvas_nonces").get().n,
    0,
  );
  db.exec("DROP TRIGGER synthetic_nonce_failure");
  assert.equal(repo.consumeNonce(digest, 1900000300, 1900000000), true);
  assert.equal(db.isTransaction, false);
  assert.equal(repo.consumeNonce(digest, 1900000300, 1900000000), false);
  assert.equal(db.isTransaction, false);
});
