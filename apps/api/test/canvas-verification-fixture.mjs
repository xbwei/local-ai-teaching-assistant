import assert from "node:assert/strict";
import { canvas, canvasNow, canvasPageFixture } from "./canvas-fixture.mjs";

const token = "synthetic_github_reader_for_fixture";
const oid = (ch) => ch.repeat(40);
export const verificationPath = "/api/v1/canvas/verification";
export const verificationSecretMarker = "synthetic-only-passphrase";

export function canvasVerificationFixture(
  base = canvasPageFixture(),
  count = 30,
) {
  const ids = Array.from({ length: count }, (_, n) => String(74001 + n));
  const githubStudents = ids.map((id, index) => ({
    id,
    githubId: String(Number(id) + 1000),
    githubLogin: `practice-${id}`,
    repository: `practice-${id}/sample-work`,
    repositoryId: String(Number(id) + 2000),
    pullRequest:
      index === ids.length - 1 ? { number: 2, head: "exercise" } : null,
  }));
  const mongoStudents = ids.map((id) => ({
    id,
    host: `sample-${id}.example.mongodb.net`,
    database: "practice",
  }));
  const configuration = {
    origin: canvas.canvasOrigin,
    courseId: canvas.courseId,
    teacherId: canvas.userId,
    github: { token, expiresAt: new Date(canvasNow + 3600_000).toISOString() },
    assignments: [
      {
        provider: "GITHUB",
        assignmentId: "181",
        readerGitHubId: "77",
        ref: "main",
        paths: ["README.md"],
        students: githubStudents,
      },
      {
        provider: "MONGODB",
        assignmentId: "182",
        collections: [
          {
            name: "items",
            fields: [{ path: "label", type: "string", nonempty: true }],
          },
        ],
        students: mongoStudents,
      },
    ],
  };
  const course = `/api/v1/courses/${canvas.courseId}`;
  const state = {
    source: (row) => row,
    membership: (id) => [{ id: Number(id) }],
    inactive: new Set(),
    github: async () => {},
    mongo: async () => {},
    activeWorkers: 0,
  };
  const calls = { canvas: [], github: [], mongo: [] };
  const gitHubForRepo = new Map(githubStudents.map((x) => [x.repository, x]));
  const gitHubForLogin = new Map(githubStudents.map((x) => [x.githubLogin, x]));
  const gitHubForStudent = new Map(githubStudents.map((x) => [x.id, x]));
  const mongoForStudent = new Map(mongoStudents.map((x) => [x.id, x]));

  const options = {
    ...base.options,
    async fetcher(url, init) {
      const target = new URL(url);
      assert.equal(target.origin, canvas.canvasOrigin);
      const { pathname: p, searchParams: q } = target;
      const sub =
        /^\/api\/v1\/courses\/42001\/assignments\/(181|182)\/submissions\/(\d+)$/u.exec(
          p,
        );
      if (p === course + "/users" && q.get("enrollment_type[]") === "student") {
        assert.equal(init.method, "GET");
        assert.equal(q.get("enrollment_state[]"), "active");
        assert.equal(q.get("per_page"), "2");
        assert.equal(q.getAll("user_ids[]").length, 1);
        const studentId = q.get("user_ids[]");
        assert.ok(ids.includes(studentId));
        calls.canvas.push(["active", studentId]);
        return Response.json(
          state.inactive.has(studentId) ? [] : state.membership(studentId),
          {
            headers: { Link: `<${url}>; rel="current"` },
          },
        );
      }
      if (
        p === course + "/assignments/181" ||
        p === course + "/assignments/182"
      ) {
        assert.equal(init.method, "GET");
        const id = Number(p.split("/").at(-1));
        return Response.json({
          id,
          course_id: Number(canvas.courseId),
          published: true,
          group_category_id: null,
          submission_types:
            id === 181
              ? ["online_url", "online_text_entry"]
              : ["online_text_entry"],
        });
      }
      if (sub) {
        assert.equal(init.method, "GET");
        assert.deepEqual(q.getAll("include[]"), ["visibility", "group"]);
        const [, a, studentId] = sub;
        assert.ok(ids.includes(studentId));
        calls.canvas.push([a, studentId]);
        const isGitHub = a === "181";
        const github = gitHubForStudent.get(studentId);
        const mongo = mongoForStudent.get(studentId);
        const profile = Number(studentId) % 2 === 1;
        const url = `https://github.com/${profile ? github.githubLogin : github.repository}`;
        const secret = verificationSecretMarker + studentId;
        return Response.json(
          state.source({
            id: Number(studentId) + 4000,
            user_id: Number(studentId),
            assignment_id: Number(a),
            assignment_visible: true,
            workflow_state: "submitted",
            attempt: 1,
            submitted_at: "2026-11-20T12:00:00Z",
            excused: false,
            missing: false,
            submission_type:
              isGitHub && profile ? "online_url" : "online_text_entry",
            url: isGitHub && profile ? url : null,
            body: isGitHub
              ? profile
                ? null
                : `<p><a href="${url}">${url}</a></p>`
              : `<p>mongodb+srv://sample:${secret}@${mongo.host}/${mongo.database}</p>`,
          }),
        );
      }
      return base.options.fetcher(url, init);
    },
    verification: {
      settings: () => configuration,
      async githubFetcher(url, init) {
        const u = new URL(url);
        assert.equal(u.origin, "https://api.github.com");
        assert.equal(init.method, "GET");
        assert.equal(init.redirect, "error");
        assert.equal(
          new Headers(init.headers).get("Authorization"),
          `Bearer ${token}`,
        );
        calls.github.push(u.pathname);
        const replacement = await state.github(u, init);
        if (replacement) return replacement;
        if (u.pathname === "/user") return Response.json({ id: 77 });
        if (u.pathname.startsWith("/users/")) {
          const student = gitHubForLogin.get(u.pathname.slice(7));
          assert.ok(student);
          return Response.json({
            id: Number(student.githubId),
            type: "User",
            login: student.githubLogin,
          });
        }
        const parts = u.pathname.split("/");
        const student = gitHubForRepo.get(parts.slice(2, 4).join("/"));
        assert.ok(student);
        const p = parts.slice(4).join("/");
        if (!p)
          return Response.json({
            id: Number(student.repositoryId),
            full_name: student.repository,
            private: true,
            archived: false,
            disabled: false,
            permissions: { pull: true },
          });
        if (p === "git/ref/heads/main")
          return Response.json({
            ref: "refs/heads/main",
            object: { sha: oid("a"), type: "commit" },
          });
        if (p === "git/commits/" + oid("a"))
          return Response.json({ sha: oid("a"), tree: { sha: oid("b") } });
        if (p === "git/trees/" + oid("b"))
          return Response.json({
            sha: oid("b"),
            truncated: false,
            tree: [
              {
                path: "README.md",
                type: "blob",
                mode: "100644",
                size: 42,
                sha: oid("c"),
              },
            ],
          });
        if (p === "commits") {
          assert.equal(u.searchParams.get("path"), "README.md");
          return Response.json([
            {
              sha: oid("a"),
              commit: {
                author: { date: "2026-11-20T11:00:00Z" },
                committer: { date: "2026-11-20T11:00:00Z" },
                message: "raw unprojected fixture text",
              },
            },
          ]);
        }
        if (p === "pulls/2") {
          assert.equal(student.pullRequest?.number, 2);
          const repo = {
            id: Number(student.repositoryId),
            full_name: student.repository,
          };
          return Response.json({
            number: 2,
            state: "open",
            merged: false,
            merged_at: null,
            created_at: "2026-11-20T11:00:00Z",
            user: { id: Number(student.githubId) },
            base: { ref: "main", sha: oid("a"), repo },
            head: { ref: "exercise", sha: oid("d"), repo },
          });
        }
        assert.fail("Unexpected synthetic GitHub endpoint");
      },
      mongoDependencies: {
        async worker(input, signal, check) {
          ++state.activeWorkers;
          const { expectation, credential } = input;
          const { studentId, host, database } = expectation;
          calls.mongo.push(studentId);
          try {
            await check("source");
            assert.equal(host, mongoForStudent.get(studentId).host);
            assert.equal(database, "practice");
            assert.deepEqual(JSON.parse(credential), {
              username: "sample",
              password: verificationSecretMarker + studentId,
            });
            const override = await state.mongo(studentId, signal);
            await check("command");
            return (
              override ?? {
                connection: { status: "PRESENT" },
                database: { status: "PRESENT" },
                cleanup: "COMPLETE",
                collections: [
                  {
                    status: "PRESENT",
                    collection: "items",
                    fields: [{ field: "label", status: "PRESENT" }],
                  },
                ],
              }
            );
          } finally {
            --state.activeWorkers;
          }
        },
      },
    },
  };
  return { options, configuration, state, ids, calls, canvas: base };
}
