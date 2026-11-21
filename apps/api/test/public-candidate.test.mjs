import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import { parseConfiguration, initializeRuntimePaths } from "@laita/runtime";
import { initializePersistence } from "@laita/persistence";
import { testCredential, testPassphrase } from "./owner-fixture.mjs";

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
    // Keep the configured port occupied. The child fixture must bind its own
    // free port instead of depending on a released reservation.
    config.server.port = reservation.address().port;
    t.after(async () => {
      const closed = once(reservation, "close");
      reservation.close();
      await closed;
    });
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
    const sampleId = "practice";
    const sampleQuestion = "How can two visual examples be compared?";
    const ordinaryQuestion = "Ordinary outside sample";
    const summary = "The sample explores comparing visual examples.";
    // Every provider request is intercepted in the child. No real Ollama/Cloud/Keychain use.
    const preload = path.join(root, "synthetic-provider.mjs");
    writeFileSync(
      preload,
      `import express from ${JSON.stringify(import.meta.resolve("express"))};
    const listen = express.application.listen;
    express.application.listen = function (port, host) {
      if (port !== ${config.server.port} || host !== '127.0.0.1')
        throw new Error('Unexpected public API listener');
      const server = listen.call(this, 0, host);
      server.once('listening', () => process.send({ port: server.address().port }));
      return server;
    };
    globalThis.fetch = async (input, init) => {
      const u = new URL(String(input));
      if (u.origin !== 'http://127.0.0.1:11434') throw new Error('Unexpected network request');
      if (u.pathname === '/api/tags') return Response.json({ models: ['gemma4:12b-mlx','llama3.1:8b'].map(model => ({model,digest:'a'.repeat(64),size:1000})) });
      if (u.pathname === '/api/ps') return Response.json({models:[]});
      if (u.pathname === '/api/chat' && ${cloud}) {
        const request = JSON.parse(init.body);
        const prompt = request.messages.map(({content}) => content).join(' ');
        if (!prompt.includes(${JSON.stringify(sampleQuestion)}) || prompt.includes(${JSON.stringify(ordinaryQuestion)}))
          throw new Error('Unexpected synthetic sample scope');
        const response = { model: request.model, message: { role: 'assistant', content: ${JSON.stringify(summary)} }, done: true, done_reason: 'stop' };
        return request.stream
          ? new Response(JSON.stringify(response) + '\\n', { headers: { 'content-type': 'application/x-ndjson' } })
          : Response.json(response);
      }
      throw new Error('Unexpected provider execution');
    };`,
      { mode: 0o600 },
    );
    const paths = initializeRuntimePaths(config.runtimeRoot);
    assert.equal(paths.ok, true);
    const db = initializePersistence(paths.value);
    assert.equal(db.ok, true);
    db.value.ownerAuth().setCredential(await testCredential);
    if (cloud) {
      const context = createHash("sha256")
        .update(`laita-test-student:${sampleId}`)
        .digest("hex");
      for (const [scope, text] of [
        [context, sampleQuestion],
        ["", ordinaryQuestion],
      ]) {
        const history = db.value.history({ role: "student", context: scope });
        const id = randomUUID();
        history.begin({
          conversation: randomUUID(),
          id,
          inputType: "TYPED",
          text,
          correlation: null,
        });
        history.outcome(id, "NO_ANSWER");
      }
    }
    db.value.close();
    const child = spawn(
      process.execPath,
      [
        "--import",
        preload,
        new URL("../dist/main.js", import.meta.url).pathname,
      ],
      {
        env: {
          APP_CONFIG_JSON: JSON.stringify(config),
          ...(cloud ? { LAITA_HISTORY_SAMPLE_ID: sampleId } : {}),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    const exit = once(child, "exit");
    let port;
    child.on("message", (message) => {
      port = message?.port;
    });
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
        i < 100 &&
        (port === undefined || !output.includes('"event":"API_STARTED"'));
        i++
      ) {
        assert.equal(child.exitCode, null, errors);
        await delay(25);
      }
      assert.match(output, /API_STARTED/);
      assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
      assert.notEqual(port, config.server.port);
      const origin = `http://127.0.0.1:${port}`;
      assert.equal((await fetch(`${origin}/ready`)).status, 200);
      const headers = {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "localhost:3443",
        "x-owner-client": "a".repeat(64),
        origin: "https://localhost:3443",
      };
      const login = await fetch(`${origin}/api/v1/auth/login`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ role: "teacher", passphrase: testPassphrase }),
      });
      assert.equal(login.status, 200);
      headers.cookie = login.headers.get("set-cookie").split(";")[0];
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
      const history = `${origin}/api/v1/teacher-tools/history`;
      assert.equal(
        (await fetch(history, { headers })).status,
        cloud ? 200 : 404,
      );
      if (cloud) {
        const ask = (question) =>
          fetch(history, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ question }),
          });
        assert.match(
          (await (await ask("How many questions?")).json()).text,
          /^1 question recorded/,
        );
        assert.deepEqual(
          await (await ask("Summarize recent questions.")).json(),
          { text: summary },
        );
      }
      assert.equal(output.includes(config.runtimeRoot), false);
      assert.equal(output.includes(sampleQuestion), false);
      assert.equal(errors.includes(sampleQuestion), false);
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
