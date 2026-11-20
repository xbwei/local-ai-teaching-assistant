import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
async function launch(f, changes = {}, extra = {}) {
  return f.request("/api/v1/canvas/launch", {
    method: "POST",
    headers: {
      origin: canvas.canvasOrigin,
      "sec-fetch-site": "cross-site",
      "content-type": "application/x-www-form-urlencoded",
      cookie: "",
      ...extra,
    },
    body: signed(`${f.config.publicOrigin}/api/v1/canvas/launch`, changes),
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

test("nonce replay survives SQLite reopen and concurrent repositories; credential rotation invalidates every role", async (t) => {
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
  assert.ok(!tables.some((name) => /users|memberships|accounts/u.test(name)));
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
  let summaries = 0;
  const f = await fixture({
    autoLogin: false,
    authNow: () => now,
    canvas: () => canvas,
    history: true,
    teacherHistory: {
      context,
      read: () => f.persistence.history({ role: "student", context }),
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
  const count = await ask(
    teacher,
    "How many questions in the last seven days?",
  );
  assert.match((await count.json()).text, /^2 questions recorded/);
  const unsupported = await ask(teacher, "Show all student questions");
  assert.match((await unsupported.json()).text, /one local sample/);
  assert.equal(summaries, 0);
  const response = await ask(
    teacher,
    "What topics did the Test Student ask about?",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    text: "The main topic is comparing practice examples.",
  });
  assert.equal(summaries, 1);
  assert.doesNotMatch(
    JSON.stringify(f.logs),
    /practice examples|ordinary practice|separate sample/,
  );
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
      read() {
        historyReads++;
        return f.persistence.history({ role: "student", context });
      },
      async summarize() {
        assert.fail("Count must not call the Local model");
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
const authoredDraft = {
  title: "Studio — 地图 🌍",
  body: "<h2>地图</h2><p>Compare <strong>two</strong> routes &amp; explain&nbsp;🌍.</p>",
};
async function pageEntries(synthetic) {
  const clock = { now };
  const f = await fixture({
    autoLogin: false,
    canvas: () => canvas,
    authNow: () => clock.now,
    canvasPages: synthetic.options,
  });
  const response = await launch(f);
  assert.equal(response.status, 303);
  const canvasCookie = cookie(response);
  const request = (phase, body, selected = canvasCookie, extra = {}) =>
    f.request(pagesPath + (phase ? "/" + phase : ""), {
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
  return { f, clock, request, preview, create };
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
