import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface OwnerCredential {
  salt: string;
  verifier: string;
  revision: string;
}
export const demoUsernames = ["demo-teacher", "demo-student"] as const;
export type DemoUsername = (typeof demoUsernames)[number];

const validRevision = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
const validCourse = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Z0-9]{1,32}$/u.test(value);

function credentialFrom(row: Record<string, unknown>): OwnerCredential {
  const { salt, verifier, revision } = row;
  if (
    typeof salt !== "string" ||
    !/^[a-f0-9]{32}$/u.test(salt) ||
    typeof verifier !== "string" ||
    !/^[a-f0-9]{64}$/u.test(verifier) ||
    !validRevision(revision)
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
    !validCourse(course) ||
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
  function grantDemoMembership(username: DemoUsername, course: string) {
    if (!validCourse(course)) throw new Error("Membership unavailable");
    db.prepare(
      "INSERT INTO demo_course_memberships (username,course,active,revision) SELECT username,?,1,? FROM demo_accounts WHERE username = ? ON CONFLICT DO NOTHING",
    ).run(course, randomBytes(16).toString("hex"), username);
    const row = db
      .prepare(
        "SELECT username,course,active FROM demo_course_memberships WHERE username = ? AND course = ?",
      )
      .get(username, course);
    return row && membershipFrom(row);
  }

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
    demoAccount(username: DemoUsername) {
      const row = db
        .prepare(
          "SELECT default_course, salt, verifier, revision FROM demo_accounts WHERE username = ?",
        )
        .get(username);
      if (!row) return;
      if (!validCourse(row.default_course))
        throw new Error("Membership unavailable");
      return {
        defaultCourse: row.default_course,
        credential: credentialFrom(row),
      };
    },
    demoMembership(username: DemoUsername, course: string) {
      const row = db
        .prepare(
          "SELECT m.username,m.course,m.active,m.revision,a.revision AS credential_revision FROM demo_course_memberships m JOIN demo_accounts a ON a.username=m.username WHERE m.username=? AND m.course=?",
        )
        .get(username, course);
      if (!row) return;
      if (
        !validRevision(row.revision) ||
        !validRevision(row.credential_revision)
      )
        throw new Error("Membership unavailable");
      return {
        ...membershipFrom(row),
        revision: row.revision,
        credentialRevision: row.credential_revision,
      };
    },
    activeDemoCourses(username: DemoUsername) {
      return db
        .prepare(
          "SELECT username,course,active FROM demo_course_memberships WHERE username = ? AND active = 1 ORDER BY course",
        )
        .all(username)
        .map((row) => membershipFrom(row).course);
    },
    listDemoMemberships() {
      return db
        .prepare(
          "SELECT username, course, active FROM demo_course_memberships ORDER BY username, course",
        )
        .all()
        .map(membershipFrom);
    },
    configureDemo(
      course: string,
      teacher: OwnerCredential,
      student: OwnerCredential,
    ) {
      if (!validCourse(course)) throw new Error("Membership unavailable");
      const save = db.prepare(
        "INSERT INTO demo_accounts (username, default_course, salt, verifier, revision) VALUES (?, ?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET default_course=excluded.default_course, salt=excluded.salt, verifier=excluded.verifier, revision=excluded.revision",
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const [username, value] of [
          ["demo-teacher", teacher],
          ["demo-student", student],
        ] as const) {
          const { salt, verifier, revision } = credentialFrom({ ...value });
          save.run(username, course, salt, verifier, revision);
          grantDemoMembership(username, course);
        }
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
    grantDemoMembership,
    setDemoMembershipActive(
      username: DemoUsername,
      course: string,
      active: boolean,
    ) {
      const row = db
        .prepare(
          "UPDATE demo_course_memberships SET revision = CASE WHEN active <> ? THEN ? ELSE revision END, active = ? WHERE username = ? AND course = ? RETURNING username, course, active",
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
