import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../dist/migrations.js";
import { createOwnerAuthRepository } from "../dist/owner-auth.js";

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
