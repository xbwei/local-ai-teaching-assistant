import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { quiesceService } from "./quiesce-service.mjs";
const target = "gui/123/org.example.synthetic";
const loaded = { status: 0, stdout: "    state = running\n", stderr: "" };
const absent = {
  status: 113,
  stdout: "",
  stderr:
    'Bad request.\nCould not find service "org.example.synthetic" in domain for user gui: 123\n',
};
const success = { status: 0, stdout: "", stderr: "" };
function fixture(states, bootout = success) {
  const calls = [],
    waits = [];
  return {
    calls,
    waits,
    run(_bin, args, options) {
      calls.push(args);
      assert.equal(options.killSignal, "SIGKILL");
      assert.equal(options.timeout, args[0] === "bootout" ? 5000 : 1000);
      assert.equal(options.maxBuffer, 16384);
      assert.equal(args[1], target);
      return args[0] === "bootout"
        ? bootout
        : states.length > 1
          ? states.shift()
          : states[0];
    },
    pause(ms) {
      waits.push(ms);
    },
  };
}
test("already unloaded: no bootout or wait", () => {
  const f = fixture([absent]);
  quiesceService("/bin/launchctl", target, f);
  assert.deepEqual(f.calls, [["print", target]]);
  assert.deepEqual(f.waits, []);
});
test("delayed unload: one bootout, three loaded observations, then absence", () => {
  const f = fixture([loaded, loaded, loaded, loaded, absent]);
  quiesceService("/bin/launchctl", target, f);
  assert.deepEqual(
    f.calls.map((c) => c[0]),
    ["print", "bootout", "print", "print", "print", "print"],
  );
  assert.deepEqual(f.waits, [250, 250, 250]);
});
test("permanently loaded: exactly 20 post-bootout probes, no bootout retry", () => {
  const f = fixture([loaded]);
  assert.throws(() => quiesceService("/bin/launchctl", target, f));
  assert.equal(f.calls.filter((c) => c[0] === "print").length, 21);
  assert.equal(f.calls.filter((c) => c[0] === "bootout").length, 1);
  assert.deepEqual(f.waits, Array(19).fill(250));
});
for (const bad of [
  { ...success, status: 1 },
  { ...success, stderr: "unexpected" },
  { ...success, error: new Error("timeout") },
  { ...success, signal: "SIGKILL" },
])
  test("bootout failure never reaches success or polls", () => {
    const f = fixture([loaded, absent], bad);
    assert.throws(() => quiesceService("/bin/launchctl", target, f));
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.waits, []);
  });
for (const bad of [
  success,
  { ...absent, status: 1 },
  { ...absent, stderr: "Could not find domain" },
  { ...absent, stdout: "unexpected" },
  { ...absent, stderr: absent.stderr.replace("synthetic", "other") },
  { ...loaded, stderr: "permission denied" },
  { ...loaded, error: new Error("timeout") },
  { ...loaded, signal: "SIGKILL" },
])
  test("unknown print response fails both before and after bootout", () => {
    for (const states of [[bad], [loaded, bad]]) {
      const f = fixture(states);
      assert.throws(() => quiesceService("/bin/launchctl", target, f));
      assert.deepEqual(f.waits, []);
    }
  });
test("real hung command is killed within the observation budget; output is suppressed", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "quiescence-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mock = path.join(dir, "launchctl");
  writeFileSync(
    mock,
    `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});process.stderr.write('synthetic-private-marker');setInterval(()=>{},1000);\n`,
  );
  chmodSync(mock, 0o700);
  const start = Date.now();
  const r = spawnSync(
    process.execPath,
    ["ops/macos/quiesce-service.mjs", mock, target],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(r.status, 1);
  assert.equal(r.error, undefined);
  assert.equal(r.stdout + r.stderr, "");
  assert.ok(Date.now() - start < 4500);
});

test("caller PATH and locale cannot override the command environment", (t) => {
  const originalEnvironment = process.env;
  t.after(() => {
    process.env = originalEnvironment;
  });
  process.env = {
    ...originalEnvironment,
    PATH: "/synthetic-untrusted-bin",
    LC_ALL: "synthetic-locale",
  };
  quiesceService("/bin/launchctl", target, {
    run(_bin, _args, options) {
      assert.equal(options.env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
      assert.equal(options.env.LC_ALL, "C");
      return absent;
    },
  });
});
