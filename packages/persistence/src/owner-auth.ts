import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface OwnerCredential {
  salt: string;
  verifier: string;
  revision: string;
}
export const demoUsernames = ["demo-teacher", "demo-student"] as const;
export type DemoUsername = (typeof demoUsernames)[number];

function credentialFrom(row: Record<string, unknown>): OwnerCredential {
  const { salt, verifier, revision } = row;
  if (
    typeof salt !== "string" ||
    !/^[a-f0-9]{32}$/u.test(salt) ||
    typeof verifier !== "string" ||
    !/^[a-f0-9]{64}$/u.test(verifier) ||
    typeof revision !== "string" ||
    !/^[a-f0-9]{32}$/u.test(revision)
  )
    throw new Error("Credential unavailable");
  return { salt, verifier, revision };
}

function membershipFrom(row: Record<string, unknown>): {
  username: DemoUsername;
  role: "teacher" | "student";
  course: string;
  active: boolean;
} {
  const { username, course, active } = row;
  if (
    (username !== "demo-teacher" && username !== "demo-student") ||
    typeof course !== "string" ||
    !/^[A-Z0-9]{1,32}$/u.test(course) ||
    (active !== 0 && active !== 1)
  )
    throw new Error("Membership unavailable");
  return {
    username,
    role: username === "demo-teacher" ? "teacher" : "student",
    course,
    active: active === 1,
  };
}

/** Owner recovery and two explicitly provisioned practice identities. */
export function createOwnerAuthRepository(db: DatabaseSync) {
  return Object.freeze({
    credential(): OwnerCredential | undefined {
      const row = db
        .prepare(
          "SELECT salt, verifier, revision FROM owner_credential WHERE singleton = 1",
        )
        .get();
      return row && credentialFrom(row);
    },
    setCredential(value: OwnerCredential) {
      credentialFrom({ ...value });
      db.prepare(
        "INSERT INTO owner_credential(singleton, salt, verifier, revision) VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET salt=excluded.salt, verifier=excluded.verifier, revision=excluded.revision",
      ).run(value.salt, value.verifier, value.revision);
    },
    demoMembership(username: DemoUsername) {
      const row = db
        .prepare(
          "SELECT username, course, active, salt, verifier, revision FROM demo_memberships WHERE username = ?",
        )
        .get(username);
      return row && { ...membershipFrom(row), credential: credentialFrom(row) };
    },
    listDemoMemberships() {
      return db
        .prepare(
          "SELECT username, course, active FROM demo_memberships ORDER BY username",
        )
        .all()
        .map(membershipFrom);
    },
    configureDemo(
      course: string,
      teacher: OwnerCredential,
      student: OwnerCredential,
    ) {
      if (!/^[A-Z0-9]{1,32}$/u.test(course))
        throw new Error("Membership unavailable");
      const save = db.prepare(
        "INSERT INTO demo_memberships (username, course, salt, verifier, revision, active) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(username) DO UPDATE SET course=excluded.course, salt=excluded.salt, verifier=excluded.verifier, revision=excluded.revision",
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const [username, value] of [
          ["demo-teacher", teacher],
          ["demo-student", student],
        ] as const) {
          const { salt, verifier, revision } = credentialFrom({ ...value });
          save.run(username, course, salt, verifier, revision);
        }
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
    setDemoMembershipActive(
      username: DemoUsername,
      course: string,
      active: boolean,
    ) {
      const row = db
        .prepare(
          "UPDATE demo_memberships SET revision = CASE WHEN active <> ? THEN ? ELSE revision END, active = ? WHERE username = ? AND course = ? RETURNING username, course, active",
        )
        .get(
          Number(active),
          randomBytes(16).toString("hex"),
          Number(active),
          username,
          course,
        );
      return row && membershipFrom(row);
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
