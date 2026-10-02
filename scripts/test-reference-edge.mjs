import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { request } from "node:https";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { initializeRuntimePaths } from "@laita/runtime";
import { initializePersistence } from "@laita/persistence";
import { fixture, capabilities } from "../apps/api/test/browser-fixture.mjs";
import { InputApi } from "../apps/web/src/client/api.ts";

async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail("Timed out waiting for isolated reference-edge test");
}

test(
  "real reference Caddy edge preserves transient clients, shared History and fail-closed transport",
  { timeout: 30_000 },
  async (t) => {
    // Caddy is required: never skip the actual proxy composition in CI.
    assert.match(
      execFileSync("caddy", ["version"], { encoding: "utf8" }),
      /^v2\.11\.6\b/u,
    );
    const root = mkdtempSync(path.join(tmpdir(), "laita-reference-edge-"));
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const edgePort = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const origin = `https://localhost:${edgePort}`;
    const paths = initializeRuntimePaths(path.join(root, "runtime"));
    assert.equal(paths.ok, true);
    const persistence = initializePersistence(paths.value);
    assert.equal(persistence.ok, true);
    let edge, backend, pending;
    t.after(async () => {
      pending?.resolve();
      backend?.close();
      if (edge && edge.exitCode === null && edge.signalCode === null) {
        const stopped = once(edge, "exit");
        edge.kill("SIGTERM");
        await stopped;
      }
      persistence.value.close();
      rmSync(root, { recursive: true, force: true });
    });
    const transport = [];
    backend = await fixture({
      publicOrigin: origin,
      history: persistence.value.history(),
      observeTransport: (headers) => transport.push({ ...headers }),
      async execute(value, signal) {
        await new Promise((resolve) => {
          pending = { resolve, signal };
        });
        return {
          contractVersion: "provider-run-result.v1",
          interactionRef: `interaction-${randomUUID()}`,
          mode: "LOCAL",
          legs: [
            {
              runRef: `run-${randomUUID()}`,
              provider: "LOCAL",
              model: value.localModel,
              status: "COMPLETED",
              provenance: {
                actualProvider: "LOCAL",
                actualModel: value.localModel,
                adapter: "synthetic",
              },
              output: { text: "Synthetic reference-edge answer." },
              metrics: { latencyMs: 1 },
            },
          ],
        };
      },
    });
    // Use the shipped composition verbatim, changing only isolated ports and CA
    // storage/trust installation. No forwarding/security rule is substituted.
    const reference = readFileSync(
      new URL("../ops/reference/Caddyfile", import.meta.url),
      "utf8",
    );
    const config = reference
      .replaceAll("localhost:3443", `localhost:${edgePort}`)
      .replaceAll("127.0.0.1:3100", backend.host)
      .replace("\tadmin off", "\tadmin off\n\tskip_install_trust");
    const configPath = path.join(root, "Caddyfile");
    writeFileSync(configPath, config, { mode: 0o600 });
    edge = spawn(
      "caddy",
      ["run", "--config", configPath, "--adapter", "caddyfile"],
      {
        env: {
          ...process.env,
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CONFIG_HOME: path.join(root, "config"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let diagnostics = "";
    edge.stdout.on("data", (bytes) => {
      diagnostics += bytes;
    });
    edge.stderr.on("data", (bytes) => {
      diagnostics += bytes;
    });
    const caPath = path.join(root, "data/caddy/pki/authorities/local/root.crt");
    let ca;
    await until(async () => {
      assert.equal(edge.exitCode, null, diagnostics);
      try {
        ca = readFileSync(caPath);
        return true;
      } catch {
        return false;
      }
    });
    const edgeFetch = (route, init = {}) =>
      new Promise((resolve, reject) => {
        const headers = {
          host: `localhost:${edgePort}`,
          origin,
          "sec-fetch-site": "same-origin",
          ...init.headers,
        };
        for (const key of Object.keys(headers))
          if (headers[key] === undefined) delete headers[key];
        const req = request(
          {
            hostname: "127.0.0.1",
            port: edgePort,
            servername: "localhost",
            ca,
            path: route,
            method: init.method ?? "GET",
            headers,
            signal: init.signal,
            timeout: 5000,
          },
          (res) => {
            const chunks = [];
            res.on("data", (bytes) => chunks.push(bytes));
            res.on("end", () =>
              resolve(
                new Response(Buffer.concat(chunks), {
                  status: res.statusCode,
                  headers: res.headers,
                }),
              ),
            );
            res.on("error", reject);
          },
        );
        req.on("timeout", () =>
          req.destroy(new Error("Test transport timeout")),
        );
        req.on("error", reject);
        req.end(init.body);
      });
    await until(async () => {
      try {
        return (await edgeFetch("/health")).status === 200;
      } catch {
        return false;
      }
    });
    const a = new InputApi(edgeFetch),
      b = new InputApi(edgeFetch);
    const aSession = await a.start();
    const aOwner = transport.at(-1)["x-owner-client"];
    const submission = () => ({
      contractVersion: "input-submission.v1",
      clientKind: "COMPUTER",
      source: "TYPED",
      request: {
        contractVersion: "provider-run-request.v1",
        clientRequestId: randomUUID(),
        mode: "LOCAL",
        localModel: "gemma4:12b-mlx",
        input: { text: "Explain a tree." },
        capabilityIdentity: capabilities("Explain a tree.").identity,
      },
    });
    const aJob = await a.submit(submission());
    await until(() => pending !== undefined);
    const active = pending;
    const bSession = await b.start();
    const bOwner = transport.at(-1)["x-owner-client"];
    assert.notEqual(aOwner, bOwner);
    assert.notEqual(aSession.sessionRef, bSession.sessionRef);
    assert.equal(active.signal.aborted, false, "opening B must not cancel A");
    await a.build();
    assert.equal((await a.job(aJob.jobRef)).state, "PROCESSING");
    await b.reset();
    assert.equal(active.signal.aborted, false, "resetting B must not cancel A");
    await a.build();
    assert.equal((await a.job(aJob.jobRef)).state, "PROCESSING");
    await b.start();
    await assert.rejects(
      b.submit(submission()),
      (error) => error.status === 503,
    );
    assert.equal(
      backend.calls(),
      1,
      "BUSY admits no second operation or queue",
    );
    assert.equal(active.signal.aborted, false);
    active.resolve();
    await until(async () => (await a.job(aJob.jobRef)).state === "COMPLETED");
    // Both clients see the same operator History, including the BUSY outcome.
    const historyA = await a.historyRequest("query", {});
    const historyB = await b.historyRequest("query", {});
    assert.deepEqual(historyB, historyA);
    assert.equal(historyA.items.length, 2);
    assert.ok(
      JSON.stringify(
        persistence.value
          .history()
          .conversation(historyA.items[0].conversation, 0),
      ).includes("BUSY"),
    );
    const bJob = await b.submit(submission());
    await until(() => pending !== active);
    assert.equal(
      backend.calls(),
      2,
      "a settled operation releases global admission",
    );
    pending.resolve();
    await until(async () => (await b.job(bJob.jobRef)).state === "COMPLETED");

    const valid = {
      "x-owner-client": aOwner,
      "x-input-session": aSession.sessionRef,
    };
    const route = "/api/v1/input/build";
    for (const invalid of [
      { origin: "https://example.invalid" },
      { "sec-fetch-site": "cross-site" },
      { "x-owner-client": undefined },
      { "x-owner-client": "invalid" },
    ])
      assert.equal(
        (await edgeFetch(route, { headers: { ...valid, ...invalid } })).status,
        403,
        JSON.stringify(invalid),
      );
    // Express rejects the malformed compressed body before transport authentication.
    assert.equal(
      (
        await edgeFetch(route, {
          headers: { ...valid, "content-encoding": "gzip" },
        })
      ).status,
      400,
    );
    for (const host of ["example.invalid", "localhost:1", "localhost"]) {
      const before = transport.length;
      const status = (await edgeFetch(route, { headers: { ...valid, host } }))
        .status;
      assert.ok(status >= 400 && status < 500, `${host}: ${status}`);
      assert.equal(
        transport.length,
        before,
        "invalid Host must never reach backend",
      );
    }
    assert.equal(
      (await edgeFetch(route + "?synthetic=1", { headers: valid })).status,
      400,
    );
    assert.equal(
      (
        await edgeFetch("/api/v1/input/sessions", {
          method: "POST",
          headers: { ...valid, origin: undefined },
        })
      ).status,
      403,
    );
    // Incoming forwarding headers cannot assert transport authority at the edge.
    assert.equal(
      (
        await edgeFetch(route, {
          headers: {
            ...valid,
            "x-forwarded-proto": "http",
            "x-forwarded-host": "example.invalid",
            "x-forwarded-for": "192.0.2.42",
            forwarded: "host=example.invalid;proto=http",
            authorization: "Bearer synthetic-noncredential",
          },
        })
      ).status,
      200,
    );
    assert.equal(transport.at(-1)["x-forwarded-proto"], "https");
    assert.equal(transport.at(-1)["x-forwarded-host"], `localhost:${edgePort}`);
    assert.equal(transport.at(-1)["x-forwarded-for"], "127.0.0.1");
    assert.equal(transport.at(-1).forwarded, undefined);
    assert.equal(transport.at(-1).authorization, undefined);
    assert.equal(
      (await fetch(backend.origin + route, { headers: valid })).status,
      403,
    );
    assert.equal(
      (
        await fetch(backend.origin + route, {
          headers: {
            ...valid,
            origin,
            "x-forwarded-proto": "http",
            "x-forwarded-host": `localhost:${edgePort}`,
          },
        })
      ).status,
      403,
    );
    await a.reset();
    await b.build();
  },
);
