import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { createAccessController } from "../dist/access.js";
import { createApp } from "../dist/app.js";
import { createOperationalLogger } from "@laita/runtime";

const tokens = Object.freeze({
  student: "synthetic-student-credential-not-a-secret-0001",
  kiosk: "synthetic-kiosk-credential-not-a-secret-000002",
  instructor: "synthetic-instructor-credential-not-secret-0003",
  admin: "synthetic-admin-credential-not-a-secret-0000004",
  malformed: "short",
});
const hash = (value) => createHash("sha256").update(value).digest("hex");
const now = 2_000_000_000_000;
const credential = (id, role, token, overrides = {}) => ({
  id,
  role,
  courseScopes: ["synthetic-course"],
  tokenSha256: hash(token),
  expiresAtEpochSeconds: now / 1000 + 3600,
  revoked: false,
  ...overrides,
});
const adminCredential = (overrides = {}) => ({
  id: "synthetic-admin",
  tokenSha256: hash(tokens.admin),
  expiresAtEpochSeconds: now / 1000 + 3600,
  revoked: false,
  ...overrides,
});
const configuration = (overrides = {}) => ({
  mode: "controlled-pilot",
  enabled: true,
  maintenanceMode: false,
  publicOrigin: "https://teaching.example.invalid",
  requireForwardedHttps: true,
  authenticationRateLimit: { windowSeconds: 60, maxRequests: 100 },
  credentialRateLimit: { windowSeconds: 60, maxRequests: 100 },
  credentials: [
    credential("synthetic-student", "student", tokens.student),
    credential("synthetic-kiosk", "kiosk", tokens.kiosk),
    credential("synthetic-instructor", "instructor", tokens.instructor),
  ],
  adminCredentials: [adminCredential()],
  ...overrides,
});
const request = (token, overrides = {}) => ({
  authorization: `Bearer ${token}`,
  origin: "https://teaching.example.invalid",
  forwardedHost: "teaching.example.invalid",
  forwardedProto: "https",
  ...overrides,
});

test("private access rejects missing, malformed, expired, revoked and wrong-role credentials", () => {
  const access = createAccessController(configuration(), () => now);
  assert.deepEqual(access.authorize({}, "student"), {
    ok: false,
    code: "FORBIDDEN",
    status: 403,
  });
  assert.deepEqual(access.authorize(request(tokens.malformed), "student"), {
    ok: false,
    code: "UNAUTHENTICATED",
    status: 401,
  });
  assert.deepEqual(access.authorize(request(tokens.student), "student"), {
    ok: true,
  });
  assert.deepEqual(access.authorize(request(tokens.student), "admin"), {
    ok: false,
    code: "UNAUTHENTICATED",
    status: 401,
  });
  assert.deepEqual(access.authorize(request(tokens.kiosk), "admin"), {
    ok: false,
    code: "UNAUTHENTICATED",
    status: 401,
  });
  assert.deepEqual(access.authorize(request(tokens.student), "kiosk"), {
    ok: false,
    code: "FORBIDDEN",
    status: 403,
  });
  assert.deepEqual(access.authorize(request(tokens.instructor), "control"), {
    ok: true,
    actorRole: "INSTRUCTOR",
  });
  assert.deepEqual(access.authorize(request(tokens.admin), "control"), {
    ok: true,
    actorRole: "ADMIN",
  });
  for (const token of [tokens.student, tokens.kiosk])
    assert.deepEqual(access.authorize(request(token), "control"), {
      ok: false,
      code: "UNAUTHENTICATED",
      status: 401,
    });
  for (const changed of [
    credential("synthetic-student", "student", tokens.student, {
      revoked: true,
    }),
    credential("synthetic-student", "student", tokens.student, {
      expiresAtEpochSeconds: now / 1000,
    }),
  ]) {
    const stale = createAccessController(
      configuration({ credentials: [changed] }),
      () => now,
    );
    assert.deepEqual(stale.authorize(request(tokens.student), "student"), {
      ok: false,
      code: "UNAUTHENTICATED",
      status: 401,
    });
  }
});

test("private access requires the exact HTTPS proxy and origin contract", () => {
  for (const changed of [
    { forwardedProto: "http" },
    { forwardedProto: "https,http" },
    { forwardedHost: "other.example.invalid" },
    { forwardedHost: "teaching.example.invalid,other.example.invalid" },
    { origin: "https://other.example.invalid" },
  ]) {
    const access = createAccessController(configuration(), () => now);
    assert.deepEqual(
      access.authorize(request(tokens.student, changed), "student"),
      { ok: false, code: "FORBIDDEN", status: 403 },
    );
  }
});

test("ambiguous instructor/admin control credentials fail closed", () => {
  const access = createAccessController(
    configuration({
      credentials: [
        credential("synthetic-instructor", "instructor", tokens.instructor),
      ],
      adminCredentials: [
        adminCredential({ tokenSha256: hash(tokens.instructor) }),
      ],
    }),
    () => now,
  );
  assert.deepEqual(access.authorize(request(tokens.instructor), "control"), {
    ok: false,
    code: "UNAUTHENTICATED",
    status: 401,
  });
});

test("kill switch, maintenance, institution stage and bounded rates fail closed", () => {
  assert.equal(
    createAccessController(
      configuration({ enabled: false }),
      () => now,
    ).authorize(request(tokens.student), "student").code,
    "ACCESS_DISABLED",
  );
  const maintenance = createAccessController(
    configuration({ maintenanceMode: true }),
    () => now,
  );
  assert.equal(
    maintenance.authorize(request(tokens.student), "student").code,
    "MAINTENANCE",
  );
  assert.deepEqual(maintenance.authorize(request(tokens.admin), "admin"), {
    ok: true,
  });
  assert.equal(maintenance.isReady(), false);
  const future = createAccessController(
    configuration({
      mode: "institution-approved",
      enabled: false,
      credentials: [],
      adminCredentials: [],
    }),
    () => now,
  );
  assert.equal(future.isReady(), false);
  assert.equal(
    future.authorize(request(tokens.student), "student").code,
    "UNAUTHENTICATED",
  );
  const limited = createAccessController(
    configuration({
      authenticationRateLimit: { windowSeconds: 60, maxRequests: 2 },
      credentialRateLimit: { windowSeconds: 60, maxRequests: 1 },
    }),
    () => now,
  );
  assert.deepEqual(limited.authorize(request(tokens.student), "student"), {
    ok: true,
  });
  assert.equal(
    limited.authorize(request(tokens.student), "student").code,
    "RATE_LIMITED",
  );
  assert.equal(
    limited.authorize(request(tokens.student), "student").code,
    "RATE_LIMITED",
  );
  const authenticationLimited = createAccessController(
    configuration({
      authenticationRateLimit: { windowSeconds: 60, maxRequests: 1 },
    }),
    () => now,
  );
  assert.equal(
    authenticationLimited.authorize(request(tokens.malformed), "student").code,
    "UNAUTHENTICATED",
  );
  assert.equal(
    authenticationLimited.authorize(request(tokens.malformed), "student").code,
    "RATE_LIMITED",
  );
});

test("restart behavior is derived only from the validated configuration", () => {
  const active = configuration();
  assert.deepEqual(
    createAccessController(active, () => now).authorize(
      request(tokens.student),
      "student",
    ),
    { ok: true },
  );
  const revoked = configuration({
    credentials: [
      credential("synthetic-student", "student", tokens.student, {
        revoked: true,
      }),
    ],
  });
  for (let restart = 0; restart < 2; restart += 1)
    assert.equal(
      createAccessController(revoked, () => now).authorize(
        request(tokens.student),
        "student",
      ).code,
      "UNAUTHENTICATED",
    );
});

test("HTTP routes enforce student, kiosk, instructor and independent admin boundaries", async () => {
  const access = createAccessController(configuration(), () => now);
  const lines = [];
  const app = createApp({
    access,
    persistence: { isReady: () => true },
    logger: createOperationalLogger((line) => lines.push(line)),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = (token, overrides = {}) => ({
    Authorization: `Bearer ${token}`,
    Origin: "https://teaching.example.invalid",
    "X-Forwarded-Host": "teaching.example.invalid",
    "X-Forwarded-Proto": "https",
    ...overrides,
  });
  try {
    for (const route of [
      "/api/scaffold",
      "/api/kiosk/scaffold",
      "/api/instructor/scaffold",
      "/api/provider-runs",
    ]) {
      assert.equal(
        (await fetch(base + route, { headers: headers(tokens.instructor) }))
          .status,
        404,
      );
    }
    assert.equal(
      (
        await fetch(base + "/api/admin/access", {
          headers: headers(tokens.student),
        })
      ).status,
      401,
    );
    const admin = await fetch(`${base}/api/admin/access`, {
      headers: headers(tokens.admin),
    });
    assert.equal(admin.status, 200);
    assert.equal(admin.headers.get("strict-transport-security") !== null, true);
    assert.deepEqual(await admin.json(), {
      contractVersion: "access-status.v1",
      mode: "controlled-pilot",
      status: "enabled",
    });
    for (const path of [
      "/api/provider",
      "/api/database",
      "/api/filesystem",
      "/api/kiosk/exit",
    ])
      assert.equal(
        (await fetch(base + path, { headers: headers(tokens.admin) })).status,
        404,
      );
    const badOrigin = await fetch(`${base}/api/admin/access`, {
      headers: headers(tokens.admin, {
        Origin: "https://other.example.invalid",
      }),
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.headers.get("access-control-allow-origin"), null);
    assert.equal(badOrigin.headers.get("cache-control"), "no-store");
    const logs = lines.join("\n");
    for (const value of [
      ...Object.values(tokens),
      "teaching.example.invalid",
      "synthetic-course",
    ])
      assert.equal(logs.includes(value), false);
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
});

for (const [name, overrides, expectedCode] of [
  ["disabled", { enabled: false }, "ACCESS_DISABLED"],
  ["maintenance", { maintenanceMode: true }, "MAINTENANCE"],
]) {
  test(`HTTP ${name} state keeps health public, makes readiness false and blocks clients`, async () => {
    const app = createApp({
      access: createAccessController(configuration(overrides), () => now),
      persistence: { isReady: () => true },
      logger: { write: () => true },
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = {
      Authorization: `Bearer ${tokens.instructor}`,
      Origin: "https://teaching.example.invalid",
      "X-Forwarded-Host": "teaching.example.invalid",
      "X-Forwarded-Proto": "https",
    };
    try {
      assert.equal((await fetch(`${base}/health`)).status, 200);
      assert.equal((await fetch(`${base}/ready`)).status, 503);
      const denied = await fetch(`${base}/api/instructor/capabilities`, {
        headers,
      });
      assert.equal(denied.status, 503);
      assert.equal((await denied.json()).code, expectedCode);
    } finally {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    }
  });
}
