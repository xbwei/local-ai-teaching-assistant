import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseConfiguration } from "@laita/runtime";

for (const cloud of [false, true]) {
  test(`Public operator startup and choices with ${cloud ? "enabled Cloud but absent credential mapping" : "Local-only and no credential"}`, async (t) => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "laita-public-startup-")),
    );
    chmodSync(root, 0o700);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const config = JSON.parse(
      readFileSync(
        new URL(
          "../../../ops/macos/application-config.json.template",
          import.meta.url,
        ),
      ),
    );
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    config.server.port = reservation.address().port;
    const closed = once(reservation, "close");
    reservation.close();
    await closed;
    config.runtimeRoot = path.join(root, "runtime");
    config.access.enabled = true;
    config.access.adminCredentials = [
      {
        id: "synthetic-control",
        tokenSha256: "c".repeat(64),
        expiresAtEpochSeconds: 4102444800,
        revoked: false,
      },
    ];
    config.features.openai = cloud;
    config.features.compare = cloud;
    config.providers.openai.secretReference = cloud
      ? { kind: "opaque", id: "synthetic-openai" }
      : null;
    assert.equal(parseConfiguration(JSON.stringify(config)).ok, true);
    // Every provider request is intercepted in the child. No real Ollama/Cloud/Keychain use.
    const preload = path.join(root, "synthetic-provider.mjs");
    writeFileSync(
      preload,
      `globalThis.fetch = async (input) => {
      const u = new URL(String(input));
      if (u.origin !== 'http://127.0.0.1:11434') throw new Error('Unexpected network request');
      if (u.pathname === '/api/tags') return Response.json({ models: ['gemma4:12b-mlx','llama3.1:8b'].map(model => ({model,digest:'a'.repeat(64),size:1000})) });
      if (u.pathname === '/api/ps') return Response.json({models:[]});
      throw new Error('Unexpected provider execution');
    };`,
      { mode: 0o600 },
    );
    const child = spawn(
      process.execPath,
      [
        "--import",
        preload,
        new URL("../dist/main.js", import.meta.url).pathname,
      ],
      {
        env: { APP_CONFIG_JSON: JSON.stringify(config) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exit = once(child, "exit");
    let output = "",
      errors = "";
    child.stdout.on("data", (b) => {
      output += b;
    });
    child.stderr.on("data", (b) => {
      errors += b;
    });
    try {
      for (
        let i = 0;
        i < 100 && !output.includes('"event":"API_STARTED"');
        i++
      ) {
        assert.equal(child.exitCode, null, errors);
        await delay(25);
      }
      assert.match(output, /API_STARTED/);
      const origin = `http://127.0.0.1:${config.server.port}`;
      assert.equal((await fetch(`${origin}/ready`)).status, 200);
      const headers = {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "localhost:3443",
        "x-owner-client": "a".repeat(64),
        origin: "https://localhost:3443",
      };
      const session = await fetch(`${origin}/api/v1/input/sessions`, {
        method: "POST",
        headers,
      });
      assert.equal(session.status, 200);
      const value = await session.json();
      const response = await fetch(`${origin}/api/v1/input/choices`, {
        method: "POST",
        body: JSON.stringify({ text: "" }),
        headers: {
          ...headers,
          "content-type": "application/json",
          "x-input-session": value.sessionRef,
        },
      });
      assert.equal(response.status, 200);
      const choices = await response.json();
      assert.ok(choices.providers.modes.some((m) => m.id === "LOCAL"));
      assert.equal(
        choices.providers.modes.some((m) => m.id === "OPENAI"),
        false,
      );
      assert.equal(
        choices.providers.modes.some((m) => m.id === "COMPARE"),
        false,
      );
      assert.equal(JSON.stringify(choices).includes("synthetic-openai"), false);
      assert.equal(output.includes(config.runtimeRoot), false);
    } finally {
      child.kill("SIGTERM");
      const ended = await Promise.race([
        exit,
        delay(5000, "timeout", { ref: false }),
      ]);
      if (ended === "timeout") {
        child.kill("SIGKILL");
        await exit;
      }
      assert.notEqual(ended, "timeout");
    }
  });
}
