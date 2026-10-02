import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./browser-fixture.mjs";
import { isAccessConfiguration } from "@laita/contracts/server";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const root = "/api/v1/input";
test("static files share a bounded rate window before filesystem access", async (t) => {
  const webRoot = mkdtempSync(path.join(tmpdir(), "laita-static-test-"));
  const populate = () => {
    mkdirSync(path.join(webRoot, "assets"), { recursive: true });
    writeFileSync(path.join(webRoot, "index.html"), "Synthetic page");
    writeFileSync(path.join(webRoot, "capture-worklet.js"), "// synthetic");
    writeFileSync(path.join(webRoot, "assets/test.js"), "// synthetic");
  };
  populate();
  let now = 0;
  const f = await fixture({ webRoot, now: () => now });
  t.after(async () => {
    await f.close();
    rmSync(webRoot, { recursive: true, force: true });
  });
  const routes = ["/", "/history", "/capture-worklet.js", "/assets/test.js"];
  // express.static ignores these methods without touching files. They must
  // neither consume the delivery budget nor turn a normal 404 into a 429.
  const unsupportedMethods = ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"];
  for (let i = 0; i < 601; i++) {
    const response = await f.request("/assets/test.js", {
      method: unsupportedMethods[i % unsupportedMethods.length],
    });
    assert.equal(response.status, 404);
    await response.text();
  }
  // Static entry must work without the API-only Owner header. Alternate HEAD
  // and GET across every filesystem handler: they share one static budget.
  for (let i = 0; i < 600; i++) {
    const response = await f.request(routes[i % routes.length], {
      method: i % 2 ? "HEAD" : "GET",
    });
    assert.equal(response.status, 200);
    await response.text();
  }
  // Removing files proves denial happens before sendFile/static can fall
  // through to a missing-file error. Query strings cannot reset the budget.
  rmSync(webRoot, { recursive: true });
  for (const route of routes) {
    const response = await f.request(route + "?synthetic=1");
    assert.equal(response.status, 429);
    assert.equal((await response.json()).code, "RATE_LIMITED");
  }
  const head = await f.request("/history", { method: "HEAD" });
  assert.equal(head.status, 429);
  assert.equal(await head.text(), "");
  assert.equal(
    (await f.request("/assets/test.js", { method: "POST" })).status,
    404,
  );
  // Static saturation does not consume the separate API transport budget.
  const device = await f.device();
  assert.equal(
    (await device.send(root + "/sessions", { method: "POST" })).status,
    200,
  );
  now = 59_999;
  assert.equal((await f.request("/")).status, 429);
  populate();
  now = 60_000;
  for (const route of routes) {
    const response = await f.request(route);
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.ok(f.logs.some((entry) => entry.code === "RATE_LIMITED"));
});
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
