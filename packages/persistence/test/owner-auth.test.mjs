import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrate, migrations } from "../dist/migrations.js";
import { createOwnerAuthRepository } from "../dist/owner-auth.js";

function initializeLegacySchema(db, through) {
  for (const { version, sql } of migrations.slice(0, through)) {
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(
      version,
      createHash("sha256").update(sql).digest("hex"),
    );
    db.exec(`PRAGMA user_version=${version}`);
  }
  return db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
}

test("v6 practice accounts keep their credentials, default courses and revoked grants", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const ledger = initializeLegacySchema(db, 6);
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

test("v7 practice accounts gain display names and account status without altering course grants or passphrases", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const ledger = initializeLegacySchema(db, 7);
  const username = "demo-student";
  const credential = {
    salt: "a".repeat(32),
    verifier: "b".repeat(64),
    revision: "c".repeat(32),
  };
  db.prepare("INSERT INTO demo_accounts VALUES (?, ?, ?, ?, ?)").run(
    username,
    "IA340",
    credential.salt,
    credential.verifier,
    credential.revision,
  );
  const insert = db.prepare(
    "INSERT INTO demo_course_memberships (username, course, revision, active) VALUES (?, ?, ?, ?)",
  );
  insert.run(username, "IA340", "d".repeat(32), 1);
  insert.run(username, "IA342", "e".repeat(32), 0);

  migrate(db);
  const repo = createOwnerAuthRepository(db);
  assert.deepEqual(
    db
      .prepare(
        "SELECT * FROM schema_migrations WHERE version <= 7 ORDER BY version",
      )
      .all(),
    ledger,
  );
  assert.deepEqual(repo.demoAccount(username).credential, credential);
  assert.deepEqual(repo.listDemoAccounts(), [
    { username, role: "student", label: "Demo Student", active: true },
  ]);
  const grants = repo.listDemoMemberships();
  const grantRevision = repo.demoMembership(username, "IA340").revision;
  assert.equal(
    repo.renameDemoAccount(username, "  Étudiante 42  ").label,
    "Étudiante 42",
  );
  assert.equal(repo.demoMembership(username, "IA340").label, "Étudiante 42");
  assert.equal(
    repo.demoAccount(username).credential.revision,
    credential.revision,
  );
  assert.equal(repo.setDemoAccountActive(username, false).active, false);
  assert.equal(repo.demoMembership(username, "IA340"), undefined);
  assert.equal(repo.renameDemoAccount(username, "Synthetic Other"), undefined);
  assert.equal(repo.revokeDemoSessions(username), undefined);
  const disabledRevision = repo.demoAccount(username).credential.revision;
  assert.notEqual(disabledRevision, credential.revision);
  assert.equal(repo.setDemoAccountActive(username, true).active, true);
  const enabled = repo.demoMembership(username, "IA340");
  assert.notEqual(enabled.credentialRevision, disabledRevision);
  assert.equal(enabled.revision, grantRevision);
  assert.deepEqual(repo.listDemoMemberships(), grants);
  assert.equal(repo.revokeDemoSessions(username).active, true);
  const revoked = repo.demoAccount(username).credential;
  assert.notEqual(revoked.revision, enabled.credentialRevision);
  assert.deepEqual(revoked, { ...credential, revision: revoked.revision });
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
