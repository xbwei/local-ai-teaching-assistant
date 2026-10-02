import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

for (const entry of ["../src/main.ts", "../dist/main.js"])
  for (const failure of ["bind", "throw"])
    for (const keepalive of [false, true])
      test(`${entry} fatal ${failure} drains cleanup and exits nonzero${keepalive ? " despite a referenced handle" : " naturally"}`, async (t) => {
        const root = realpathSync(
          mkdtempSync(path.join(tmpdir(), "laita-startup-failure-")),
        );
        chmodSync(root, 0o700);
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const held = createServer().listen(0, "127.0.0.1");
        await once(held, "listening");
        t.after(async () => {
          const closed = once(held, "close");
          held.close();
          await closed;
        });
        const config = JSON.parse(
          readFileSync(
            new URL(
              "../../../packages/runtime/examples/local-only.example.json",
              import.meta.url,
            ),
          ),
        );
        config.runtimeRoot = path.join(root, "runtime");
        config.server.port = held.address().port;
        const marker = path.join(root, "closed.txt");
        const speechRoot = path.join(config.runtimeRoot, "tmp", "speech");
        const preload = path.join(root, "synthetic-handles.mjs");
        writeFileSync(
          preload,
          `
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import express from ${JSON.stringify(import.meta.resolve("express"))};
const close=DatabaseSync.prototype.close;
DatabaseSync.prototype.close=function(){const result=close.call(this);writeFileSync(${JSON.stringify(marker)},String(this.isOpen));return result;};
${keepalive ? "setInterval(()=>{},1000);" : ""}
const application=express.application;
const listen=application.listen;
application.listen=function(...args){
 const media=path.join(${JSON.stringify(speechRoot)},'synthetic-stale');
 mkdirSync(media,{mode:0o700});writeFileSync(path.join(media,'synthetic.wav'),Buffer.alloc(44),{mode:0o600});
 ${failure === "throw" ? "throw new Error('Synthetic startup failure');" : "return listen.apply(this,args);"}
};
`,
          { mode: 0o600 },
        );
        const started = performance.now();
        const result = spawnSync(
          process.execPath,
          ["--import", preload, new URL(entry, import.meta.url).pathname],
          {
            env: { APP_CONFIG_JSON: JSON.stringify(config) },
            encoding: "utf8",
            timeout: 5000,
          },
        );
        assert.equal(
          result.error,
          undefined,
          "fatal startup must not remain alive",
        );
        assert.equal(
          result.status,
          1,
          "process manager must observe a failed exit",
        );
        assert.equal(result.signal, null);
        assert.ok(performance.now() - started < 4500);
        assert.equal(
          readFileSync(marker, "utf8"),
          "false",
          "SQLite must close before exit",
        );
        assert.equal(result.stdout, "");
        assert.deepEqual(
          readdirSync(speechRoot),
          [],
          "temporary speech artifacts must be removed before exit",
        );
        const lines = result.stderr.trim().split("\n");
        assert.equal(lines.length, 1);
        const event = JSON.parse(lines[0]);
        assert.equal(event.event, "API_STARTUP_FAILED");
        assert.equal(event.code, "SERVICE_UNAVAILABLE");
        assert.doesNotMatch(
          result.stderr,
          /EADDRINUSE|Synthetic startup failure|stack|runtimeRoot/,
        );
      });
