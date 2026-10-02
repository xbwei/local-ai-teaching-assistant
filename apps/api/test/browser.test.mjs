import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./browser-fixture.mjs";
import { isAccessConfiguration } from "@laita/contracts/server";
const root = "/api/v1/input";
test("Owner opens directly; retired pairing routes and settings are rejected", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  assert.ok(isAccessConfiguration(f.config));
  assert.equal(
    isAccessConfiguration({
      ...f.config,
      browserSessions: { pairingTtlSeconds: 60, sessionTtlSeconds: 120 },
    }),
    false,
  );
  const d = await f.device();
  const r = await d.send(root + "/sessions", { method: "POST" });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.expiresAt, undefined);
  assert.equal(r.headers.get("set-cookie"), null);
  for (const route of ["session", "redeem", "pairings"])
    assert.equal(
      (await d.send("/api/v1/browser/" + route, { method: "POST" })).status,
      404,
    );
});
test("Owner transport, Origin, fetch-site, maintenance and rate protections", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const d = await f.device();
  for (const headers of [
    { origin: "https://other.invalid" },
    { "x-forwarded-proto": "http" },
    { "x-forwarded-host": "other.invalid" },
    { "sec-fetch-site": "cross-site" },
    { authorization: "Bearer synthetic" },
    { "content-encoding": "gzip" },
    { "x-owner-client": "bad" },
  ])
    assert.equal(
      (await d.send(root + "/sessions", { method: "POST", headers })).status,
      headers["content-encoding"] ? 400 : 403,
    );
  f.config.maintenanceMode = true;
  assert.equal(
    (await d.send(root + "/sessions", { method: "POST" })).status,
    403,
  );
  f.config.maintenanceMode = false;
  f.config.mode = "controlled-pilot";
  assert.equal(
    (await d.send(root + "/sessions", { method: "POST" })).status,
    403,
  );
  f.config.mode = "single-operator";
  for (let i = 0; i < 599; i++)
    assert.equal((await d.send(root + "/jobs/" + "a".repeat(64))).status, 404);
  assert.equal(
    (await d.send(root + "/sessions", { method: "POST" })).status,
    429,
  );
});
test("conversation references are device-owned and reset invalidates previous work", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const a = await f.device(),
    b = await f.device();
  const s = await (await a.send(root + "/sessions", { method: "POST" })).json();
  const init = { headers: { "x-input-session": s.sessionRef } };
  assert.equal((await a.send(root + "/build", init)).status, 200);
  assert.equal((await b.send(root + "/build", init)).status, 404);
  await a.send(root + "/session", { ...init, method: "DELETE" });
  assert.equal((await a.send(root + "/build", init)).status, 404);
  assert.equal(
    (await a.send(root + "/sessions", { method: "POST" })).status,
    200,
  );
});
