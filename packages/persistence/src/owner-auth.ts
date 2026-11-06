import type { DatabaseSync } from "node:sqlite";

export interface OwnerCredential {
  salt: string;
  verifier: string;
  revision: string;
}
/** One Owner, no participant/user or membership table. Never accepts plaintext. */
export function createOwnerAuthRepository(db: DatabaseSync) {
  return Object.freeze({
    credential(): OwnerCredential | undefined {
      const row = db
        .prepare(
          "SELECT salt, verifier, revision FROM owner_credential WHERE singleton = 1",
        )
        .get();
      if (!row) return;
      if (
        !/^[a-f0-9]{32}$/.test(String(row.salt)) ||
        !/^[a-f0-9]{64}$/.test(String(row.verifier)) ||
        !/^[a-f0-9]{32}$/.test(String(row.revision))
      )
        throw new Error("Credential unavailable");
      return {
        salt: String(row.salt),
        verifier: String(row.verifier),
        revision: String(row.revision),
      };
    },
    setCredential(value: OwnerCredential) {
      if (
        !/^[a-f0-9]{32}$/.test(value.salt) ||
        !/^[a-f0-9]{64}$/.test(value.verifier) ||
        !/^[a-f0-9]{32}$/.test(value.revision)
      )
        throw new Error("Invalid credential material");
      db.prepare(
        "INSERT INTO owner_credential(singleton, salt, verifier, revision) VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET salt=excluded.salt, verifier=excluded.verifier, revision=excluded.revision",
      ).run(value.salt, value.verifier, value.revision);
    },
    consumeNonce(digest: string, expires: number, now: number): boolean {
      if (
        !/^[a-f0-9]{64}$/.test(digest) ||
        !Number.isSafeInteger(expires) ||
        expires < now
      )
        return false;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM canvas_nonces WHERE expires < ?").run(now);
        const count = Number(
          db.prepare("SELECT count(*) AS n FROM canvas_nonces").get()!.n,
        );
        if (count >= 10000) throw new Error();
        const result = db
          .prepare(
            "INSERT INTO canvas_nonces(digest, expires) VALUES (?, ?) ON CONFLICT DO NOTHING",
          )
          .run(digest, expires);
        db.exec("COMMIT");
        return result.changes === 1;
      } catch {
        if (db.isTransaction) db.exec("ROLLBACK");
        return false;
      }
    },
  });
}
export type OwnerAuthRepository = ReturnType<typeof createOwnerAuthRepository>;
