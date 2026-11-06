import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
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

const now = 1900000000000;
const canvas = {
  enabled: true,
  canvasOrigin: "https://canvas.example.test",
  courseId: "42001",
  userId: "73001",
  consumerKey: "synthetic-consumer-key-not-for-use",
  sharedSecret: "synthetic-shared-secret-not-a-real-credential",
};
// Independent RFC 5849 reference signer in tests; never a product signing endpoint.
const encode = (s) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase(),
  );
function signed(url, changes = {}, secret = canvas.sharedSecret) {
  const fields = {
    lti_message_type: "basic-lti-launch-request",
    lti_version: "LTI-1p0",
    oauth_version: "1.0",
    oauth_signature_method: "HMAC-SHA1",
    oauth_consumer_key: canvas.consumerKey,
    oauth_nonce: "synthetic-nonce-0001",
    oauth_timestamp: String(now / 1000),
    roles: "Instructor",
    custom_canvas_api_domain: "canvas.example.test",
    custom_canvas_course_id: canvas.courseId,
    custom_canvas_user_id: canvas.userId,
    ...changes,
  };
  const params = Object.entries(fields)
    .map(([k, v]) => `${encode(k)}=${encode(v)}`)
    .sort()
    .join("&");
  fields.oauth_signature = createHmac("sha1", encode(secret) + "&")
    .update(["POST", encode(url), encode(params)].join("&"))
    .digest("base64");
  return new URLSearchParams(fields).toString();
}
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
    assert.ok([400, 403].includes(response.status));
  }
  assert.equal(
    f.persistence.history().conversation(item.conversation).turns[0].review,
    "PENDING",
  );
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
