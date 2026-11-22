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
    courses: ["IA340", "IA342"],
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
  const rotated = await Promise.all(
    [teacherPassphrase, studentPassphrase].map(initializeOwnerCredential),
  );
  f.authStore.configureDemo("IA342", ...rotated);
  assert.equal((await status(f, teacher)).status, 401);
  assert.deepEqual(f.authStore.activeDemoCourses("demo-student"), [
    "IA340",
    "IA342",
  ]);
  const otherCourseStudent = sessionCookie(
    await login(f, "demo-student", studentPassphrase),
  );
  assert.deepEqual(await query(f, otherCourseStudent), []);
  assert.doesNotMatch(
    JSON.stringify(f.logs),
    /synthetic fixture (student|teacher) passphrase/u,
  );
});

test("only Admin can grant another course and local course switching keeps History, roles and session lifetime scoped", async (t) => {
  let now = canvasNow;
  let afterMembershipRead;
  const draftCourses = [];
  const f = await fixture({
    autoLogin: false,
    history: true,
    canvas: () => paired,
    authNow: () => {
      const read = afterMembershipRead;
      afterMembershipRead = undefined;
      read?.();
      return now;
    },
    async teacherDraft(course) {
      draftCourses.push(course);
    },
  });
  t.after(() => f.close());
  f.authStore.configureDemo("IA340", ...(await credentials));
  const admin = sessionCookie(await login(f, "admin", testPassphrase));
  const teacher = sessionCookie(
    await login(f, "demo-teacher", teacherPassphrase),
  );
  const student = sessionCookie(
    await login(f, "demo-student", studentPassphrase),
  );
  assert.ok(admin && teacher && student);
  const coursePath = "/api/v1/auth/course";
  const list = (cookie) => f.request(coursePath, { headers: { cookie } });
  const change = (cookie, course) => post(f, coursePath, { course }, cookie);
  const malformed = (cookie) =>
    f.request(coursePath, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{",
    });
  const update = (cookie, body) => post(f, membershipPath, body, cookie);
  const newStudentGrant = {
    action: "grant",
    course: "IA342",
    username: "demo-student",
  };
  assert.equal((await list(admin)).status, 403);
  assert.equal((await list("")).status, 401);
  assert.equal((await malformed("")).status, 401);
  assert.equal((await malformed(admin)).status, 403);
  assert.equal((await malformed(student)).status, 400);
  assert.equal((await change(student, "IA342")).status, 403);
  assert.equal((await update(teacher, newStudentGrant)).status, 403);
  assert.equal((await update(student, newStudentGrant)).status, 403);
  assert.equal(
    (await update(admin, { ...newStudentGrant, role: "admin" })).status,
    400,
  );
  assert.equal((await update(admin, newStudentGrant)).status, 200);
  assert.equal(
    (
      await post(f, coursePath, { course: "IA342" }, student, {
        origin: "https://other.example.test",
      })
    ).status,
    403,
  );
  assert.deepEqual(await (await list(student)).json(), {
    courses: ["IA340", "IA342"],
  });
  assert.deepEqual(await (await list(teacher)).json(), { courses: ["IA340"] });
  await saveQuestion(f, student, "Synthetic first-course question");
  const [first] = await query(f, student);
  assert.ok(first);

  const path = "/api/v1/canvas/launch";
  const launch = await f.request(path, {
    method: "POST",
    headers: {
      origin: canvas.canvasOrigin,
      cookie: "",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: signed(f.config.publicOrigin + path, {
      roles: "Learner",
      custom_canvas_user_id: paired.demo.studentUserId,
    }),
  });
  assert.equal(launch.status, 303);
  const canvasStudent = sessionCookie(launch);
  assert.equal((await change(canvasStudent, "IA342")).status, 403);

  now += 3600000;
  const switched = await change(student, "IA342");
  assert.equal(switched.status, 200);
  assert.equal(
    switched.headers.get("set-cookie")?.match(/Max-Age=(\d+)$/u)?.[1],
    "25200",
  );
  const second = sessionCookie(switched);
  assert.ok(second && second !== student);
  assert.equal((await status(f, student)).status, 401);
  assert.deepEqual(await (await status(f, second)).json(), {
    role: "student",
    source: "local",
    course: "IA342",
  });
  assert.deepEqual(await query(f, second), []);
  await saveQuestion(f, second, "Synthetic second-course question");
  const [secondRecord] = await query(f, second);
  assert.ok(secondRecord && secondRecord.id !== first.id);
  const firstAgain = sessionCookie(await change(second, "IA340"));
  assert.ok(firstAgain);
  assert.equal((await status(f, second)).status, 401);
  assert.deepEqual(
    (await query(f, firstAgain)).map(({ id }) => id),
    [first.id],
  );

  const separate = sessionCookie(
    await login(f, "demo-student", studentPassphrase),
  );
  const activeSecond = sessionCookie(await change(separate, "IA342"));
  assert.ok(activeSecond);
  const revoke = { username: "demo-student", course: "IA342", active: false };
  assert.equal((await update(admin, revoke)).status, 200);
  assert.equal((await status(f, activeSecond)).status, 401);
  assert.equal((await change(firstAgain, "IA342")).status, 403);
  assert.equal((await status(f, canvasStudent)).status, 200);
  assert.equal((await status(f, teacher)).status, 200);
  assert.equal((await update(admin, { ...revoke, active: true })).status, 200);
  assert.equal((await status(f, activeSecond)).status, 401);
  const restored = sessionCookie(await change(firstAgain, "IA342"));
  assert.deepEqual(
    (await query(f, restored)).map(({ id }) => id),
    [secondRecord.id],
  );
  assert.equal(
    (await update(admin, { ...newStudentGrant, username: "demo-teacher" }))
      .status,
    200,
  );
  const teacherOtherCourse = sessionCookie(await change(teacher, "IA342"));
  assert.ok(teacherOtherCourse);
  const generate = (course) =>
    post(
      f,
      "/api/v1/teacher-draft",
      { course, kind: "PAGE", topic: "Synthetic topic" },
      teacherOtherCourse,
    );
  assert.equal((await generate("IA340")).status, 403);
  assert.equal((await generate("IA342")).status, 200);
  assert.deepEqual(draftCourses, ["IA342"]);
  afterMembershipRead = () =>
    f.authStore.setDemoMembershipActive("demo-student", "IA342", false);
  const stale = await change(restored, "IA340");
  assert.equal(stale.status, 401);
  assert.equal(stale.headers.get("set-cookie"), null);
  now = canvasNow + 8 * 3600000;
  assert.equal((await status(f, teacherOtherCourse)).status, 401);
});

test("Admin can rename, suspend and revoke existing practice accounts across local courses and signed Canvas sessions", async (t) => {
  const f = await fixture({
    autoLogin: false,
    history: true,
    canvas: () => paired,
    authNow: () => canvasNow,
  });
  t.after(() => f.close());
  f.authStore.configureDemo("IA340", ...(await credentials));
  const username = "demo-student";
  f.authStore.grantDemoMembership(username, "IA342");
  const grants = f.authStore.listDemoMemberships();
  const admin = sessionCookie(await login(f, "admin", testPassphrase));
  const teacher = sessionCookie(
    await login(f, "demo-teacher", teacherPassphrase),
  );
  const student = sessionCookie(await login(f, username, studentPassphrase));
  const otherCourseResponse = await post(
    f,
    "/api/v1/auth/course",
    { course: "IA342" },
    sessionCookie(await login(f, username, studentPassphrase)),
  );
  assert.equal(otherCourseResponse.status, 200);
  const otherCourse = sessionCookie(otherCourseResponse);
  const launchPath = "/api/v1/canvas/launch";
  const launch = () =>
    f.request(launchPath, {
      method: "POST",
      headers: {
        origin: canvas.canvasOrigin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: signed(f.config.publicOrigin + launchPath, {
        roles: "Learner",
        custom_canvas_user_id: paired.demo.studentUserId,
        oauth_nonce: randomUUID(),
      }),
    });
  const canvasLaunch = await launch();
  assert.equal(canvasLaunch.status, 303);
  const canvasStudent = sessionCookie(canvasLaunch);
  const path = "/api/v1/auth/demo-accounts";
  const list = (cookie) => f.request(path, { headers: { cookie } });
  const update = (cookie, value) =>
    post(f, path, { username, ...value }, cookie);
  const summary = {
    username,
    role: "student",
    label: "Demo Student",
    active: true,
  };
  const suspend = { action: "active", active: false };
  const restore = { action: "active", active: true };
  const revoke = { action: "revoke-sessions" };
  for (const cookie of [teacher, student, otherCourse, canvasStudent]) {
    assert.equal((await list(cookie)).status, 403);
    assert.equal((await update(cookie, suspend)).status, 403);
  }
  assert.deepEqual(await (await list(admin)).json(), {
    accounts: [
      summary,
      {
        username: "demo-teacher",
        role: "teacher",
        label: "Demo Teacher",
        active: true,
      },
    ],
  });
  assert.equal(
    (await update(admin, { ...suspend, username: "admin" })).status,
    400,
  );
  assert.equal(
    (await update(admin, { ...suspend, role: "teacher" })).status,
    400,
  );
  assert.equal(
    (await update(admin, { action: "rename", label: "<invalid>" })).status,
    400,
  );
  await saveQuestion(f, student, "Synthetic existing account History");
  const label = "Synthetic Learner";
  assert.deepEqual(
    await (
      await update(admin, { action: "rename", label: ` ${label} ` })
    ).json(),
    {
      ...summary,
      label,
    },
  );
  assert.deepEqual(await (await status(f, student)).json(), {
    role: "student",
    source: "local",
    course: "IA340",
    label,
  });
  assert.equal((await query(f, student)).length, 1);
  assert.deepEqual(await query(f, otherCourse), []);

  assert.equal((await update(admin, revoke)).status, 200);
  for (const cookie of [student, otherCourse, canvasStudent])
    assert.equal((await status(f, cookie)).status, 401);
  const freshStudent = sessionCookie(
    await login(f, username, studentPassphrase),
  );
  assert.equal((await status(f, freshStudent)).status, 200);

  assert.deepEqual(await (await update(admin, suspend)).json(), {
    ...summary,
    label,
    active: false,
  });
  assert.equal((await status(f, freshStudent)).status, 401);
  assert.equal((await login(f, username, studentPassphrase)).status, 401);
  assert.equal((await launch()).status, 403);
  assert.deepEqual(f.authStore.listDemoMemberships(), grants);
  assert.equal((await update(admin, restore)).status, 200);
  assert.equal((await status(f, freshStudent)).status, 401);
  assert.equal((await status(f, teacher)).status, 200);
  assert.equal((await status(f, admin)).status, 200);
  const restored = sessionCookie(await login(f, username, studentPassphrase));
  assert.equal((await query(f, restored)).length, 1);
  assert.equal((await launch()).status, 303);
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
    async teacherDraft(course, kind, topic, signal, includeCriteria) {
      calls.push([course, kind, topic, includeCriteria]);
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
  const draft = (cookie, course = "IA340", kind = "PAGE", options = {}) =>
    post(
      f,
      "/api/v1/teacher-draft",
      { course, kind, topic: "Lab 5", ...options },
      cookie,
    );
  const teacher = await launch();
  const learner = await launch({
    roles: "Learner",
    custom_canvas_user_id: paired.demo.studentUserId,
  });
  assert.equal((await draft("")).status, 401);
  assert.equal((await draft(learner)).status, 403);
  assert.equal((await draft(teacher, "IA342")).status, 403);
  const criteria = { includeCriteria: true };
  assert.equal(
    (await draft(learner, "IA340", "ASSIGNMENT", criteria)).status,
    403,
  );
  assert.equal(
    (await draft(teacher, "IA342", "ASSIGNMENT", criteria)).status,
    403,
  );
  assert.equal((await draft(teacher, "IA340", "PAGE", criteria)).status, 400);
  assert.equal(
    (await draft(teacher, "IA340", "ASSIGNMENT", { includeCriteria: "yes" }))
      .status,
    400,
  );
  assert.equal(
    (
      await draft(teacher, "IA340", "ASSIGNMENT", {
        ...criteria,
        rubricId: "1",
      })
    ).status,
    400,
  );
  assert.deepEqual(calls, []);
  for (const [kind, options] of [
    ["PAGE", {}],
    ["ASSIGNMENT", {}],
    ["ASSIGNMENT", criteria],
  ]) {
    const response = await draft(teacher, "IA340", kind, options);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      text: "Synthetic editable suggestion",
      sources: [{ path: "docs/example.md", section: "Lab 5" }],
    });
  }
  assert.deepEqual(calls, [
    ["IA340", "PAGE", "Lab 5", false],
    ["IA340", "ASSIGNMENT", "Lab 5", false],
    ["IA340", "ASSIGNMENT", "Lab 5", true],
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
    const request = draft(current, "IA340", "ASSIGNMENT", criteria);
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

test("Teacher History uses the existing local Demo Student's questions for each active course", async (t) => {
  const route = "/api/v1/teacher-tools/history";
  const summaries = [];
  let selectionCalls = 0;
  let reads = 0;
  let summaryUnavailable = false;
  const f = await fixture({
    autoLogin: false,
    canvas: () => paired,
    authNow: () => canvasNow,
    history: true,
    teacherHistory: {
      read(scope) {
        reads++;
        return f.persistence.history(scope);
      },
      async select(question) {
        selectionCalls++;
        if (question === "Show another student's history.")
          return {
            name: "history_count",
            arguments: { window: "recent", course: "IA342" },
          };
        return {
          name: question.startsWith("Summarize")
            ? "history_summary"
            : "history_count",
          arguments: { window: "recent" },
        };
      },
      async summarize(input) {
        summaries.push(JSON.parse(input));
        if (summaryUnavailable) throw new Error("Synthetic Local failure");
        return summaries.at(-1).length === 1
          ? "The topic is tides."
          : "The topics are maps and visual comparisons.";
      },
    },
  });
  t.after(() => f.close());
  const get = (cookie) => f.request(route, { headers: { cookie } });
  const ask = (cookie, question = "How many questions?", options = {}) =>
    post(f, route, { question, ...options }, cookie);
  const responseText = async (...args) => {
    const response = await ask(...args);
    assert.equal(response.status, 200);
    return (await response.json()).text;
  };
  const otherCourse = async (cookie) => {
    const response = await post(
      f,
      "/api/v1/auth/course",
      { course: "IA342" },
      cookie,
    );
    assert.equal(response.status, 200);
    return sessionCookie(response);
  };
  const launch = async (changes) => {
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
        ...changes,
      }),
    });
    assert.equal(response.status, 303);
    return sessionCookie(response);
  };
  const ownerTeacher = sessionCookie(await f.login("teacher"));
  assert.equal((await get(ownerTeacher)).status, 404);
  assert.equal((await ask(ownerTeacher)).status, 404);
  assert.equal(selectionCalls, 0);

  f.authStore.configureDemo("IA340", ...(await credentials));
  f.authStore.grantDemoMembership("demo-teacher", "IA342");
  const teacher = sessionCookie(
    await login(f, "demo-teacher", teacherPassphrase),
  );
  const teacher342 = await otherCourse(
    sessionCookie(await login(f, "demo-teacher", teacherPassphrase)),
  );
  const student = sessionCookie(
    await login(f, "demo-student", studentPassphrase),
  );
  const instructor = await launch();
  const learner = await launch({
    roles: "Learner",
    custom_canvas_user_id: paired.demo.studentUserId,
  });
  const admin = sessionCookie(await login(f, "admin", testPassphrase));
  assert.deepEqual(await (await get(instructor)).json(), { enabled: true });
  for (const cookie of [teacher342, student, learner, admin]) {
    assert.equal((await get(cookie)).status, 403);
    assert.equal((await ask(cookie)).status, 403);
  }
  assert.equal(
    (await ask(instructor, "How many questions in IA342?")).status,
    403,
  );
  assert.equal(
    (await ask(instructor, "How many questions in IA340 and IA342?")).status,
    403,
  );
  assert.equal(
    (
      await ask(instructor, "How many questions?", {
        course: "IA342",
        principal: "demo-student",
      })
    ).status,
    400,
  );
  assert.equal(selectionCalls, 0);
  assert.match(
    await responseText(instructor, "Show another student's history."),
    /Ask for a recent question count or summary/,
  );
  assert.equal(reads, 0);

  assert.match(
    await responseText(instructor),
    /^0 questions recorded for the local Demo Student in this course/,
  );
  assert.match(
    await responseText(instructor, "Summarize recent questions."),
    /^No questions were recorded/,
  );
  assert.deepEqual(summaries, []);
  await saveQuestion(f, learner, "What is a signed-only synthetic question?");
  await saveQuestion(f, student, "How can tides be compared?");
  f.authStore.grantDemoMembership("demo-student", "IA342");
  const student342 = await otherCourse(student);
  await saveQuestion(f, student342, "How do map layers work?");
  await saveQuestion(f, student342, "How do I compare two maps?");
  assert.match(await responseText(teacher), /^1 question recorded/);
  assert.match(await responseText(instructor), /^1 question recorded/);
  assert.match(await responseText(teacher342), /^2 questions recorded/);
  assert.equal(
    await responseText(instructor, "Summarize recent questions."),
    "The topic is tides.",
  );
  assert.equal(
    await responseText(teacher342, "Summarize recent questions."),
    "The topics are maps and visual comparisons.",
  );
  assert.deepEqual(summaries, [
    ["How can tides be compared?"],
    ["How do I compare two maps?", "How do map layers work?"],
  ]);
  summaryUnavailable = true;
  assert.match(
    await responseText(instructor, "Summarize recent questions."),
    /count is still available/,
  );
  assert.match(await responseText(instructor), /^1 question recorded/);
  assert.doesNotMatch(JSON.stringify(f.logs), /tides|map layers|signed-only/);
});

test(
  "scoped Teacher History stops reading or returning after revocation, expiry, drift or cancellation",
  { timeout: 30_000 },
  async (t) => {
    const path = "/api/v1/teacher-tools/history";
    let configuration = paired;
    let clock = canvasNow;
    let selecting;
    let summarizing;
    let reads = 0;
    const f = await fixture({
      autoLogin: false,
      canvas: () => configuration,
      authNow: () => clock,
      history: true,
      teacherHistory: {
        read(scope) {
          reads++;
          return f.persistence.history(scope);
        },
        async select(question, signal) {
          if (selecting) {
            const current = selecting;
            current.entered.resolve(signal);
            await current.release.promise;
          }
          return {
            name: question.startsWith("Summarize")
              ? "history_summary"
              : "history_count",
            arguments: { window: "recent" },
          };
        },
        async summarize() {
          summarizing.entered.resolve();
          await summarizing.release.promise;
          return "A synthetic result that must not be returned.";
        },
      },
    });
    t.after(() => f.close());
    f.authStore.configureDemo("IA340", ...(await credentials));
    const launch = async () => {
      const launchPath = "/api/v1/canvas/launch";
      const response = await f.request(launchPath, {
        method: "POST",
        headers: {
          origin: canvas.canvasOrigin,
          cookie: "",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: signed(f.config.publicOrigin + launchPath, {
          oauth_nonce: randomUUID(),
          oauth_timestamp: String(Math.floor(clock / 1000)),
        }),
      });
      assert.equal(response.status, 303);
      return sessionCookie(response);
    };
    const ask = (cookie, question, signal) =>
      f.request(path, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ question }),
        signal,
      });
    const paused = () => ({
      entered: Promise.withResolvers(),
      release: Promise.withResolvers(),
    });
    const active = (who, value) =>
      f.authStore.setDemoMembershipActive(who, "IA340", value);
    for (const [invalidate, expected] of [
      [() => active("demo-student", false), 403],
      [() => active("demo-teacher", false), 401],
      [
        () => {
          configuration = {
            ...paired,
            demo: { ...paired.demo, course: "IA342" },
          };
        },
        401,
      ],
      [
        () => {
          clock += 8 * 3600000;
        },
        401,
      ],
    ]) {
      selecting = paused();
      const pending = ask(await launch(), "How many questions?");
      await selecting.entered.promise;
      invalidate();
      selecting.release.resolve();
      assert.equal((await pending).status, expected);
      assert.equal(reads, 0);
      configuration = paired;
      active("demo-student", true);
      active("demo-teacher", true);
    }
    selecting = paused();
    const cancel = new AbortController();
    const pending = ask(await launch(), "How many questions?", cancel.signal);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    const signal = await selecting.entered.promise;
    const cancelled = Promise.withResolvers();
    signal.addEventListener("abort", cancelled.resolve, { once: true });
    cancel.abort();
    await rejected;
    await cancelled.promise;
    selecting.release.resolve();
    selecting = undefined;

    const student = sessionCookie(
      await login(f, "demo-student", studentPassphrase),
    );
    await saveQuestion(
      f,
      student,
      "How can one compare different practice examples?",
    );
    summarizing = paused();
    const summary = ask(await launch(), "Summarize recent questions.");
    await summarizing.entered.promise;
    active("demo-student", false);
    active("demo-student", true);
    summarizing.release.resolve();
    const response = await summary;
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { code: "FORBIDDEN" });
    assert.equal(reads, 1);
  },
);
