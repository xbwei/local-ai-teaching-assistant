import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { isProviderRunResult } from "@laita/contracts";
import { canvasXml, validateCanvasConfiguration } from "../dist/canvas.js";
import { createCourseAwareExecution } from "../dist/course-execution.js";
import { initializeOwnerCredential } from "../dist/owner-credential.js";
import { fixture } from "./browser-fixture.mjs";
import {
  canvas,
  canvasNow,
  canvasPageFixture,
  signed,
} from "./canvas-fixture.mjs";
import { testPassphrase } from "./owner-fixture.mjs";

const teacherPassphrase = "synthetic fixture teacher passphrase";
const studentPassphrase = "synthetic fixture student passphrase";
const credentials = Promise.all([
  initializeOwnerCredential(teacherPassphrase),
  initializeOwnerCredential(studentPassphrase),
]);
const paired = { ...canvas, demo: { course: "IA340", studentUserId: "73002" } };
const membershipPath = "/api/v1/auth/demo-memberships";
const sessionCookie = (response) =>
  response.headers.get("set-cookie")?.split(";")[0];
const client = "a".repeat(64);

function post(f, path, body, cookie = "", headers = {}) {
  return f.request(path, {
    method: "POST",
    headers: {
      cookie,
      "x-owner-client": client,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const login = (f, username, passphrase, cookie) =>
  post(f, "/api/v1/auth/login", { username, passphrase }, cookie);
const status = (f, cookie) =>
  f.request("/api/v1/auth/session", { headers: { cookie } });
const query = async (f, cookie) => {
  const response = await post(f, "/api/v1/history/query", {}, cookie);
  assert.equal(response.status, 200);
  return (await response.json()).items;
};
async function saveQuestion(f, cookie, text) {
  const response = await f.request("/api/v1/input/sessions", {
    method: "POST",
    headers: { cookie, "x-owner-client": client },
  });
  assert.equal(response.status, 200);
  const { sessionRef } = await response.json();
  const turn = await post(
    f,
    "/api/v1/input/turns",
    { source: "TYPED", text },
    cookie,
    {
      "x-input-session": sessionRef,
    },
  );
  assert.equal(turn.status, 200);
  return { sessionRef, diagnosticRef: turn.headers.get("x-correlation-id") };
}

test("separate local credentials, roles, course scope, private History, and bounded Admin membership controls", async (t) => {
  let draftCalls = 0;
  const f = await fixture({
    autoLogin: false,
    history: true,
    teacherDraft: async () => {
      draftCalls++;
    },
  });
  t.after(() => f.close());
  assert.equal((await login(f, "demo-student", studentPassphrase)).status, 401);
  f.authStore.configureDemo("IA340", ...(await credentials));
  for (const [username, passphrase] of [
    ["admin", studentPassphrase],
    ["demo-teacher", studentPassphrase],
    ["demo-student", testPassphrase],
  ]) {
    const response = await login(f, username, passphrase);
    assert.equal(response.status, 401);
    assert.equal(sessionCookie(response), undefined);
  }
  assert.equal(
    (
      await post(f, "/api/v1/auth/login", {
        username: "demo-student",
        passphrase: studentPassphrase,
        role: "admin",
        course: "IA342",
      })
    ).status,
    400,
  );

  const admin = sessionCookie(await login(f, "admin", testPassphrase));
  const teacher = sessionCookie(
    await login(f, "demo-teacher", teacherPassphrase),
  );
  const student = sessionCookie(
    await login(f, "demo-student", studentPassphrase),
  );
  assert.equal(new Set([admin, teacher, student]).size, 3);
  for (const [cookie, identity] of [
    [admin, { role: "admin", source: "local" }],
    [teacher, { role: "teacher", source: "local", course: "IA340" }],
    [student, { role: "student", source: "local", course: "IA340" }],
  ])
    assert.deepEqual(await (await status(f, cookie)).json(), identity);

  const studentInput = await saveQuestion(
    f,
    student,
    "Synthetic private student question",
  );
  await saveQuestion(f, teacher, "Synthetic private teacher question");
  await saveQuestion(f, admin, "Synthetic legacy Owner question");
  for (const [cookie, text] of [
    [student, "Synthetic private student question"],
    [teacher, "Synthetic private teacher question"],
    [admin, "Synthetic legacy Owner question"],
  ])
    assert.deepEqual(
      (await query(f, cookie)).map((item) => item.text),
      [text],
    );

  const [privateRecord] = await query(f, student);
  for (const cookie of [admin, teacher]) {
    assert.equal(
      (
        await post(
          f,
          "/api/v1/history/conversation",
          { conversation: privateRecord.conversation },
          cookie,
        )
      ).status,
      400,
    );
    const otherSession = await post(
      f,
      "/api/v1/input/turns",
      { source: "TYPED", text: "Synthetic cross-session request" },
      cookie,
      {
        "x-input-session": studentInput.sessionRef,
      },
    );
    assert.equal(otherSession.status, 404);
  }
  assert.equal(
    (
      await post(
        f,
        "/api/v1/history/feedback",
        {
          conversation: privateRecord.conversation,
          turn: privateRecord.id,
          leg: "b".repeat(64),
          vote: "HELPFUL",
        },
        teacher,
      )
    ).status,
    400,
  );
  const diagnostic = await post(
    f,
    "/api/v1/history/diagnostic",
    { reference: studentInput.diagnosticRef },
    admin,
  );
  assert.equal(diagnostic.status, 200);
  assert.deepEqual(await diagnostic.json(), {
    diagnostic: {
      recording: "RECORDED",
      outcome: "PENDING",
      stages: [{ stage: "INPUT", origin: "SERVER" }],
    },
  });

  const setStudent = (cookie, active, course = "IA340") =>
    post(
      f,
      membershipPath,
      { username: "demo-student", course, active },
      cookie,
    );
  const list = await f.request(membershipPath, { headers: { cookie: admin } });
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), {
    memberships: [
      {
        username: "demo-student",
        role: "student",
        course: "IA340",
        active: true,
      },
      {
        username: "demo-teacher",
        role: "teacher",
        course: "IA340",
        active: true,
      },
    ],
  });
  for (const cookie of [teacher, student]) {
    assert.equal(
      (await f.request(membershipPath, { headers: { cookie } })).status,
      403,
    );
    assert.equal((await setStudent(cookie, false)).status, 403);
  }
  const generate = (cookie, course) =>
    post(
      f,
      "/api/v1/teacher-draft",
      { course, kind: "PAGE", topic: "Synthetic course topic" },
      cookie,
    );
  assert.equal((await generate(student, "IA340")).status, 403);
  assert.equal((await generate(teacher, "IA342")).status, 403);
  assert.equal(draftCalls, 0);
  assert.equal((await generate(teacher, "IA340")).status, 200);
  assert.equal(draftCalls, 1);

  assert.equal((await setStudent(admin, false, "IA342")).status, 404);
  assert.equal((await setStudent(admin, false)).status, 200);
  assert.equal((await status(f, student)).status, 401);
  assert.equal((await status(f, teacher)).status, 200);
  assert.equal((await login(f, "demo-student", studentPassphrase)).status, 401);
  assert.equal((await setStudent(admin, true)).status, 200);
  assert.equal((await status(f, student)).status, 401);
  const fresh = sessionCookie(
    await login(f, "demo-student", studentPassphrase),
  );
  assert.equal((await query(f, fresh))[0].id, privateRecord.id);
  assert.equal((await post(f, "/api/v1/auth/logout", {}, fresh)).status, 200);
  assert.equal((await status(f, fresh)).status, 401);
  f.authStore.configureDemo("IA342", ...(await credentials));
  assert.equal((await status(f, teacher)).status, 401);
  const otherCourseStudent = sessionCookie(
    await login(f, "demo-student", studentPassphrase),
  );
  assert.deepEqual(await query(f, otherCourseStudent), []);
  assert.doesNotMatch(
    JSON.stringify(f.logs),
    /synthetic fixture (student|teacher) passphrase/u,
  );
});

test("signed Canvas roles and current grants intersect without granting Learner any REST controls", async (t) => {
  let configuration = paired;
  const fake = canvasPageFixture();
  const f = await fixture({
    autoLogin: false,
    history: true,
    canvas: () => configuration,
    canvasPages: fake.options,
    authNow: () => canvasNow,
  });
  t.after(() => f.close());
  f.authStore.configureDemo("IA340", ...(await credentials));
  const url = `${f.config.publicOrigin}/api/v1/canvas/launch`;
  const launch = (changes = {}, options = {}) =>
    f.request("/api/v1/canvas/launch", {
      method: "POST",
      headers: {
        origin: options.origin ?? canvas.canvasOrigin,
        cookie: "",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: signed(
        url,
        { oauth_nonce: randomUUID(), ...changes },
        options.secret,
      ),
    });
  const learner = {
    roles: "urn:lti:role:ims/lis/Learner",
    custom_canvas_user_id: paired.demo.studentUserId,
  };
  assert.deepEqual(validateCanvasConfiguration(paired), paired);
  assert.throws(() =>
    validateCanvasConfiguration({
      ...paired,
      demo: { ...paired.demo, studentUserId: canvas.userId },
    }),
  );
  assert.match(
    canvasXml(f.config.publicOrigin, true),
    /name="visibility">members</u,
  );

  for (const [changes, options] of [
    [{ ...learner, custom_canvas_user_id: canvas.userId }],
    [{ ...learner, roles: "Instructor" }],
    [{ ...learner, roles: "Instructor,Learner" }],
    [{ ...learner, roles: "Administrator" }],
    [{ ...learner, custom_canvas_course_id: "42002" }],
    [{ ...learner, oauth_timestamp: String(canvasNow / 1000 - 301) }],
    [{ ...learner, oauth_timestamp: String(canvasNow / 1000 + 301) }],
    [learner, { origin: "https://other.example.test" }],
    [learner, { secret: "synthetic mismatched signing secret" }],
  ]) {
    const response = await launch(changes, options);
    assert.equal(response.status, 403);
    assert.equal(sessionCookie(response), undefined);
  }
  const instructorResponse = await launch();
  assert.equal(instructorResponse.status, 303);
  const instructor = sessionCookie(instructorResponse);
  assert.deepEqual(await (await status(f, instructor)).json(), {
    role: "teacher",
    source: "canvas",
    course: "IA340",
  });
  const learnerLaunch = { ...learner, oauth_nonce: randomUUID() };
  const learnerResponse = await launch(learnerLaunch);
  assert.equal(learnerResponse.status, 303);
  const student = sessionCookie(learnerResponse);
  assert.deepEqual(await (await status(f, student)).json(), {
    role: "student",
    source: "canvas",
    course: "IA340",
  });
  assert.equal((await launch(learnerLaunch)).status, 403);
  for (const tool of [
    "pages",
    "assignments",
    "modules",
    "feedback",
    "chat",
    "verification",
  ])
    assert.equal(
      (
        await f.request(`/api/v1/canvas/${tool}`, {
          headers: { cookie: student },
        })
      ).status,
      403,
    );
  assert.equal(fake.calls.length, 0);
  await saveQuestion(f, student, "Synthetic Canvas Student question");
  assert.deepEqual(await query(f, instructor), []);
  const localStudent = sessionCookie(
    await login(f, "demo-student", studentPassphrase),
  );
  assert.deepEqual(await query(f, localStudent), []);
  assert.equal((await query(f, student)).length, 1);

  f.authStore.setDemoMembershipActive("demo-student", "IA340", false);
  const revokedLaunch = { ...learner, oauth_nonce: randomUUID() };
  const revoked = await launch(revokedLaunch);
  assert.equal(revoked.status, 403);
  assert.equal(sessionCookie(revoked), undefined);
  f.authStore.setDemoMembershipActive("demo-student", "IA340", true);
  assert.equal((await status(f, student)).status, 401);
  assert.equal((await status(f, localStudent)).status, 401);
  assert.equal((await status(f, instructor)).status, 200);
  assert.equal((await launch(revokedLaunch)).status, 403);
  assert.equal((await launch(learner)).status, 303);
  configuration = { ...paired, demo: { ...paired.demo, course: "IA342" } };
  assert.equal((await status(f, instructor)).status, 401);
  assert.equal((await launch()).status, 403);
  assert.equal((await launch(learner)).status, 403);
});

test("Canvas Local drafting requires a current signed Teacher and the bound public course", async (t) => {
  let configuration = paired;
  let now = canvasNow;
  let run;
  const calls = [];
  const fake = canvasPageFixture({ assignments: true });
  const f = await fixture({
    autoLogin: false,
    canvas: () => configuration,
    canvasPages: fake.options,
    authNow: () => now,
    async teacherDraft(course, kind, topic, signal) {
      calls.push([course, kind, topic]);
      if (run) {
        const current = run;
        current.entered.resolve();
        await current.release.promise;
        signal.throwIfAborted();
      }
      return {
        mode: "LOCAL",
        grounding: {
          status: "GROUNDED",
          course: "IA340",
          sources: [
            { course: "IA340", path: "docs/example.md", section: "Lab 5" },
          ],
        },
        legs: [
          {
            provider: "LOCAL",
            provenance: { actualProvider: "LOCAL" },
            status: "COMPLETED",
            output: { text: "Synthetic editable suggestion" },
          },
        ],
      };
    },
  });
  t.after(() => f.close());
  f.authStore.configureDemo("IA340", ...(await credentials));
  const launch = async (claims = {}) => {
    const path = "/api/v1/canvas/launch";
    const response = await f.request(path, {
      method: "POST",
      headers: {
        origin: canvas.canvasOrigin,
        cookie: "",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: signed(f.config.publicOrigin + path, {
        oauth_nonce: randomUUID(),
        oauth_timestamp: String(Math.floor(now / 1000)),
        ...claims,
      }),
    });
    assert.equal(response.status, 303);
    return sessionCookie(response);
  };
  const draft = (cookie, course = "IA340", kind = "PAGE") =>
    post(f, "/api/v1/teacher-draft", { course, kind, topic: "Lab 5" }, cookie);
  const teacher = await launch();
  const learner = await launch({
    roles: "Learner",
    custom_canvas_user_id: paired.demo.studentUserId,
  });
  assert.equal((await draft("")).status, 401);
  assert.equal((await draft(learner)).status, 403);
  assert.equal((await draft(teacher, "IA342")).status, 403);
  assert.deepEqual(calls, []);
  for (const kind of ["PAGE", "ASSIGNMENT"]) {
    const response = await draft(teacher, "IA340", kind);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      text: "Synthetic editable suggestion",
      sources: [{ path: "docs/example.md", section: "Lab 5" }],
    });
  }
  assert.deepEqual(calls, [
    ["IA340", "PAGE", "Lab 5"],
    ["IA340", "ASSIGNMENT", "Lab 5"],
  ]);

  const active = (value) =>
    f.authStore.setDemoMembershipActive("demo-teacher", "IA340", value);
  for (const invalidate of [
    () => {
      configuration = { ...paired, demo: { ...paired.demo, course: "IA342" } };
    },
    () => active(false),
    () => {
      now += 8 * 3600000;
    },
  ]) {
    const current = await launch();
    const before = calls.length;
    run = {
      entered: Promise.withResolvers(),
      release: Promise.withResolvers(),
    };
    const request = draft(current);
    await run.entered.promise;
    invalidate();
    run.release.resolve();
    const changed = await request;
    assert.equal(changed.status, 401);
    assert.deepEqual(await changed.json(), { code: "UNAUTHENTICATED" });
    assert.equal((await draft(current)).status, 401);
    assert.equal(calls.length, before + 1);
    configuration = paired;
    active(true);
  }
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(fake.writes, []);
});

test("bound course refuses other-course grounding before any retrieval or provider call", async () => {
  let retrieves = 0,
    runs = 0;
  const execute = createCourseAwareExecution({
    grounder: {
      async ground() {
        retrieves++;
        return { status: "MISSING" };
      },
    },
    async executeProvider(request) {
      runs++;
      return { mode: request.mode, legs: [] };
    },
  });
  const run = (text) =>
    execute(
      { mode: "LOCAL", input: { text } },
      new AbortController().signal,
      `session-${randomUUID()}`,
      undefined,
      "TYPED",
      undefined,
      "IA340",
    );
  const refused = await run("IA342 course overview");
  assert.ok(isProviderRunResult(refused));
  assert.deepEqual(refused.grounding, {
    status: "EVIDENCE_NOT_FOUND",
    course: "IA340",
  });
  assert.equal(retrieves, 0);
  assert.equal(runs, 0);
  assert.equal(
    (await run("IA340 course overview")).grounding.status,
    "EVIDENCE_NOT_FOUND",
  );
  assert.equal(retrieves, 1);
  assert.equal(runs, 0);
  await run("How can I formulate a research question?");
  assert.equal(runs, 1);
});
