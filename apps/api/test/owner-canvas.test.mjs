import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { initializeRuntimePaths } from "@laita/runtime";
import { initializePersistence } from "@laita/persistence";
import { DatabaseSync } from "node:sqlite";
import { fixture } from "./browser-fixture.mjs";
import { readCanvasPageSettings } from "../dist/canvas-pages.js";
import {
  canvas,
  canvasNow as now,
  signed,
  canvasPageFixture,
} from "./canvas-fixture.mjs";
import { testPassphrase, testCredential } from "./owner-fixture.mjs";
import {
  initializeOwnerCredential,
  verifyOwnerCredential,
} from "../dist/owner-credential.js";
import {
  canvasXml,
  readCanvasConfiguration,
  validateCanvasConfiguration,
  verifyCanvasLaunch,
  canvasContext,
} from "../dist/canvas.js";

const cookie = (res) => res.headers.get("set-cookie")?.split(";")[0];
const owner = "a".repeat(64);
function authenticated(cookieValue, extra = {}) {
  return { cookie: cookieValue, "x-owner-client": owner, ...extra };
}
async function launch(f, changes = {}, extra = {}, secret) {
  return f.request("/api/v1/canvas/launch", {
    method: "POST",
    headers: {
      origin: canvas.canvasOrigin,
      "sec-fetch-site": "cross-site",
      "content-type": "application/x-www-form-urlencoded",
      cookie: "",
      ...extra,
    },
    body: signed(
      `${f.config.publicOrigin}/api/v1/canvas/launch`,
      changes,
      secret,
    ),
  });
}
async function session(f, cookieValue) {
  const response = await f.request("/api/v1/input/sessions", {
    method: "POST",
    headers: authenticated(cookieValue),
  });
  assert.equal(response.status, 200);
  return (await response.json()).sessionRef;
}
async function draft(f, cookieValue, ref, text) {
  const response = await f.request("/api/v1/input/turns", {
    method: "POST",
    headers: authenticated(cookieValue, {
      "x-input-session": ref,
      "content-type": "application/json",
    }),
    body: JSON.stringify({ text, source: "TYPED" }),
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function query(f, cookieValue) {
  const response = await f.request("/api/v1/history/query", {
    method: "POST",
    headers: authenticated(cookieValue, { "content-type": "application/json" }),
    body: "{}",
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("one Owner credential has unique salt/revision, safe derivation and no usable default", async (t) => {
  const f = await fixture({ autoLogin: false, initializeCredential: false });
  t.after(() => f.close());
  assert.equal(f.authStore.credential(), undefined);
  for (const role of ["admin", "teacher", "student"]) {
    assert.equal((await f.login(role, "admin")).status, 503);
    assert.equal(
      (
        await f.request("/api/v1/input/sessions", {
          method: "POST",
          headers: { "x-owner-client": owner },
        })
      ).status,
      401,
    );
  }
  await assert.rejects(initializeOwnerCredential("short"));
  await assert.rejects(initializeOwnerCredential("字".repeat(400)));
  const a = await testCredential,
    b = await initializeOwnerCredential(testPassphrase);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.revision, b.revision);
  assert.equal(await verifyOwnerCredential(testPassphrase, a), true);
  assert.equal(await verifyOwnerCredential("wrong passphrase", a), false);
  f.authStore.setCredential(a);
  assert.equal((await f.login("teacher", "wrong passphrase")).status, 401);
  for (const role of ["admin", "teacher", "student"]) {
    const login = await f.login(role);
    assert.equal(login.status, 200);
    assert.match(
      login.headers.get("set-cookie"),
      /HttpOnly; Secure; SameSite=Lax/,
    );
    const status = await f.request("/api/v1/auth/session");
    assert.deepEqual(await status.json(), { role, source: "local" });
    await session(f, f.cookie());
  }
  assert.equal(
    JSON.stringify(f.authStore.credential()).includes(testPassphrase),
    false,
  );
  assert.equal(JSON.stringify(f.logs).includes(testPassphrase), false);
});

test("role/session isolation covers chat references, History list/detail/feedback/review and Admin controls", async (t) => {
  const f = await fixture({ autoLogin: false, history: true });
  t.after(() => f.close());
  f.persistence.history().begin({
    id: "d".repeat(64),
    conversation: "e".repeat(64),
    inputType: "TYPED",
    text: "Synthetic legacy unscoped record",
    correlation: null,
  });
  await f.login("teacher");
  const teacher = f.cookie(),
    teacherSession = await session(f, teacher);
  const teacherTurn = await draft(
    f,
    teacher,
    teacherSession,
    "A synthetic teacher question.",
  );
  const teacherList = await query(f, teacher);
  assert.equal(teacherList.items.length, 1);
  await f.login("student");
  const student = f.cookie(),
    studentSession = await session(f, student);
  await draft(f, student, studentSession, "A synthetic student question.");
  assert.equal((await query(f, student)).items.length, 1);
  assert.equal(
    (
      await f.request("/api/v1/input/build", {
        headers: authenticated(student, { "x-input-session": teacherSession }),
      })
    ).status,
    404,
  );
  assert.equal(
    (await f.request("/api/admin/access", { headers: { cookie: student } }))
      .status,
    403,
  );
  for (const route of ["conversation", "feedback", "review"]) {
    const body =
      route === "conversation"
        ? { conversation: teacherList.items[0].conversation }
        : route === "feedback"
          ? {
              conversation: teacherList.items[0].conversation,
              turn: teacherTurn.turn,
              leg: "",
              vote: null,
              report: true,
              reason: "Synthetic report",
            }
          : {
              conversation: teacherList.items[0].conversation,
              turn: teacherTurn.turn,
              review: "REVIEWED",
              note: "",
              suspected: false,
              suspicionReason: "",
            };
    const response = await f.request(`/api/v1/history/${route}`, {
      method: "POST",
      headers: authenticated(student, { "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    assert.ok([400, 403].includes(response.status));
  }
  await f.login("admin");
  const admin = f.cookie();
  assert.equal((await query(f, admin)).items.length, 3);
  assert.equal(
    (await f.request("/api/admin/access", { headers: { cookie: admin } }))
      .status,
    200,
  );
  await f.request("/api/v1/auth/logout", { method: "POST" });
  assert.equal(
    (await f.request("/api/v1/auth/session", { headers: { cookie: admin } }))
      .status,
    401,
  );
});

test("valid signed Canvas launch enters Teacher without password; scoped History and no Admin or provisioning", async (t) => {
  let config = { ...canvas };
  const f = await fixture({
    autoLogin: false,
    canvas: () => config,
    authNow: () => now,
    history: true,
  });
  t.after(() => f.close());
  const response = await launch(f);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/");
  const teacher = cookie(response);
  assert.deepEqual(
    await (
      await f.request("/api/v1/auth/session", { headers: { cookie: teacher } })
    ).json(),
    { role: "teacher", source: "canvas" },
  );
  const ref = await session(f, teacher);
  await draft(f, teacher, ref, "Synthetic Canvas question.");
  assert.equal((await query(f, teacher)).items.length, 1);
  for (const route of [
    "/api/admin/access",
    "/api/admin/provider-policy",
    "/api/admin/provider-usage/summary",
  ])
    assert.equal(
      (await f.request(route, { headers: { cookie: teacher } })).status,
      403,
    );
  // A second course context remains outside this Canvas session's History scope.
  f.persistence
    .history({ role: "teacher", context: "another-synthetic-context" })
    .begin({
      id: "b".repeat(64),
      conversation: "c".repeat(64),
      inputType: "TYPED",
      text: "Other synthetic context",
      correlation: null,
    });
  assert.equal((await query(f, teacher)).items.length, 1);
  await f.login("teacher");
  assert.equal((await query(f, f.cookie())).items.length, 2);
  const before = f.authStore.credential();
  const denied = await launch(f, {
    custom_canvas_user_id: "73002",
    oauth_nonce: "synthetic-unknown-user",
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(f.authStore.credential(), before);
  assert.equal(
    (await launch(f)).status,
    403,
    "nonce remains consumed across sessions",
  );
  config = undefined;
  assert.equal(
    (await f.request("/api/v1/auth/session", { headers: { cookie: teacher } }))
      .status,
    401,
  );
  assert.equal(
    (await launch(f, { oauth_nonce: "synthetic-disabled" })).status,
    503,
  );
  assert.equal(
    (await f.login("admin")).status,
    200,
    "standalone survives disabling Canvas",
  );
});

test("Admin diagnostic requires a local Admin session and projects only retained stages", async (t) => {
  const f = await fixture({
    autoLogin: false,
    canvas: () => canvas,
    authNow: () => now,
    history: true,
  });
  t.after(() => f.close());
  const reference = randomUUID();
  const turn = "b".repeat(64);
  const store = f.persistence.history({ role: "teacher" });
  store.begin({
    id: turn,
    conversation: "c".repeat(64),
    inputType: "TYPED",
    text: "Synthetic question excluded from diagnostics",
    correlation: reference,
  });
  store.event(turn, {
    stage: "INPUT",
    origin: "SERVER",
    outcome: "RECEIVED",
    at: new Date().toISOString(),
    durationMs: 17,
  });
  const lookup = (identity, value = { reference }, route = "diagnostic") =>
    f.request(`/api/v1/history/${route}`, {
      method: "POST",
      headers: authenticated(identity, { "content-type": "application/json" }),
      body: JSON.stringify(value),
    });
  assert.equal((await lookup("")).status, 401);
  for (const role of ["teacher", "student"]) {
    const signedIn = await f.login(role);
    assert.equal(signedIn.status, 200);
    assert.equal((await lookup(cookie(signedIn))).status, 403);
    assert.equal(
      (await lookup(cookie(signedIn), { reference }, "DIAGNOSTIC/")).status,
      403,
    );
  }
  const signedCanvas = await launch(f);
  assert.equal(signedCanvas.status, 303);
  assert.equal((await lookup(cookie(signedCanvas))).status, 403);
  const signedAdmin = await f.login("admin");
  assert.equal(signedAdmin.status, 200);
  const admin = cookie(signedAdmin);
  for (const value of [
    {},
    { reference, turn },
    { reference: reference + "\n" },
    { reference: 7 },
  ])
    assert.equal((await lookup(admin, value)).status, 400);
  const observed = await lookup(admin);
  assert.equal(observed.status, 200);
  assert.equal(observed.headers.get("cache-control"), "no-store");
  assert.deepEqual(await observed.json(), {
    diagnostic: {
      recording: "RECORDED",
      outcome: "PENDING",
      stages: [{ stage: "INPUT", origin: "SERVER" }],
    },
  });
  assert.deepEqual(
    await (await lookup(admin, { reference: randomUUID() })).json(),
    {
      diagnostic: null,
    },
  );
  assert.equal(f.calls(), 0);
  assert.ok(!JSON.stringify(f.logs).includes(reference));
});

for (const [name, changes] of [
  ["wrong user", { custom_canvas_user_id: "73002" }],
  ["wrong course", { custom_canvas_course_id: "42002" }],
  ["wrong role", { roles: "Learner" }],
  ["platform admin alone", { roles: "Administrator" }],
  ["wrong signed origin", { custom_canvas_api_domain: "other.example.test" }],
  ["wrong consumer key", { oauth_consumer_key: "unknown-synthetic-consumer" }],
  ["stale timestamp", { oauth_timestamp: String(now / 1000 - 301) }],
  ["future timestamp", { oauth_timestamp: String(now / 1000 + 301) }],
  ["wrong signature method", { oauth_signature_method: "PLAINTEXT" }],
  ["OAuth token", { oauth_token: "synthetic-token" }],
])
  test(`Canvas fails closed: ${name}`, async (t) => {
    const f = await fixture({
      autoLogin: false,
      canvas: () => canvas,
      authNow: () => now,
    });
    t.after(() => f.close());
    const response = await launch(f, changes);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal((await f.request("/api/v1/auth/session")).status, 401);
  });

test("invalid signature, duplicate form/query parameters, wrong HTTP origin, missing credentials and unavailable config fail closed", async (t) => {
  const f = await fixture({
    autoLogin: false,
    canvas: () => canvas,
    authNow: () => now,
  });
  t.after(() => f.close());
  const url = `${f.config.publicOrigin}/api/v1/canvas/launch`,
    body = signed(url);
  for (const invalid of [
    body.replace(
      /oauth_signature=[^&]+/u,
      "oauth_signature=AAAAAAAAAAAAAAAAAAAAAAAAAAA%3D",
    ),
    body + "&roles=Instructor",
    body + "&custom_canvas_course_id=42001",
    signed("https://other.example.test/api/v1/canvas/launch"),
  ]) {
    const response = await f.request("/api/v1/canvas/launch", {
      method: "POST",
      headers: {
        origin: canvas.canvasOrigin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: invalid,
    });
    assert.equal(response.status, 403);
  }
  assert.equal(
    (await launch(f, {}, { origin: "https://other.example.test" })).status,
    403,
  );
  const missing = await fixture({
    autoLogin: false,
    initializeCredential: false,
    canvas: () => canvas,
    authNow: () => now,
  });
  t.after(() => missing.close());
  assert.equal((await launch(missing)).status, 503);
  const disabled = await fixture({ autoLogin: false });
  t.after(() => disabled.close());
  assert.equal((await launch(disabled)).status, 503);
});

test("nonce replay survives SQLite reopen and concurrent repositories; Owner credential rotation invalidates Owner sessions", async (t) => {
  const f = await fixture({
    autoLogin: false,
    canvas: () => canvas,
    authNow: () => now,
  });
  t.after(() => f.close());
  const response = await launch(f);
  assert.equal(response.status, 303);
  const material = f.authStore.credential();
  await f.login("admin");
  const admin = f.cookie();
  f.authStore.setCredential(
    await initializeOwnerCredential("replacement synthetic owner passphrase"),
  );
  for (const c of [cookie(response), admin])
    assert.equal(
      (await f.request("/api/v1/auth/session", { headers: { cookie: c } }))
        .status,
      401,
    );
  assert.equal((await f.login("student", testPassphrase)).status, 401);
  assert.equal(
    (await f.login("student", "replacement synthetic owner passphrase")).status,
    200,
  );
  const root = mkdtempSync(path.join(tmpdir(), "laita-nonce-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = initializeRuntimePaths(path.join(root, "runtime"));
  assert.equal(paths.ok, true);
  const file = path.join(root, "runtime/data/foundation.sqlite");
  const first = initializePersistence(paths.value);
  assert.equal(first.ok, true);
  let repo = first.value.ownerAuth();
  repo.setCredential(material);
  const digest = createHash("sha256")
    .update("synthetic persistent nonce")
    .digest("hex");
  assert.equal(repo.consumeNonce(digest, now / 1000 + 300, now / 1000), true);
  first.value.close();
  const reopened = initializePersistence(paths.value);
  assert.equal(reopened.ok, true);
  repo = reopened.value.ownerAuth();
  const other = initializePersistence(paths.value);
  assert.equal(other.ok, true);
  const second = other.value.ownerAuth();
  const db = new DatabaseSync(file, { readOnly: true });
  t.after(() => {
    db.close();
    other.value.close();
    reopened.value.close();
  });
  assert.equal(repo.consumeNonce(digest, now / 1000 + 300, now / 1000), false);
  const next = createHash("sha256")
    .update("another synthetic nonce")
    .digest("hex");
  assert.deepEqual(
    [
      repo.consumeNonce(next, now / 1000 + 300, now / 1000),
      second.consumeNonce(next, now / 1000 + 300, now / 1000),
    ],
    [true, false],
  );
  assert.equal(readFileSync(file).includes(Buffer.from(testPassphrase)), false);
  const tables = db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
    .all()
    .map((x) => x.name);
  assert.deepEqual(
    tables.filter((name) => /users|memberships|accounts/u.test(name)),
    ["demo_memberships"],
  );
  assert.deepEqual(repo.listDemoMemberships(), []);
});

test("Canvas config and generated Paste XML have bounded generic origin, substitutions and top-level navigation", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "laita-canvas-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "canvas.json");
  writeFileSync(file, JSON.stringify(canvas), { mode: 0o600 });
  assert.deepEqual(readCanvasConfiguration(file), canvas);
  chmodSync(file, 0o644);
  assert.equal(readCanvasConfiguration(file), undefined);
  chmodSync(file, 0o600);
  symlinkSync(file, path.join(root, "link.json"));
  assert.equal(
    readCanvasConfiguration(path.join(root, "link.json")),
    undefined,
  );
  const rest = path.join(root, "canvas-rest.json");
  const { settings } = canvasPageFixture();
  writeFileSync(rest, JSON.stringify(settings), { mode: 0o600 });
  assert.deepEqual(readCanvasPageSettings(rest), settings);
  chmodSync(rest, 0o644);
  assert.equal(readCanvasPageSettings(rest), undefined);
  chmodSync(rest, 0o600);
  symlinkSync(rest, path.join(root, "rest-link.json"));
  assert.equal(
    readCanvasPageSettings(path.join(root, "rest-link.json")),
    undefined,
  );
  writeFileSync(rest, Buffer.alloc(4097, " "));
  assert.equal(readCanvasPageSettings(rest), undefined);
  writeFileSync(rest, Buffer.from([0xc3, 0x28]));
  assert.equal(readCanvasPageSettings(rest), undefined);
  for (const bad of [
    { ...canvas, enabled: false },
    { ...canvas, canvasOrigin: "http://canvas.example.test" },
    { ...canvas, sharedSecret: "short" },
    { ...canvas, courseId: "" },
    { ...canvas, extra: "ignored?" },
  ])
    assert.throws(() => validateCanvasConfiguration(bad));
  writeFileSync(file, "{}");
  assert.equal(readCanvasConfiguration(file), undefined);
  assert.equal(readCanvasConfiguration(undefined), undefined);
  const xml = canvasXml("https://laita.example.test");
  for (const value of [
    "$Canvas.api.domain",
    "$Canvas.course.id",
    "$Canvas.user.id",
    "windowTarget",
    "_blank",
    "privacy_level",
    "anonymous",
  ])
    assert.ok(xml.includes(value));
  for (const value of [
    canvas.consumerKey,
    canvas.sharedSecret,
    canvas.userId,
    canvas.courseId,
  ])
    assert.equal(xml.includes(value), false);
  assert.throws(() => canvasXml("http://laita.example.test"));
  assert.notEqual(
    canvasContext(canvas),
    canvasContext({ ...canvas, courseId: "42002" }),
  );
});

test("credential setup refuses redirected password input without printing or creating credential state", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "laita-credential-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = JSON.parse(
    readFileSync(
      new URL(
        "../../../ops/macos/application-config.json.template",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  config.runtimeRoot = path.join(root, "runtime");
  const result = spawnSync(
    process.execPath,
    [
      new URL("../dist/owner-setup.js", import.meta.url).pathname,
      "owner-setup",
    ],
    {
      env: { APP_CONFIG_JSON: JSON.stringify(config) },
      input: testPassphrase + "\n" + testPassphrase + "\n",
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /interactive Terminal/u);
  assert.equal((result.stdout + result.stderr).includes(testPassphrase), false);
  assert.equal(existsSync(config.runtimeRoot), false);
});

test("OAuth normalization matches an independently computed Python RFC 5849 golden vector", () => {
  const url = "https://laita.example.test/api/v1/canvas/launch";
  const form = signed(url, { custom_note: "Synthetic + 中文 & ?" });
  assert.equal(
    new URLSearchParams(form).get("oauth_signature"),
    "n4rReLD8vH5D/CmJUGYkUJDNE78=",
  );
  assert.ok(verifyCanvasLaunch(form, canvas, url, now / 1000));
  assert.equal(
    verifyCanvasLaunch(
      form + "&custom_note=duplicate",
      canvas,
      url,
      now / 1000,
    ),
    undefined,
  );
  assert.equal(
    verifyCanvasLaunch(form, canvas, url, now / 1000 + 301),
    undefined,
  );
  assert.ok(verifyCanvasLaunch(form, canvas, url, now / 1000 + 300));
});

test("Student review aliases cannot cross the repository boundary; Canvas requires the canonical path", async (t) => {
  const f = await fixture({
    autoLogin: false,
    history: true,
    canvas: () => canvas,
    authNow: () => now,
  });
  t.after(() => f.close());
  await f.login("student");
  const student = f.cookie(),
    ref = await session(f, student);
  await draft(f, student, ref, "A synthetic Student record.");
  const item = (await query(f, student)).items[0];
  for (const route of ["review", "review/", "Review", "REVIEW/"]) {
    const response = await f.request(`/api/v1/history/${route}`, {
      method: "POST",
      headers: authenticated(student, { "content-type": "application/json" }),
      body: JSON.stringify({
        conversation: item.conversation,
        turn: item.id,
        review: "CONFIRMED_ISSUE",
        note: "",
        suspected: false,
        suspicionReason: "",
      }),
    });
    assert.equal(response.status, 403, route);
  }
  assert.equal(
    f.persistence.history().conversation(item.conversation).turns[0].review,
    "PENDING",
  );
  for (const role of ["teacher", "admin"]) {
    assert.equal((await f.login(role)).status, 200);
    const c = f.cookie();
    const ref = await session(f, c);
    await draft(f, c, ref, `A synthetic ${role} record.`);
    const item = (await query(f, c)).items[0];
    for (const route of ["review", "review/", "Review", "REVIEW/"]) {
      const response = await f.request(`/api/v1/history/${route}`, {
        method: "POST",
        headers: authenticated(c, { "content-type": "application/json" }),
        body: JSON.stringify({
          conversation: item.conversation,
          turn: item.id,
          review: "REVIEWED",
          note: "Synthetic Owner review",
          suspected: false,
          suspicionReason: "",
        }),
      });
      assert.equal(response.status, 200, `${role}: ${route}`);
      assert.deepEqual(await response.json(), { saved: true });
    }
    assert.equal(
      f.persistence.history().conversation(item.conversation).turns[0].review,
      "REVIEWED",
    );
  }
  for (const route of [
    "/api/v1/canvas/launch/",
    "/API/V1/CANVAS/LAUNCH",
    "/api/v1/canvas/launch?extra=1",
  ]) {
    const response = await f.request(route, {
      method: "POST",
      headers: {
        origin: canvas.canvasOrigin,
        "content-type": "application/x-www-form-urlencoded",
        cookie: "",
      },
      body: signed(`${f.config.publicOrigin}/api/v1/canvas/launch`),
    });
    assert.equal(response.status, 403);
  }
});

test("role switch revokes the previous browser session and expiry/revocation close access", async (t) => {
  let clock = now;
  const f = await fixture({ autoLogin: false, authNow: () => clock });
  t.after(() => f.close());
  await f.login("admin");
  const admin = f.cookie(),
    old = await session(f, admin);
  const response = await f.request("/api/v1/auth/login", {
    method: "POST",
    headers: { cookie: admin, "content-type": "application/json" },
    body: JSON.stringify({ role: "teacher", passphrase: testPassphrase }),
  });
  assert.equal(response.status, 200);
  const teacher = cookie(response);
  assert.equal(
    (await f.request("/api/v1/auth/session", { headers: { cookie: admin } }))
      .status,
    401,
  );
  assert.equal(
    (
      await f.request("/api/v1/input/build", {
        headers: authenticated(teacher, { "x-input-session": old }),
      })
    ).status,
    404,
  );
  assert.equal(
    (await f.request("/api/admin/access", { headers: { cookie: teacher } }))
      .status,
    403,
  );
  clock += 8 * 3600000;
  assert.equal(
    (await f.request("/api/v1/auth/session", { headers: { cookie: teacher } }))
      .status,
    401,
  );
});

test("Teacher local and Canvas sessions can read instructor capabilities while Student and Admin controls remain isolated", async (t) => {
  const f = await fixture({
    autoLogin: false,
    canvas: () => canvas,
    authNow: () => now,
  });
  t.after(() => f.close());
  await f.login("teacher");
  const local = f.cookie();
  const launched = await launch(f);
  assert.equal(launched.status, 303);
  for (const c of [local, cookie(launched)]) {
    assert.equal(
      (
        await f.request("/api/instructor/capabilities", {
          headers: { cookie: c },
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.request("/api/admin/access", { headers: { cookie: c } })).status,
      403,
    );
    assert.equal(
      (
        await f.request("/api/admin/provider-policy", {
          headers: { cookie: c },
        })
      ).status,
      403,
    );
  }
  await f.login("student");
  assert.equal((await f.request("/api/instructor/capabilities")).status, 403);
});

test("authorization status/logout entry has a shared finite rate budget", async (t) => {
  const f = await fixture({ autoLogin: false });
  t.after(() => f.close());
  for (let i = 0; i < 600; i++)
    assert.equal((await f.request("/api/v1/auth/session")).status, 401);
  assert.equal((await f.request("/api/v1/auth/session")).status, 429);
  assert.equal(
    (await f.request("/api/v1/auth/logout", { method: "POST" })).status,
    429,
  );
});

test("Canvas Origin is rechecked against the final configuration snapshot after body parsing", async (t) => {
  let reads = 0;
  const f = await fixture({
    autoLogin: false,
    authNow: () => now,
    canvas: () =>
      ++reads <= 2
        ? canvas
        : { ...canvas, canvasOrigin: "https://changed.example.test" },
  });
  t.after(() => f.close());
  const response = await launch(f, {
    custom_canvas_api_domain: "changed.example.test",
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("proxy scheme/host casing is equivalent without accepting other authorities, lists or Origins", async (t) => {
  const f = await fixture({
    autoLogin: false,
    publicOrigin: "https://localhost:3443",
    canvas: () => canvas,
    authNow: () => now,
  });
  t.after(() => f.close());
  const mixed = {
    "x-forwarded-proto": "HTTPS",
    "x-forwarded-host": "LocalHost:3443",
  };
  const login = await f.request("/api/v1/auth/login", {
    method: "POST",
    headers: { ...mixed, "content-type": "application/json" },
    body: JSON.stringify({ role: "teacher", passphrase: testPassphrase }),
  });
  assert.equal(login.status, 200);
  const teacher = cookie(login);
  assert.equal(
    (
      await f.request("/api/v1/auth/session", {
        headers: { ...mixed, cookie: teacher },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/v1/input/sessions", {
        method: "POST",
        headers: authenticated(teacher, mixed),
      })
    ).status,
    200,
  );
  assert.equal((await launch(f, {}, mixed)).status, 303);
  for (const invalid of [
    { "x-forwarded-proto": "http" },
    { "x-forwarded-proto": "https,http" },
    { "x-forwarded-host": "localhost:3444" },
    { "x-forwarded-host": "localhost" },
    { "x-forwarded-host": "localhost:3443,evil.example.test" },
    { "x-forwarded-host": "localhost:3443.evil.example.test" },
    { "x-forwarded-host": "user@localhost:3443" },
    { "x-forwarded-host": "" },
    { "x-forwarded-proto": "" },
  ]) {
    const headers = { ...mixed, ...invalid, cookie: teacher };
    assert.equal(
      (await f.request("/api/v1/auth/session", { headers })).status,
      403,
    );
    assert.equal(
      (
        await f.request("/api/v1/input/sessions", {
          method: "POST",
          headers: authenticated(teacher, headers),
        })
      ).status,
      403,
    );
    assert.equal((await launch(f, {}, headers)).status, 403);
  }
  for (const origin of [
    "https://other.example.test",
    "https://LOCALHOST:3443",
  ]) {
    assert.equal(
      (
        await f.request("/api/v1/auth/session", {
          headers: { ...mixed, cookie: teacher, origin },
        })
      ).status,
      403,
    );
  }
  assert.equal(
    (await launch(f, {}, { ...mixed, origin: "https://CANVAS.example.test" }))
      .status,
    403,
  );
});

test("local Teacher History reads only the explicitly selected Test Student sample", async (t) => {
  const context = "5".repeat(64);
  const route = "/api/v1/teacher-tools/history";
  const phrasedCount =
    "Give me the tally of questions over the past seven days.";
  const phrasedSummary = "Which themes came up in the sample lately?";
  let summaries = 0;
  let reads = 0;
  const f = await fixture({
    autoLogin: false,
    authNow: () => now,
    canvas: () => canvas,
    history: true,
    teacherHistory: {
      context,
      read() {
        reads++;
        return f.persistence.history({ role: "student", context });
      },
      async select(question) {
        if (question === phrasedCount)
          return { name: "history_count", arguments: { window: "recent" } };
        if (question === phrasedSummary)
          return { name: "history_summary", arguments: { window: "recent" } };
        return {
          name: "history_count",
          arguments: { window: "recent", sample: "different" },
        };
      },
      async summarize(questions) {
        summaries++;
        assert.deepEqual(JSON.parse(questions), [
          "How can two practice examples be compared?",
        ]);
        return "The main topic is comparing practice examples.";
      },
    },
  });
  t.after(() => f.close());
  const ask = (sessionCookie, question, extra = {}) =>
    f.request(route, {
      method: "POST",
      headers: authenticated(sessionCookie, {
        "content-type": "application/json",
        ...extra,
      }),
      body: JSON.stringify({ question }),
    });
  const local = cookie(await f.login("student"));
  await draft(
    f,
    local,
    await session(f, local),
    "What is an ordinary practice question?",
  );
  const explicit = await f.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "" },
    body: JSON.stringify({
      role: "student",
      passphrase: testPassphrase,
      sample: true,
    }),
  });
  assert.equal(explicit.status, 200);
  const sample = cookie(explicit);
  const info = await f.request("/api/v1/auth/session", {
    headers: authenticated(sample),
  });
  assert.deepEqual(await info.json(), {
    role: "student",
    source: "local",
    sample: true,
  });
  const sampleInput = await session(f, sample);
  await draft(
    f,
    sample,
    sampleInput,
    "How can two practice examples be compared?",
  );
  await draft(f, sample, sampleInput, "What name is shown in this example?");
  const other = f.persistence.history({
    role: "student",
    context: "6".repeat(64),
  });
  other.begin({
    id: "7".repeat(64),
    conversation: "8".repeat(64),
    inputType: "TYPED",
    text: "A separate sample question",
    correlation: null,
  });
  const regular = JSON.stringify(await query(f, local));
  assert.match(regular, /ordinary practice question/);
  assert.doesNotMatch(regular, /practice examples|separate sample/);
  const retainedSample = JSON.stringify(await query(f, sample));
  assert.match(retainedSample, /practice examples/);
  assert.doesNotMatch(retainedSample, /ordinary practice|separate sample/);
  assert.equal((await ask(sample, "How many questions?")).status, 403);
  assert.equal(
    (await ask(cookie(await f.login("admin")), "How many questions?")).status,
    403,
  );
  const canvasLogin = await launch(f);
  assert.equal(canvasLogin.status, 303);
  assert.equal(
    (await ask(cookie(canvasLogin), "How many questions?")).status,
    403,
  );
  const teacher = cookie(await f.login("teacher"));
  assert.equal(
    (
      await ask(teacher, "How many questions?", {
        origin: "https://foreign.example.test",
      })
    ).status,
    403,
  );
  const count = await ask(teacher, phrasedCount);
  assert.match((await count.json()).text, /^2 questions recorded/);
  const unsupported = await ask(teacher, "Show all student questions");
  assert.match((await unsupported.json()).text, /one local sample/);
  assert.equal(summaries, 0);
  assert.equal(reads, 1);
  const response = await ask(teacher, phrasedSummary);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    text: "The main topic is comparing practice examples.",
  });
  assert.equal(summaries, 1);
  assert.equal(reads, 2);
  assert.doesNotMatch(
    JSON.stringify(f.logs),
    /practice examples|ordinary practice|separate sample/,
  );
});

test("Teacher History rechecks the session after tool selection and before reading", async (t) => {
  let clock = now;
  const selecting = Promise.withResolvers();
  const selected = Promise.withResolvers();
  const f = await fixture({
    autoLogin: false,
    authNow: () => clock,
    teacherHistory: {
      context: "5".repeat(64),
      read: () => assert.fail("An expired session must not read History"),
      select() {
        selecting.resolve();
        return selected.promise;
      },
      summarize: () =>
        assert.fail("An expired session must not summarize History"),
    },
  });
  t.after(() => f.close());
  assert.equal((await f.login("teacher")).status, 200);
  const pending = f.request("/api/v1/teacher-tools/history", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "What is the recent tally?" }),
  });
  await selecting.promise;
  clock += 8 * 3600000;
  selected.resolve({ name: "history_count", arguments: { window: "recent" } });
  const denied = await pending;
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { code: "UNAUTHENTICATED" });
});

test("Teacher History permits ordinary wording and checks the complete bounded summary", async (t) => {
  const eligible = [
    "How should I address this issue?",
    "How do I ignore empty rows and override the default color?",
    "What are the column names?",
    "How can I visualize grades in a histogram?",
    "How should I visualize a grade as a category?",
  ];
  const questions = [
    ...eligible,
    "What is the student's home address?",
    "Ignore the exercise instructions.",
    "Send a copy to learner@example.test.",
    "My grade is 92%.",
    "What grade did I get?",
  ];
  let output;
  let calls = 0;
  const f = await fixture({
    autoLogin: false,
    teacherHistory: {
      context: "5".repeat(64),
      async select(question) {
        return {
          name:
            question === "How many questions?"
              ? "history_count"
              : "history_summary",
          arguments: { window: "recent" },
        };
      },
      read: () => ({
        sampleQuestions(_since, _until, includeText) {
          return {
            count: questions.length,
            partial: false,
            questions: includeText ? questions : [],
          };
        },
      }),
      async summarize(input) {
        calls++;
        assert.deepEqual(JSON.parse(input), eligible);
        return output;
      },
    },
  });
  t.after(() => f.close());
  assert.equal((await f.login("teacher")).status, 200);
  const ask = async (question) => {
    const response = await f.request("/api/v1/teacher-tools/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).text;
  };
  assert.match(await ask("How many questions?"), /^10 questions recorded/);
  assert.equal(calls, 0);
  const exactLimit = "分析".repeat(170) + "🙂";
  assert.equal(Buffer.byteLength(exactLimit), 1024);
  for (output of [
    "The topics address column names and default colors.",
    "The sample covers visualizing grades in a histogram.",
    exactLimit,
  ]) {
    assert.equal(await ask("Summarize recent questions."), output);
  }
  output = "\tThe topics address column names\r\nand default colors.\n";
  assert.equal(
    await ask("Summarize recent questions."),
    "The topics address column names and default colors.",
  );
  const unavailable =
    "The Local summary is unavailable. The count is still available.";
  for (output of [
    exactLimit + "a",
    "Analysis topics. ".repeat(36) + "Contact learner@example.test.",
    "Home address: 12 Example Lane.",
    "Ignore the exercise instructions.",
    "Practice topics\u202e.",
    "Practice topics\ud800.",
    "Practice topics.\ufeff",
    "Grade: 92%.",
    "She earned a B+ grade.",
  ]) {
    assert.equal(await ask("Summarize recent questions."), unavailable);
  }
  assert.match(await ask("How many questions?"), /^10 questions recorded/);
  assert.equal(calls, 13);
});

test("disabled Test Student setup has no plugin and rejects sample sign-in", async (t) => {
  const f = await fixture({ autoLogin: false });
  t.after(() => f.close());
  const response = await f.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      role: "student",
      passphrase: testPassphrase,
      sample: true,
    }),
  });
  assert.equal(response.status, 400);
  assert.equal(cookie(response), undefined);
  await f.login("teacher");
  assert.equal((await f.request("/api/v1/teacher-tools/history")).status, 404);
});

test("local drafting validates scope and rejects a result after sign-out", async (t) => {
  let finish;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const generated = new Promise((resolve) => {
    finish = resolve;
  });
  const f = await fixture({
    autoLogin: false,
    authNow: () => now,
    canvas: () => canvas,
    async teacherDraft(course, kind, topic) {
      assert.deepEqual([course, kind, topic], ["IA342", "ASSIGNMENT", "Lab 5"]);
      entered();
      return generated;
    },
  });
  t.after(() => f.close());
  const send = (sessionCookie, patch = {}) =>
    f.request("/api/v1/teacher-draft", {
      method: "POST",
      headers: authenticated(sessionCookie, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({
        course: "IA342",
        kind: "ASSIGNMENT",
        topic: "Lab 5",
        ...patch,
      }),
    });
  assert.equal((await send("")).status, 401);
  assert.equal((await send(cookie(await f.login("student")))).status, 403);
  assert.equal((await send(cookie(await f.login("admin")))).status, 403);
  const canvasLogin = await launch(f);
  assert.equal(canvasLogin.status, 303);
  assert.equal((await send(cookie(canvasLogin))).status, 403);
  const teacher = cookie(await f.login("teacher"));
  assert.equal((await send(teacher, { course: "OTHER" })).status, 400);
  assert.equal((await send(teacher, { kind: "MODULE" })).status, 400);
  assert.equal((await send(teacher, { topic: "é".repeat(257) })).status, 400);
  const pending = send(teacher);
  await started;
  const loggedOut = await f.request("/api/v1/auth/logout", {
    method: "POST",
    headers: authenticated(teacher),
  });
  assert.equal(loggedOut.status, 200);
  finish();
  assert.equal((await pending).status, 401);
});

test("Teacher routes share the Owner entry budget before parsing or work", async (t) => {
  const context = "5".repeat(64);
  let draftCalls = 0;
  let historyReads = 0;
  const syntheticCanvas = canvasPageFixture();
  const f = await fixture({
    canvas: () => canvas,
    canvasPages: syntheticCanvas.options,
    autoLogin: false,
    async teacherDraft() {
      draftCalls++;
    },
    teacherHistory: {
      context,
      async select() {
        return { name: "history_count", arguments: { window: "recent" } };
      },
      read() {
        historyReads++;
        return f.persistence.history({ role: "student", context });
      },
      async summarize() {
        assert.fail("Count must not invoke the summary model call");
      },
    },
  });
  t.after(() => f.close());
  const draftPath = "/api/v1/teacher-draft";
  const historyPath = "/api/v1/teacher-tools/history";
  const post = (path, body) =>
    f.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  const sendDraft = () =>
    post(
      draftPath,
      JSON.stringify({ course: "IA342", kind: "PAGE", topic: "Lab 5" }),
    );
  const count = () =>
    post(historyPath, JSON.stringify({ question: "How many questions?" }));
  const getHistory = () => f.request(historyPath);
  const getAuth = () => f.request("/api/v1/auth/session");
  const historySubpath = () => f.request(historyPath + "/unused");
  const badDraft = () => post(draftPath, "{");
  const badHistory = () => post(historyPath, "{");
  const getCanvasPages = () => f.request(pagesPath);
  const badCanvasPreview = () => post(pagesPath + "/preview", "{");
  const badCanvasCreate = () => post(pagesPath + "/create", "{");
  const admitted = [
    [getHistory, 200],
    [count, 200],
    [sendDraft, 200],
    [badDraft, 400],
    [badHistory, 400],
    [getAuth, 200],
    [historySubpath, 404],
    [getCanvasPages, 403],
    [badCanvasPreview, 400],
    [badCanvasCreate, 400],
    [() => f.request(assignmentsPath), 403],
    [() => post(assignmentsPath + "/preview", "{"), 400],
    [() => post(assignmentsPath + "/save", "{"), 400],
    [() => f.request(modulesPath), 403],
    [() => post(modulesPath + "/preview", "{"), 400],
    [() => post(modulesPath + "/save", "{"), 400],
    [() => f.request(feedbackPath), 403],
    [() => post(feedbackPath + "/preview", "{"), 400],
    [() => post(feedbackPath + "/post", "{"), 400],
    [() => f.request(canvasChatPath), 403],
    [() => post(canvasChatPath, "{"), 400],
    [() => f.request("/api/v1/canvas/verification"), 403],
    [() => post("/api/v1/canvas/verification", "{"), 400],
  ];

  assert.equal((await f.login("teacher")).status, 200);
  assert.equal((await f.request(draftPath)).status, 404);
  assert.equal((await f.request("/health")).status, 200);
  for (const [send, status] of admitted) {
    const response = await send();
    assert.equal(response.status, status);
    await response.arrayBuffer();
  }
  // The sign-in and every admitted request count once against one budget.
  for (let i = admitted.length + 1; i < 600; i++) {
    const response = await getAuth();
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  for (const [send] of admitted) {
    const response = await send();
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { code: "RATE_LIMITED" });
  }
  assert.equal(draftCalls, 1);
  assert.equal(historyReads, 1);
  assert.deepEqual(syntheticCanvas.calls, []);
  assert.equal((await f.request(draftPath)).status, 404);
  assert.equal((await f.request("/health")).status, 200);
});

const pagesPath = "/api/v1/canvas/pages";
const feedbackPath = "/api/v1/canvas/feedback";
const authoredDraft = {
  title: "Studio — 地图 🌍",
  body: "<h2>地图</h2><p>Compare <strong>two</strong> routes &amp; explain&nbsp;🌍.</p>",
};
async function pageEntries(
  synthetic,
  route = pagesPath,
  launchConfig = canvas,
) {
  const clock = { now };
  const f = await fixture({
    autoLogin: false,
    canvas: () => launchConfig,
    authNow: () => clock.now,
    canvasPages: synthetic.options,
  });
  const response = await launch(f, {}, {}, launchConfig.sharedSecret);
  assert.equal(response.status, 303);
  const canvasCookie = cookie(response);
  const request = (phase, body, selected = canvasCookie, extra = {}, signal) =>
    f.request(route + (phase ? "/" + phase : ""), {
      ...(signal && { signal }),
      method: phase ? "POST" : "GET",
      headers: authenticated(selected, {
        ...(phase ? { "content-type": "application/json" } : {}),
        ...extra,
      }),
      ...(phase ? { body: JSON.stringify(body) } : {}),
    });
  const preview = async (draft = authoredDraft) => {
    const res = await request("preview", { draft });
    assert.equal(res.status, 200);
    return res.json();
  };
  const create = (plan, draft = plan.draft) =>
    request("create", { confirm: true, planId: plan.planId, draft });
  return { f, clock, request, preview, create, canvasCookie };
}

test("Canvas Pages needs the signed Teacher and a matching, current, exact single-use preview", async (t) => {
  const synthetic = canvasPageFixture();
  const { f, request, preview, create } = await pageEntries(synthetic);
  t.after(() => f.close());
  for (const role of ["admin", "teacher", "student"]) {
    assert.equal((await f.login(role)).status, 200);
    assert.equal((await request("", undefined, f.cookie())).status, 403);
    assert.equal(
      (await request("preview", { draft: authoredDraft }, f.cookie())).status,
      403,
    );
    assert.equal(
      (await request("create", { draft: authoredDraft }, f.cookie())).status,
      403,
    );
  }
  assert.equal((await request("", undefined, "")).status, 401);
  assert.equal(
    (
      await request("preview", { draft: authoredDraft }, undefined, {
        origin: canvas.canvasOrigin,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("", undefined, undefined, {
        authorization: "Bearer synthetic",
      })
    ).status,
    403,
  );
  assert.deepEqual(synthetic.calls, []);
  assert.deepEqual(await (await request("")).json(), { enabled: true });
  for (const draft of [
    { ...authoredDraft, body: "<h2> </h2><p><strong>\n\t</strong><br></p>" },
    { ...authoredDraft, body: '<p data-note="demo">Draft</p>' },
    {
      ...authoredDraft,
      body: "<h2>Invalid nesting<ul><li>List</li></ul></h2>",
    },
    { ...authoredDraft, body: "<p>Broken Unicode \ud800</p>" },
    { ...authoredDraft, body: "<p>方向\u202e示例</p>" },
    { ...authoredDraft, body: "<p>" + "界".repeat(6000) + "</p>" },
    { ...authoredDraft, title: "Misleading\u2066 display" },
    { ...authoredDraft, courseId: canvas.courseId },
  ])
    assert.equal((await request("preview", { draft })).status, 400);
  assert.equal(
    (
      await request("preview", {
        draft: { ...authoredDraft, title: synthetic.settings.canvasToken },
      })
    ).status,
    503,
  );
  assert.deepEqual(synthetic.calls, []);
  const plan = await preview();
  assert.deepEqual(plan.target, {
    origin: canvas.canvasOrigin,
    courseId: canvas.courseId,
    teacherId: canvas.userId,
    courseName: "Synthetic Studio",
  });
  assert.deepEqual(plan.draft, authoredDraft);
  assert.deepEqual(synthetic.calls, [
    ["GET", "/users/self"],
    ["GET", `/courses/${canvas.courseId}`],
  ]);
  assert.equal(
    (await request("create", { planId: plan.planId, draft: plan.draft }))
      .status,
    400,
  );
  assert.equal(
    (
      await request("create", {
        confirm: false,
        planId: plan.planId,
        draft: plan.draft,
      })
    ).status,
    400,
  );
  assert.equal(
    (await create(plan, { ...plan.draft, title: "Different title" })).status,
    409,
  );
  assert.equal(
    (
      await create(plan, {
        ...plan.draft,
        body: plan.draft.body.replace("two", "three"),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await create(plan, {
        ...plan.draft,
        body: plan.draft.body.replace("<h2>", "<H2>"),
      })
    ).status,
    400,
  );
  assert.deepEqual(synthetic.writes, []);
  const concurrent = await Promise.all([create(plan), create(plan)]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  assert.deepEqual(await concurrent.find((r) => r.ok).json(), {
    status: "VERIFIED",
    pageId: "9001",
  });
  assert.deepEqual(synthetic.writes, [
    {
      "wiki_page[title]": authoredDraft.title,
      "wiki_page[body]": authoredDraft.body,
      "wiki_page[published]": "false",
      "wiki_page[editing_roles]": "teachers",
      "wiki_page[notify_of_update]": "false",
    },
  ]);
  assert.deepEqual(synthetic.calls.slice(-4), [
    ["GET", "/users/self"],
    ["GET", `/courses/${canvas.courseId}`],
    ["POST", `/courses/${canvas.courseId}/pages`],
    ["GET", `/courses/${canvas.courseId}/pages/page_id:9001`],
  ]);
  assert.equal((await create(plan)).status, 409);
  assert.equal(synthetic.writes.length, 1);
  assert.doesNotMatch(
    JSON.stringify(f.logs),
    /Studio|routes|synthetic-rest-token/,
  );
});

test("Canvas Page writes fail closed on authority, target, preview or configuration drift", async (t) => {
  const synthetic = canvasPageFixture();
  const { f, clock, request, preview, create } = await pageEntries(synthetic);
  t.after(() => f.close());
  const original = { ...synthetic.settings };
  for (const change of [
    { origin: "https://other.example.test" },
    { teacherId: "73002" },
    { courseId: "42002" },
    { expiresAt: new Date(now).toISOString() },
    { canvasToken: "invalid token" },
  ]) {
    Object.assign(synthetic.settings, change);
    assert.equal((await request("")).status, 503);
    assert.equal(
      (await request("preview", { draft: authoredDraft })).status,
      503,
    );
    Object.assign(synthetic.settings, original);
  }
  assert.deepEqual(synthetic.calls, []);
  synthetic.remote.actorId = "73002";
  assert.equal(
    (await request("preview", { draft: authoredDraft })).status,
    503,
  );
  assert.deepEqual(synthetic.calls, [["GET", "/users/self"]]);
  synthetic.remote.actorId = canvas.userId;
  const course = synthetic.remote.course;
  for (const change of [
    { id: 42002 },
    { workflow_state: "unpublished" },
    {
      enrollments: [
        { type: "student", user_id: 73001, enrollment_state: "active" },
      ],
    },
    {
      enrollments: [
        { type: "teacher", user_id: 73002, enrollment_state: "active" },
      ],
    },
    {
      enrollments: [
        { type: "teacher", user_id: 73001, enrollment_state: "inactive" },
      ],
    },
    { name: original.canvasToken },
  ]) {
    synthetic.remote.course = { ...course, ...change };
    const unavailable = await request("preview", { draft: authoredDraft });
    assert.equal(unavailable.status, 503);
    assert.ok(!(await unavailable.text()).includes(original.canvasToken));
  }
  synthetic.remote.course = course;
  const otherSession = cookie(
    await launch(f, { oauth_nonce: "synthetic-second-session" }),
  );
  let plan = await preview();
  assert.equal(
    (
      await request(
        "create",
        { planId: plan.planId, draft: plan.draft, confirm: true },
        otherSession,
      )
    ).status,
    409,
  );
  synthetic.remote.course = { ...course, name: "Renamed Studio" };
  assert.equal((await create(plan)).status, 409);
  synthetic.remote.course = course;
  plan = await preview();
  clock.now = now + 300_001;
  assert.equal((await create(plan)).status, 409);
  plan = await preview();
  const replacement = await preview();
  assert.equal((await create(plan)).status, 409);
  synthetic.remote.before = (method, endpoint) => {
    if (method === "GET" && endpoint === `/courses/${canvas.courseId}`)
      synthetic.settings.canvasToken = "rotated-synthetic-rest-value";
  };
  assert.equal((await create(replacement)).status, 409);
  assert.deepEqual(synthetic.writes, []);
});

test("Canvas Page returns honest readback results and never retries a dispatched write", async (t) => {
  const synthetic = canvasPageFixture();
  const { f, preview, create } = await pageEntries(synthetic);
  t.after(() => f.close());
  for (const [label, change] of [
    ["published", (page) => ({ ...page, published: true })],
    ["wrong ID", (page) => ({ ...page, page_id: 9002 })],
    ["changed body", (page) => ({ ...page, body: "<p>Changed</p>" })],
    [
      "wider editing roles",
      (page) => ({ ...page, editing_roles: "teachers,students" }),
    ],
    [
      "unavailable readback",
      () => {
        throw new Error("Synthetic readback unavailable");
      },
    ],
  ]) {
    synthetic.remote.readBack = change;
    const plan = await preview();
    const result = await create(plan);
    assert.deepEqual(
      await result.json(),
      { status: "UNVERIFIED", pageId: "9001" },
      label,
    );
    assert.equal((await create(plan)).status, 409);
  }
  synthetic.remote.afterCreate = () => {
    throw new Error("Synthetic connection ended before response");
  };
  const lost = await preview();
  assert.deepEqual(await (await create(lost)).json(), { status: "UNCERTAIN" });
  assert.equal((await create(lost)).status, 409);
  assert.equal(synthetic.writes.length, 6);
  synthetic.remote.afterCreate = () => {
    synthetic.settings.canvasToken = "rotated-fixture-token-after-dispatch";
  };
  const changed = await preview();
  const callsBeforeConfirm = synthetic.calls.length;
  assert.deepEqual(await (await create(changed)).json(), {
    status: "UNCERTAIN",
  });
  assert.equal((await create(changed)).status, 409);
  assert.deepEqual(
    synthetic.calls.slice(callsBeforeConfirm).map(([method]) => method),
    ["GET", "GET", "POST"],
  );
  assert.equal(synthetic.writes.length, 7);
});

const assignmentsPath = "/api/v1/canvas/assignments";
const modulesPath = "/api/v1/canvas/modules";
const canvasChatPath = "/api/v1/canvas/chat";
const createAssignment = {
  kind: "CREATE",
  title: "Map lab 地图",
  body: "<p>Compare <strong>two</strong> synthetic maps.</p>",
  pointsPossible: 4.5,
  submissionTypes: ["online_text_entry", "online_upload"],
  dueAt: "2026-12-21T10:30:00.000Z",
};
const renameAssignment = {
  kind: "TITLE",
  assignmentId: "81",
  title: "Updated lab",
};
async function assignmentEntries(synthetic, path = assignmentsPath) {
  const entries = await pageEntries(synthetic, path);
  const save = (plan, draft = plan.draft, signal) =>
    entries.request(
      "save",
      { confirm: true, planId: plan.planId, draft },
      undefined,
      {},
      signal,
    );
  return { ...entries, save };
}

test("Canvas Assignment authoring is opt-in, strictly scoped, and sends one exact confirmed create or title change", async (t) => {
  const unconfigured = canvasPageFixture();
  const inactive = await assignmentEntries(unconfigured);
  t.after(() => inactive.f.close());
  assert.equal((await inactive.request("")).status, 503);
  assert.equal(
    (await inactive.request("preview", { draft: createAssignment })).status,
    503,
  );
  assert.deepEqual(unconfigured.calls, []);

  const synthetic = canvasPageFixture({ assignments: true });
  const { f, request, preview, save } = await assignmentEntries(synthetic);
  t.after(() => f.close());
  for (const role of ["admin", "teacher", "student"]) {
    assert.equal((await f.login(role)).status, 200);
    assert.equal(
      (await request("preview", { draft: createAssignment }, f.cookie()))
        .status,
      403,
    );
  }
  assert.deepEqual(synthetic.calls, []);
  assert.deepEqual(await (await request("")).json(), {
    groupId: "72",
    editableIds: ["81", "82"],
  });

  for (const draft of [
    { ...createAssignment, published: true },
    { ...createAssignment, groupId: "73" },
    { ...createAssignment, submissionTypes: ["external_tool"] },
    { ...createAssignment, dueAt: "2026-02-30T10:30:00.000Z" },
    { ...createAssignment, body: '<p data-note="demo">Draft</p>' },
    { ...renameAssignment, pointsPossible: 100 },
  ])
    assert.equal((await request("preview", { draft })).status, 400);
  assert.equal(
    (
      await request("preview", {
        draft: { ...renameAssignment, assignmentId: "85" },
      })
    ).status,
    403,
  );
  assert.deepEqual(synthetic.calls, []);

  const creation = await preview(createAssignment);
  assert.deepEqual(creation.subject, {
    kind: "CREATE",
    id: "72",
    name: "Studio Exercises",
  });
  assert.deepEqual(creation.draft, createAssignment);
  assert.equal(creation.target.courseId, canvas.courseId);
  assert.equal(creation.target.teacherId, canvas.userId);
  assert.deepEqual(synthetic.calls, [
    ["GET", "/users/self"],
    ["GET", `/courses/${canvas.courseId}`],
    ["GET", `/courses/${canvas.courseId}/assignment_groups/72`],
  ]);
  assert.equal(
    (await request("save", { planId: creation.planId, draft: creation.draft }))
      .status,
    400,
  );
  assert.equal(
    (await save(creation, { ...creation.draft, pointsPossible: 5 })).status,
    409,
  );
  assert.deepEqual(synthetic.assignmentWrites, []);
  const concurrent = await Promise.all([save(creation), save(creation)]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  assert.deepEqual(await concurrent.find((r) => r.ok).json(), {
    status: "VERIFIED",
    assignmentId: "91",
  });
  assert.deepEqual(synthetic.assignmentWrites[0], {
    method: "POST",
    endpoint: `/courses/${canvas.courseId}/assignments`,
    fields: [
      ["assignment[name]", createAssignment.title],
      ["assignment[notify_of_update]", "false"],
      ["assignment[description]", createAssignment.body],
      ["assignment[points_possible]", "4.5"],
      ["assignment[assignment_group_id]", "72"],
      ["assignment[published]", "false"],
      ["assignment[due_at]", createAssignment.dueAt],
      ["assignment[submission_types][]", "online_text_entry"],
      ["assignment[submission_types][]", "online_upload"],
    ],
  });
  assert.deepEqual(synthetic.calls.at(-1), [
    "GET",
    `/courses/${canvas.courseId}/assignments/91`,
  ]);

  const original = { ...synthetic.assignmentRows.get("81") };
  const rename = await preview(renameAssignment);
  assert.deepEqual(rename.subject, {
    kind: "TITLE",
    id: "81",
    name: original.name,
    published: true,
    updatedAt: original.updated_at,
  });
  assert.equal(
    (await save(rename, { ...rename.draft, assignmentId: "82" })).status,
    409,
  );
  assert.equal(
    (await save(rename, { ...rename.draft, title: "Different title" })).status,
    409,
  );
  assert.deepEqual(await (await save(rename)).json(), {
    status: "VERIFIED",
    assignmentId: "81",
  });
  assert.deepEqual(synthetic.assignmentWrites[1], {
    method: "PUT",
    endpoint: `/courses/${canvas.courseId}/assignments/81`,
    fields: [
      ["assignment[name]", renameAssignment.title],
      ["assignment[notify_of_update]", "false"],
    ],
  });
  assert.deepEqual(synthetic.assignmentRows.get("81"), {
    ...original,
    name: renameAssignment.title,
    updated_at: "2026-11-20T12:00:01Z",
  });
  assert.equal((await save(await preview(renameAssignment))).status, 409);
  assert.equal(synthetic.assignmentWrites.length, 2);
  assert.doesNotMatch(
    JSON.stringify(f.logs),
    /Map lab|Original instructions|Updated lab|synthetic-rest-token/,
  );
});

test("Canvas Assignment rejects changed targets, expired previews and cancelled confirmation before dispatch", async (t) => {
  const synthetic = canvasPageFixture({ assignments: true });
  const { f, clock, request, preview, save, canvasCookie } =
    await assignmentEntries(synthetic);
  t.after(() => f.close());

  const superseded = await preview(createAssignment);
  const pagePreview = await f.request(pagesPath + "/preview", {
    method: "POST",
    headers: authenticated(canvasCookie, {
      "content-type": "application/json",
    }),
    body: JSON.stringify({ draft: authoredDraft }),
  });
  assert.equal(pagePreview.status, 200);
  assert.equal((await save(superseded)).status, 409);
  const removed = await preview(renameAssignment);
  synthetic.settings.assignments.editableIds = [];
  assert.equal((await save(removed)).status, 403);
  synthetic.settings.assignments.editableIds = ["81", "82"];

  const revokedDuringRead = await preview(renameAssignment);
  synthetic.remote.before = (method, endpoint) => {
    if (method === "GET" && endpoint.endsWith("/assignments/81")) {
      synthetic.settings.assignments.editableIds = ["82"];
    }
  };
  assert.equal((await save(revokedDuringRead)).status, 409);
  assert.deepEqual(synthetic.assignmentWrites, []);
  synthetic.remote.before = undefined;
  synthetic.settings.assignments.editableIds = ["81", "82"];

  const movedDuringRead = await preview(createAssignment);
  synthetic.remote.before = (method, endpoint) => {
    if (method === "GET" && endpoint.endsWith("/assignment_groups/72")) {
      synthetic.settings.assignments.groupId = "73";
    }
  };
  assert.equal((await save(movedDuringRead)).status, 409);
  assert.deepEqual(synthetic.assignmentWrites, []);
  synthetic.remote.before = undefined;
  synthetic.settings.assignments.groupId = "72";

  const create = await preview(createAssignment);
  synthetic.remote.group = { ...synthetic.remote.group, name: "Renamed Group" };
  assert.equal((await save(create)).status, 409);
  const rename = await preview(renameAssignment);
  synthetic.assignmentRows.get("81").updated_at = "2026-11-20T12:00:00.123456Z";
  assert.equal((await save(rename)).status, 409);
  const wrongCourse = await preview(renameAssignment);
  synthetic.assignmentRows.get("81").course_id = 42002;
  assert.equal((await save(wrongCourse)).status, 409);
  synthetic.assignmentRows.get("81").course_id = Number(canvas.courseId);

  const res = await launch(f, {
    oauth_nonce: "synthetic-second-assignment-session",
  });
  const other = cookie(res);
  const expired = await preview(createAssignment);
  assert.equal(
    (
      await request(
        "save",
        { confirm: true, planId: expired.planId, draft: expired.draft },
        other,
      )
    ).status,
    409,
  );
  clock.now = now + 300_001;
  assert.equal((await save(expired)).status, 409);

  const cancelled = await preview(renameAssignment);
  const entered = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  synthetic.remote.before = async (method, endpoint, signal) => {
    if (method !== "GET" || !endpoint.endsWith("/assignments/81")) return;
    entered.resolve();
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
    disconnected.resolve();
  };
  const controller = new AbortController();
  const response = save(cancelled, cancelled.draft, controller.signal);
  await entered.promise;
  controller.abort();
  await assert.rejects(response, { name: "AbortError" });
  await disconnected.promise;
  assert.deepEqual(synthetic.assignmentWrites, []);
});

test("Canvas Assignment previews keep credentials out of returned group and assignment names", async (t) => {
  const synthetic = canvasPageFixture({ assignments: true });
  const { f, request } = await assignmentEntries(synthetic);
  t.after(() => f.close());
  for (const secret of [
    synthetic.settings.canvasToken,
    canvas.consumerKey,
    canvas.sharedSecret,
  ]) {
    synthetic.remote.group.name = `Group echo ${secret}`;
    synthetic.assignmentRows.get("81").name = `Assignment echo ${secret}`;
    for (const draft of [createAssignment, renameAssignment]) {
      const response = await request("preview", { draft });
      assert.equal(response.status, 503);
      assert.doesNotMatch(await response.text(), /echo/);
    }
  }
  assert.deepEqual(synthetic.assignmentWrites, []);
});

test("Canvas Assignment reports mismatched readback and ambiguous writes without replay", async (t) => {
  const synthetic = canvasPageFixture({ assignments: true });
  const { f, preview, save } = await assignmentEntries(synthetic);
  t.after(() => f.close());
  for (const change of [
    (row) => ({ ...row, assignment_group_id: 73 }),
    (row) => ({ ...row, published: true }),
    (row) => ({ ...row, description: "<p>Different instructions.</p>" }),
    (row) => ({ ...row, due_at: null }),
  ]) {
    synthetic.remote.assignmentRead = change;
    const plan = await preview(createAssignment);
    assert.deepEqual(await (await save(plan)).json(), {
      status: "UNVERIFIED",
      assignmentId: "91",
    });
    assert.equal((await save(plan)).status, 409);
  }

  synthetic.remote.assignmentRead = (row) => row;
  synthetic.remote.afterAssignmentWrite = () => {
    throw new Error("Synthetic write response lost");
  };
  const edit = await preview(renameAssignment);
  assert.deepEqual(await (await save(edit)).json(), { status: "UNCERTAIN" });
  assert.equal((await save(edit)).status, 409);
  assert.equal(synthetic.assignmentWrites.length, 5);
  assert.deepEqual(synthetic.calls.at(-1), [
    "PUT",
    `/courses/${canvas.courseId}/assignments/81`,
  ]);
});

const createModule = { kind: "CREATE_MODULE", title: "Studio 地图 🌍" };
const linkPage = { kind: "LINK_PAGE", moduleId: "61", contentId: "9002" };
const linkAssignment = {
  kind: "LINK_ASSIGNMENT",
  moduleId: "61",
  contentId: "81",
};

const inventoryPath = "/api/v1/canvas/inventory";

test("Canvas inventory reads only approved metadata for the current signed Teacher", async (t) => {
  const synthetic = canvasPageFixture({ assignments: true, modules: true });
  const { f, canvasCookie } = await pageEntries(synthetic, inventoryPath);
  t.after(() => f.close());
  const get = (suffix = "", selected = canvasCookie) =>
    f.request(inventoryPath + suffix, { headers: authenticated(selected) });
  const first = synthetic.assignmentRows.get("81");
  first.name = "Studio 10";
  synthetic.assignmentRows.set("82", {
    ...first,
    id: 82,
    name: "Studio 2",
    published: false,
  });

  assert.equal((await get("/pages", "")).status, 401);
  for (const role of ["admin", "teacher", "student"]) {
    assert.equal((await f.login(role)).status, 200);
    assert.equal((await get("/pages", f.cookie())).status, 403);
  }
  const options = await get();
  assert.equal(options.headers.get("cache-control"), "no-store");
  assert.deepEqual(await options.json(), {
    kinds: ["pages", "editable-assignments", "module-assignments", "modules"],
  });
  assert.equal((await get("/unknown")).status, 400);
  for (const query of ["/pages?id=9001", "/pages?courseId=123"])
    assert.equal((await get(query)).status, 403);
  assert.deepEqual(synthetic.calls, []);

  const course = `/courses/${canvas.courseId}`;
  for (const [kind, entries, paths] of [
    [
      "editable-assignments",
      [
        { id: "82", title: "Studio 2", published: false },
        { id: "81", title: "Studio 10", published: true },
      ],
      ["/assignments/81", "/assignments/82"],
    ],
    [
      "pages",
      [{ id: "9002", title: "Maps and examples", published: true }],
      ["/pages/page_id:9002"],
    ],
    [
      "module-assignments",
      [{ id: "81", title: "Studio 10", published: true }],
      ["/assignments/81"],
    ],
    [
      "modules",
      [{ id: "61", title: "Studio module", published: false }],
      ["/modules/61"],
    ],
  ]) {
    const response = await get(`/${kind}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await response.json();
    assert.equal(result.target.courseId, canvas.courseId);
    assert.deepEqual(result.entries, entries);
    assert.deepEqual(synthetic.calls.splice(0), [
      ["GET", "/users/self"],
      ["GET", course],
      ...paths.map((suffix) => ["GET", course + suffix]),
    ]);
  }

  synthetic.linkedPage.title = "Revised Maps";
  assert.equal(
    (await (await get("/pages")).json()).entries[0].title,
    "Revised Maps",
  );
  synthetic.calls.length = 0;
  synthetic.settings.modules.pageIds = [];
  assert.equal((await get("/pages")).status, 403);
  assert.deepEqual(synthetic.calls, []);
});

test("Canvas inventory withholds results after scope drift, invalid metadata, or an echoed secret", async (t) => {
  const synthetic = canvasPageFixture({ assignments: true });
  const launchConfig = {
    ...canvas,
    sharedSecret: `${canvas.sharedSecret}"\\sample`,
  };
  const { f, canvasCookie } = await pageEntries(
    synthetic,
    inventoryPath,
    launchConfig,
  );
  t.after(() => f.close());
  const get = () =>
    f.request(inventoryPath + "/editable-assignments", {
      headers: authenticated(canvasCookie),
    });
  const course = `/courses/${canvas.courseId}`;
  synthetic.remote.before = (_method, endpoint) => {
    if (endpoint === course + "/assignments/81")
      synthetic.settings.assignments.editableIds = ["82"];
  };
  const drifted = await get();
  assert.equal(drifted.status, 503);
  assert.deepEqual(await drifted.json(), { code: "SERVICE_UNAVAILABLE" });
  assert.deepEqual(synthetic.calls.splice(0), [
    ["GET", "/users/self"],
    ["GET", course],
    ["GET", course + "/assignments/81"],
  ]);

  synthetic.remote.before = undefined;
  synthetic.settings.assignments.editableIds = ["81"];
  const row = synthetic.assignmentRows.get("81");
  const courseId = row.course_id;
  row.course_id = 123;
  assert.equal((await get()).status, 503);
  row.course_id = courseId;
  row.name = launchConfig.sharedSecret;
  const echoed = await get();
  assert.equal(echoed.status, 503);
  assert.deepEqual(await echoed.json(), { code: "SERVICE_UNAVAILABLE" });
});

test("Canvas Modules is opt-in and sends one exact reviewed change per confirmation", async (t) => {
  const original = canvasPageFixture();
  const inactive = await assignmentEntries(original, modulesPath);
  t.after(() => inactive.f.close());
  assert.equal((await inactive.request("")).status, 503);
  assert.equal(
    (await inactive.request("preview", { draft: createModule })).status,
    503,
  );
  assert.deepEqual(original.calls, []);

  const synthetic = canvasPageFixture({ modules: true });
  const { f, request, preview, save } = await assignmentEntries(
    synthetic,
    modulesPath,
  );
  t.after(() => f.close());
  assert.deepEqual(
    await (await request("")).json(),
    synthetic.settings.modules,
  );
  for (const role of ["admin", "teacher", "student"]) {
    assert.equal((await f.login(role)).status, 200);
    assert.equal(
      (await request("preview", { draft: createModule }, f.cookie())).status,
      403,
    );
  }
  for (const draft of [
    { ...createModule, published: true },
    { ...linkPage, pageUrl: "example" },
    { ...createModule, title: "Invalid\u202e" },
  ]) {
    assert.equal((await request("preview", { draft })).status, 400);
  }
  for (const draft of [
    { ...linkPage, moduleId: "62" },
    { ...linkPage, contentId: "9001" },
    { ...linkAssignment, contentId: "82" },
  ]) {
    assert.equal((await request("preview", { draft })).status, 403);
  }
  assert.deepEqual(synthetic.calls, []);

  const course = "/courses/" + canvas.courseId;
  const create = await preview(createModule);
  assert.equal(create.moduleSubject, undefined);
  assert.deepEqual(create.draft, createModule);
  assert.deepEqual(synthetic.calls, [
    ["GET", "/users/self"],
    ["GET", course],
  ]);
  assert.equal(
    (await save(create, { ...createModule, title: "Changed" })).status,
    409,
  );
  assert.deepEqual(await (await save(create)).json(), {
    status: "VERIFIED",
    resourceId: "62",
  });
  assert.deepEqual(synthetic.moduleWrites[0], {
    endpoint: course + "/modules",
    fields: { "module[name]": createModule.title },
  });
  assert.equal(synthetic.moduleRows.get("62").published, false);
  assert.equal((await save(create)).status, 409);

  const page = await preview(linkPage);
  assert.deepEqual(page.moduleSubject, {
    moduleId: "61",
    moduleName: "Studio module",
    resourceName: "Maps and examples",
    resourcePublished: true,
  });
  assert.equal(synthetic.moduleWrites.length, 1);
  assert.deepEqual(await (await save(page)).json(), {
    status: "VERIFIED",
    resourceId: "101",
  });
  assert.equal((await request("preview", { draft: linkPage })).status, 503);
  const assignment = await preview(linkAssignment);
  assert.equal(assignment.moduleSubject.resourceName, "Synthetic draft");
  assert.equal(synthetic.moduleWrites.length, 2);
  assert.deepEqual(await (await save(assignment)).json(), {
    status: "VERIFIED",
    resourceId: "102",
  });
  assert.deepEqual(synthetic.moduleWrites.slice(1), [
    {
      endpoint: course + "/modules/61/items",
      fields: {
        "module_item[type]": "Page",
        "module_item[page_url]": "maps-and-examples",
      },
    },
    {
      endpoint: course + "/modules/61/items",
      fields: {
        "module_item[type]": "Assignment",
        "module_item[content_id]": "81",
      },
    },
  ]);
});

test("Canvas Modules rejects incomplete or changed module, resource and authority before dispatch", async (t) => {
  const synthetic = canvasPageFixture({ modules: true });
  const { f, clock, canvasCookie, request, preview, save } =
    await assignmentEntries(synthetic, modulesPath);
  t.after(() => f.close());
  const module = synthetic.moduleRows.get("61");
  const assignment = synthetic.assignmentRows.get("81");
  const rejected = async (draft) => {
    const response = await request("preview", { draft });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: "SERVICE_UNAVAILABLE" });
  };
  for (const modify of [
    (row) => ({ ...row, published: true }),
    (row) => ({ ...row, course_id: 42002 }),
    (row) => ({ ...row, items: undefined }),
    (row) => ({ ...row, items_count: 1 }),
  ]) {
    synthetic.remote.moduleRead = modify;
    await rejected(linkPage);
  }
  synthetic.remote.moduleRead = (row) => row;
  for (const change of [
    { is_quiz_assignment: true },
    { submission_types: ["external_tool"] },
    { course_id: 42002 },
  ]) {
    const original = { ...assignment };
    Object.assign(assignment, change);
    await rejected(linkAssignment);
    Object.assign(assignment, original);
  }
  synthetic.linkedPage.title = canvas.sharedSecret;
  await rejected(linkPage);
  synthetic.linkedPage.title = "Maps and examples";
  synthetic.linkedPage.url = canvas.consumerKey;
  await rejected(linkPage);
  synthetic.linkedPage.url = "maps-and-examples";

  let plan = await preview(linkPage);
  module.items.push({
    id: 100,
    module_id: 61,
    position: 1,
    type: "SubHeader",
    published: false,
  });
  assert.equal((await save(plan)).status, 409);
  plan = await preview(linkPage);
  synthetic.linkedPage.url = "revised-maps-and-examples";
  assert.equal((await save(plan)).status, 409);
  plan = await preview(linkPage);
  synthetic.remote.before = (method, endpoint) => {
    if (method === "GET" && endpoint.endsWith("/pages/page_id:9002"))
      synthetic.settings.modules.pageIds = [];
  };
  assert.equal((await save(plan)).status, 409);
  synthetic.remote.before = undefined;
  synthetic.settings.modules.pageIds = ["9002"];
  assert.deepEqual(synthetic.moduleWrites, []);

  plan = await preview(linkPage);
  const otherPreview = await f.request(pagesPath + "/preview", {
    method: "POST",
    headers: authenticated(canvasCookie, {
      "content-type": "application/json",
    }),
    body: JSON.stringify({ draft: authoredDraft }),
  });
  assert.equal(otherPreview.status, 200);
  assert.equal((await save(plan)).status, 409);
  plan = await preview(linkPage);
  clock.now += 300_001;
  assert.equal((await save(plan)).status, 409);

  plan = await preview(linkPage);
  const entered = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  synthetic.remote.before = async (method, endpoint, signal) => {
    if (method !== "GET" || !endpoint.endsWith("/pages/page_id:9002")) return;
    entered.resolve();
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
    disconnected.resolve();
  };
  const controller = new AbortController();
  const response = save(plan, plan.draft, controller.signal);
  await entered.promise;
  controller.abort();
  await assert.rejects(response, { name: "AbortError" });
  await disconnected.promise;
  assert.deepEqual(synthetic.moduleWrites, []);
});

test("Canvas Modules reports readback mismatch and uncertain writes without replay", async (t) => {
  const synthetic = canvasPageFixture({ modules: true });
  const { f, preview, save } = await assignmentEntries(synthetic, modulesPath);
  t.after(() => f.close());
  const plan = await preview(linkPage);
  synthetic.remote.afterModuleWrite = (item) => {
    item.page_url = "different-example";
  };
  assert.deepEqual(await (await save(plan)).json(), {
    status: "UNVERIFIED",
    resourceId: "101",
  });
  assert.equal((await save(plan)).status, 409);
  assert.equal(synthetic.moduleWrites.length, 1);

  const create = await preview(createModule);
  synthetic.remote.afterModuleWrite = () => {
    throw new Error("Synthetic connection loss after commit");
  };
  assert.deepEqual(await (await save(create)).json(), { status: "UNCERTAIN" });
  assert.equal((await save(create)).status, 409);
  assert.equal(synthetic.moduleWrites.length, 2);
});

const countCanvas = "How many submissions for Synthetic draft?";
const scoreCanvas = "What is the score for Synthetic draft?";

async function canvasChatEntries(synthetic, native = false) {
  const path = native ? canvasChatPath + "/tools" : canvasChatPath;
  const entries = await pageEntries(synthetic, path);
  const ask = (
    question,
    { selected = entries.canvasCookie, signal, extra = {} } = {},
  ) =>
    entries.f.request(path, {
      method: "POST",
      headers: authenticated(selected, { "content-type": "application/json" }),
      body: JSON.stringify({ question, ...extra }),
      ...(signal && { signal }),
    });
  const answer = async (question) => {
    const res = await ask(question);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    return (await res.json()).text;
  };
  return { ...entries, ask, answer };
}

test("Canvas native Chat checks the named assignment and current scope before any REST read", async (t) => {
  const synthetic = canvasPageFixture({ chat: true });
  const question = "For SYNTHETIC   DRAFT, what score was recorded?";
  const call = (
    assignment = "Synthetic draft",
    name = "canvas_assignment_score",
  ) => ({
    name,
    arguments: { assignment },
  });
  let propose = async () => call();
  const questions = [];
  synthetic.options.selectChatTool = (text, signal) => {
    questions.push(text);
    return propose(text, signal);
  };
  const { f, ask, answer, request } = await canvasChatEntries(synthetic, true);
  t.after(() => f.close());
  assert.deepEqual(await (await request("")).json(), { enabled: true });
  assert.equal((await f.login("student")).status, 200);
  assert.equal((await ask(question, { selected: f.cookie() })).status, 403);
  assert.equal(
    (await ask(`Can you use ${synthetic.settings.canvasToken} here?`)).status,
    400,
  );
  assert.deepEqual(questions, []);

  for (const [input, selection] of [
    ["What was the score for Lab 1.1?", call("Lab 1")],
    ["What was recorded for Synthetic drafts?", call()],
    [question, call("Unmentioned assignment")],
    [question, call("Synthetic draft", "canvas_change_score")],
    [
      question,
      {
        ...call(),
        arguments: { assignment: "Synthetic draft", userId: "73010" },
      },
    ],
    [question, null],
  ]) {
    propose = async () => selection;
    assert.match(await answer(input), /one approved assignment/);
  }
  propose = async () => undefined;
  assert.match(
    await answer(question),
    /unavailable on the selected Local model/,
  );
  assert.deepEqual(synthetic.calls, []);

  const entered = Promise.withResolvers();
  const held = Promise.withResolvers();
  propose = () => {
    entered.resolve();
    return held.promise;
  };
  const pending = ask(question);
  await entered.promise;
  synthetic.settings.chat.assignmentIds = ["82"];
  held.resolve(call());
  const changed = await pending;
  assert.equal(changed.status, 503);
  assert.deepEqual(await changed.json(), { code: "CANVAS_CHAT_UNAVAILABLE" });
  assert.deepEqual(synthetic.calls, []);

  synthetic.settings.chat.assignmentIds = ["81"];
  propose = async () => call();
  assert.match(
    await answer(question),
    /^Score for Synthetic draft is 6\.5 of 7 points/,
  );
  propose = async () => call("Synthetic draft", "canvas_submission_count");
  assert.match(
    await answer("Tell me the submission tally for Synthetic draft."),
    /^1 submission/,
  );
  assert.ok(synthetic.calls.every(([method]) => method === "GET"));
});

test("Canvas Chat is opt-in and returns only one approved assignment's Test Student observation", async (t) => {
  const disabled = canvasPageFixture();
  const inactive = await canvasChatEntries(disabled);
  t.after(() => inactive.f.close());
  assert.equal((await inactive.request("")).status, 503);
  assert.equal((await inactive.ask(countCanvas)).status, 503);
  assert.deepEqual(disabled.calls, []);

  const synthetic = canvasPageFixture({ chat: true });
  const { f, ask, answer, request } = await canvasChatEntries(synthetic);
  t.after(() => f.close());
  assert.deepEqual(await (await request("")).json(), { enabled: true });
  for (const role of ["admin", "teacher", "student"]) {
    assert.equal((await f.login(role)).status, 200);
    assert.equal(
      (await ask(countCanvas, { selected: f.cookie() })).status,
      403,
    );
  }
  assert.equal(
    (await ask(countCanvas, { extra: { userId: "73010" } })).status,
    400,
  );
  assert.equal((await ask("x".repeat(281))).status, 400);
  assert.match(
    await answer("Give me the whole class’s grades."),
    /one approved assignment/,
  );
  assert.deepEqual(synthetic.calls, []);

  const course = "/courses/" + canvas.courseId;
  assert.match(
    await answer(countCanvas),
    /^1 submission for Synthetic draft.*configured Test Student/,
  );
  assert.deepEqual(synthetic.calls, [
    ["GET", "/users/self"],
    ["GET", course],
    ["GET", course + "/assignments/81"],
    ["GET", course + "/users"],
    ["GET", course + "/assignments/81/submissions/73009"],
  ]);
  const score = await answer(scoreCanvas);
  assert.match(
    score,
    /^Score for Synthetic draft is 6\.5 of 7 points.*configured Test Student/,
  );
  assert.doesNotMatch(
    score,
    /73009|Synthetic submission body|Synthetic Test Student/,
  );
  assert.equal(
    synthetic.calls.filter(([method]) => method !== "GET").length,
    0,
  );

  synthetic.remote.submission.score = 0;
  assert.match(await answer(scoreCanvas), /is 0 of 7 points/);
  synthetic.remote.submission.grade_matches_current_submission = false;
  assert.match(await answer(scoreCanvas), /^Score unavailable/);
  Object.assign(synthetic.remote.submission, {
    workflow_state: "submitted",
    score: null,
  });
  assert.match(await answer(scoreCanvas), /is ungraded/);
  synthetic.remote.submission.excused = true;
  assert.match(await answer(countCanvas), /Test Student is excused/);
  Object.assign(synthetic.remote.submission, {
    excused: false,
    attempt: null,
    submitted_at: null,
    submission_type: null,
    workflow_state: "unsubmitted",
  });
  assert.match(await answer(countCanvas), /^0 submissions/);
  synthetic.remote.submission.missing = true;
  assert.match(
    await answer(countCanvas),
    /^0 submissions.*marks this assignment missing/,
  );
});

test("Canvas Chat rejects unknown or ambiguous titles, other accounts, and unsupported assignment or submission evidence", async (t) => {
  const synthetic = canvasPageFixture({ chat: true });
  const { f, ask, answer } = await canvasChatEntries(synthetic);
  t.after(() => f.close());
  const touchedSubmission = () =>
    synthetic.calls.some(([, endpoint]) => endpoint.includes("/submissions/"));
  const unavailable = async () => {
    const response = await ask(scoreCanvas);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      code: "CANVAS_CHAT_UNAVAILABLE",
    });
  };

  assert.match(
    await answer("How many submissions for Draft?"),
    /identify one approved assignment/,
  );
  const first = synthetic.assignmentRows.get("81");
  synthetic.assignmentRows.set("82", {
    ...first,
    id: 82,
    name: "SYNTHETIC DRAFT",
  });
  synthetic.settings.chat.assignmentIds.push("82");
  assert.match(await answer(countCanvas), /identify one approved assignment/);
  synthetic.settings.chat.assignmentIds = ["81"];

  for (const fields of [
    { published: false },
    { group_category_id: 90 },
    { is_quiz_assignment: true },
    { submission_types: ["external_tool"] },
    { course_id: 42002 },
  ]) {
    synthetic.remote.assignmentRead = (row) => ({ ...row, ...fields });
    await unavailable();
  }
  synthetic.remote.assignmentRead = (row) => row;
  for (const studentView of [
    [],
    [{ id: 73010 }],
    [{ id: 73009 }, { id: 73010 }],
  ]) {
    synthetic.remote.studentView = studentView;
    await unavailable();
  }
  synthetic.remote.studentView = [{ id: 73009 }];
  assert.equal(touchedSubmission(), false);
  synthetic.remote.actorId = "73010";
  await unavailable();
  synthetic.remote.actorId = canvas.userId;
  assert.equal(touchedSubmission(), false);

  const original = { ...synthetic.remote.submission };
  for (const fields of [
    { assignment_id: 82 },
    { user_id: 73010 },
    { assignment_visible: false },
    { group: { id: 10 } },
    { submitted_at: null },
  ]) {
    synthetic.remote.submission = { ...original, ...fields };
    await unavailable();
  }
});

test("Canvas Chat withholds an in-flight result after scope drift or a cancelled request", async (t) => {
  const synthetic = canvasPageFixture({ chat: true });
  const { f, ask, answer } = await canvasChatEntries(synthetic);
  t.after(() => f.close());
  synthetic.remote.before = (method, endpoint) => {
    if (method === "GET" && endpoint.includes("/submissions/"))
      synthetic.settings.chat.assignmentIds = ["82"];
  };
  const changed = await ask(scoreCanvas);
  assert.equal(changed.status, 503);
  assert.deepEqual(await changed.json(), { code: "CANVAS_CHAT_UNAVAILABLE" });
  synthetic.settings.chat.assignmentIds = ["81"];

  const entered = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  synthetic.remote.before = async (method, endpoint, signal) => {
    if (method !== "GET" || !endpoint.includes("/submissions/")) return;
    entered.resolve();
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
    disconnected.resolve();
  };
  const controller = new AbortController();
  const waiting = ask(scoreCanvas, { signal: controller.signal });
  await entered.promise;
  const before = synthetic.calls.length;
  const busy = await ask(countCanvas);
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), { code: "BUSY" });
  assert.equal(synthetic.calls.length, before);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  await disconnected.promise;
  synthetic.remote.before = undefined;
  assert.match(await answer(countCanvas), /^1 submission/);
  assert.equal(
    synthetic.calls.filter(([method]) => method !== "GET").length,
    0,
  );
});

const commentDraft = {
  kind: "FEEDBACK",
  assignmentId: "81",
  text: "Compare <two routes> & explain why. 地图 🌍\nDescribe your evidence.",
};
const encodedFeedback =
  "Compare &lt;two routes&gt; &amp; explain why. 地图 🌍\nDescribe your evidence.";
async function feedbackEntries(synthetic) {
  const entries = await pageEntries(synthetic, feedbackPath);
  const preview = () => entries.preview(commentDraft);
  const post = (plan, draft = plan.draft, signal) =>
    entries.request(
      "post",
      { confirm: true, planId: plan.planId, draft },
      undefined,
      {},
      signal,
    );
  return { ...entries, preview, post };
}

test("Canvas feedback is opt-in and posts one exact reviewed comment to the signed Teacher's Test Student", async (t) => {
  const disabled = canvasPageFixture({ chat: true });
  const inactive = await feedbackEntries(disabled);
  t.after(() => inactive.f.close());
  assert.equal((await inactive.request("")).status, 503);
  assert.equal(
    (await inactive.request("preview", { draft: commentDraft })).status,
    503,
  );
  assert.deepEqual(disabled.calls, []);

  const synthetic = canvasPageFixture({ chat: true, feedback: true });
  const { f, request, preview, post } = await feedbackEntries(synthetic);
  t.after(() => f.close());
  assert.equal((await request("", undefined, "")).status, 401);
  for (const role of ["admin", "teacher", "student"]) {
    assert.equal((await f.login(role)).status, 200);
    assert.equal((await request("", undefined, f.cookie())).status, 403);
    assert.equal(
      (await request("preview", { draft: commentDraft }, f.cookie())).status,
      403,
    );
    assert.equal(
      (await request("post", { draft: commentDraft }, f.cookie())).status,
      403,
    );
  }
  const status = await request("");
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.deepEqual(await status.json(), synthetic.settings.feedback);
  synthetic.settings.feedback.testStudentId = "73010";
  assert.equal((await request("")).status, 503);
  synthetic.settings.feedback.testStudentId = "73009";

  for (const draft of [
    { ...commentDraft, text: "   " },
    { ...commentDraft, text: "界".repeat(342) },
    { ...commentDraft, text: "broken surrogate \ud800" },
    { ...commentDraft, text: "directional control \u202e" },
    { ...commentDraft, text: "carriage\rreturn" },
    { ...commentDraft, postedGrade: 4 },
    { ...commentDraft, testStudentId: "73010" },
  ])
    assert.equal((await request("preview", { draft })).status, 400);
  for (const text of [
    canvas.sharedSecret,
    canvas.consumerKey,
    synthetic.settings.canvasToken,
  ])
    assert.equal(
      (await request("preview", { draft: { ...commentDraft, text } })).status,
      503,
    );
  assert.equal(
    (
      await request("preview", {
        draft: { ...commentDraft, assignmentId: "82" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("post", {
        confirm: true,
        planId: "a".repeat(64),
        draft: commentDraft,
      })
    ).status,
    409,
  );
  assert.deepEqual(synthetic.calls, []);

  const plan = await preview();
  assert.deepEqual(plan.draft, commentDraft);
  assert.deepEqual(plan.target, {
    origin: canvas.canvasOrigin,
    courseId: canvas.courseId,
    teacherId: canvas.userId,
    courseName: "Synthetic Studio",
  });
  assert.deepEqual(plan.feedbackSubject, {
    assignmentName: "Synthetic draft",
    testStudentId: "73009",
    attempt: 1,
    submittedAt: "2026-11-20T12:00:00Z",
  });
  assert.deepEqual(Object.keys(plan).sort(), [
    "draft",
    "feedbackSubject",
    "planId",
    "target",
  ]);
  assert.ok(synthetic.calls.every(([method]) => method === "GET"));
  assert.equal(
    (
      await request("post", {
        confirm: false,
        planId: plan.planId,
        draft: plan.draft,
      })
    ).status,
    400,
  );
  assert.equal(
    (await post(plan, { ...commentDraft, text: "Different text" })).status,
    409,
  );
  assert.deepEqual(synthetic.feedbackWrites, []);
  const response = await post(plan);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    status: "VERIFIED",
    commentId: "701",
  });
  const endpoint = "/courses/42001/assignments/81/submissions/73009";
  assert.deepEqual(synthetic.feedbackWrites, [
    {
      endpoint,
      fields: {
        "comment[text_comment]": encodedFeedback,
        "comment[attempt]": "1",
        "comment[group_comment]": "false",
      },
    },
  ]);
  assert.deepEqual(
    synthetic.calls
      .filter(([, path]) => path === endpoint)
      .map(([method]) => method),
    ["GET", "GET", "PUT", "GET"],
  );
  assert.equal((await post(plan)).status, 409);
  assert.equal(synthetic.feedbackWrites.length, 1);
  synthetic.assignmentRows.get("81").post_manually = true;
  synthetic.remote.submission.posted_at = null;
  const manual = await preview();
  assert.deepEqual(await (await post(manual)).json(), {
    status: "VERIFIED",
    commentId: "702",
  });
  assert.equal(synthetic.feedbackWrites.length, 2);
  assert.equal(synthetic.remote.submission.posted_at, null);
  assert.equal(synthetic.remote.submission.score, 6.5);
  assert.doesNotMatch(
    JSON.stringify(f.logs),
    /Compare <two routes>|Synthetic prior comment|Synthetic submission body|synthetic-rest-token/,
  );
});

test("Canvas feedback declines out-of-scope, changed, expired and cancelled submissions before dispatch", async (t) => {
  const synthetic = canvasPageFixture({ feedback: true });
  const { f, clock, request, preview, post } = await feedbackEntries(synthetic);
  t.after(() => f.close());
  const { remote, settings } = synthetic;
  for (const [field, value] of [
    ["user_id", 73010],
    ["assignment_id", 82],
    ["attempt", 0],
    ["assignment_visible", false],
    ["excused", true],
    ["missing", true],
    ["group", { id: 65 }],
    ["submitted_at", "2026-11-31T12:00:00Z"],
    ["posted_at", null],
  ]) {
    const original = remote.submission[field];
    remote.submission[field] = value;
    assert.equal(
      (await request("preview", { draft: commentDraft })).status,
      503,
    );
    remote.submission[field] = original;
  }
  for (const [field, value] of [
    ["published", false],
    ["group_category_id", 72],
    ["anonymous_grading", true],
    ["moderated_grading", true],
    ["submission_types", ["external_tool"]],
  ]) {
    const assignment = synthetic.assignmentRows.get("81");
    const original = assignment[field];
    assignment[field] = value;
    assert.equal(
      (await request("preview", { draft: commentDraft })).status,
      503,
    );
    assignment[field] = original;
  }
  const approvedStudent = remote.studentView;
  remote.studentView = [{ id: 73010 }];
  assert.equal((await request("preview", { draft: commentDraft })).status, 503);
  remote.studentView = [...approvedStudent, { id: 73010 }];
  assert.equal((await request("preview", { draft: commentDraft })).status, 503);
  remote.studentView = approvedStudent;

  const changedAttempt = await preview();
  remote.submission.attempt++;
  assert.equal((await post(changedAttempt)).status, 409);
  const changedBody = await preview();
  remote.submission.body = "A new synthetic draft";
  assert.equal((await post(changedBody)).status, 409);
  const changedPosting = await preview();
  const originalPosting = remote.submission.posted_at;
  remote.submission.posted_at = null;
  assert.equal((await post(changedPosting)).status, 409);
  remote.submission.posted_at = originalPosting;
  const changedCredential = await preview();
  remote.before = (method, endpoint) => {
    if (method === "GET" && endpoint.endsWith("/submissions/73009"))
      settings.canvasToken = "synthetic-rotated-token-for-fixtures";
  };
  assert.equal((await post(changedCredential)).status, 409);
  remote.before = undefined;

  const changedIdentity = await preview();
  remote.actorId = "73002";
  assert.equal((await post(changedIdentity)).status, 409);
  remote.actorId = canvas.userId;
  const superseded = await preview();
  const expired = await preview();
  assert.equal((await post(superseded)).status, 409);
  clock.now += 300_001;
  assert.equal((await post(expired)).status, 409);

  const cancelled = await preview();
  const entered = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  remote.before = async (method, endpoint, signal) => {
    if (method !== "GET" || !endpoint.endsWith("/submissions/73009")) return;
    entered.resolve();
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
    disconnected.resolve();
  };
  const controller = new AbortController();
  const result = post(cancelled, cancelled.draft, controller.signal);
  await entered.promise;
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  await disconnected.promise;
  assert.deepEqual(synthetic.feedbackWrites, []);
});

test("Canvas feedback verifies a new exact comment and never retries a dispatched write", async (t) => {
  const synthetic = canvasPageFixture({ feedback: true });
  const { f, preview, post } = await feedbackEntries(synthetic);
  t.after(() => f.close());
  const { remote } = synthetic;
  for (const projection of [
    (receipt) => ({ ...receipt, attempt: 2 }),
    (receipt) => ({
      ...receipt,
      submission_comments: [
        { ...receipt.submission_comments.at(-1), attempt: null },
      ],
    }),
    (receipt) => ({
      ...receipt,
      submission_comments: receipt.submission_comments.slice(0, -1),
    }),
    (receipt) => ({
      ...receipt,
      submission_comments: [
        { ...receipt.submission_comments.at(-1), author_id: 73002 },
      ],
    }),
    () => {
      throw new Error("Synthetic dropped response after write");
    },
  ]) {
    const plan = await preview();
    remote.feedbackReceipt = projection;
    assert.deepEqual(await (await post(plan)).json(), { status: "UNCERTAIN" });
    assert.equal((await post(plan)).status, 409);
  }
  assert.equal(synthetic.feedbackWrites.length, 5);

  remote.feedbackReceipt = (receipt) => {
    remote.feedbackRead = (value) => ({
      ...value,
      submission_comments: value.submission_comments.slice(0, -1),
    });
    return receipt;
  };
  const plan = await preview();
  assert.deepEqual(await (await post(plan)).json(), {
    status: "UNVERIFIED",
    commentId: "706",
  });
  assert.equal((await post(plan)).status, 409);
  assert.equal(synthetic.feedbackWrites.length, 6);
});
