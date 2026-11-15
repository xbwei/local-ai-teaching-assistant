import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  probes,
  probePrompt,
  observation,
  validateEvidence,
  syntheticDiff,
  nativeProbe,
  evidenceStatus,
} from "../review/qualify.mjs";
import { nativeArguments, sha256 } from "../review/review.mjs";
const config = { model: "synthetic-model", effort: "high" };
const schema = { type: "object" };
const init = {
  event: "init",
  init: {
    model: config.model,
    agent: "laita-restricted-reviewer",
    permission_mode: "strict",
    json_schema: schema,
    tools: ["view_file"],
  },
};
function evidence() {
  return {
    format: 1,
    status: "NOT_ESTABLISHED",
    probe: "fileRead",
    session: "synthetic-session",
    head: "a".repeat(40),
    base: "b".repeat(40),
    routeSha256: "c".repeat(64),
    harnessSha256: "d".repeat(64),
    source: "native-cli",
    established: false,
    code: "NATIVE_ENFORCEMENT_NOT_ESTABLISHED",
    observations: {
      initialized: true,
      promptSent: true,
      diagnosticPresent: false,
      exitCode: 0,
      fixtureUnchanged: true,
    },
  };
}
test("qualification uses production model, effort, restrictions and transport flags", () => {
  const args = nativeArguments(config, schema);
  for (const [flag, value] of [
    ["--model", config.model],
    ["--effort", "high"],
    ["--mode", "plan"],
    ["--input-format", "stream-json"],
    ["--output-format", "stream-json"],
  ])
    assert.equal(args[args.indexOf(flag) + 1], value);
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("--disable-slash-commands"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
});
test("native init reducer returns only inventory count and digest, rejects material drift", () => {
  assert.deepEqual(observation(init, config, schema), {
    kind: "init",
    toolCount: 1,
    toolsSha256: sha256(JSON.stringify(["view_file"])),
  });
  for (const [field, value] of [
    ["model", "other"],
    ["agent", "other"],
    ["permission_mode", "always-proceed"],
    ["json_schema", {}],
    ["tools", ["unsafe/path"]],
    ["tools", ["duplicate", "duplicate"]],
  ])
    assert.throws(() =>
      observation(
        { ...init, init: { ...init.init, [field]: value } },
        config,
        schema,
      ),
    );
});
test("tool events including errors and denied attempts never become permission proof", () => {
  for (const tool of [
    "view_file",
    "write_to_file",
    "run_command",
    "read_url_content",
    "call_mcp_tool",
    "run_workflow",
    "invoke_subagent",
  ]) {
    assert.throws(
      () =>
        observation(
          {
            event: "step_update",
            step_update: {
              step_type: "tool",
              tool_name: tool,
              tool_info: { error: { type: "denied", message: "synthetic" } },
            },
          },
          config,
          schema,
        ),
      /CAPABILITY_EVENT/,
    );
  }
  assert.throws(
    () =>
      observation(
        {
          event: "step_update",
          step_update: { step_type: "agent_response", subagent_info: {} },
        },
        config,
        schema,
      ),
    /CAPABILITY_EVENT/,
  );
  assert.throws(
    () => observation({ event: "unexpected" }, config, schema),
    /UNKNOWN_EVENT/,
  );
});
test("bounded evidence cannot claim qualification or carry native text or unsafe fields", () => {
  assert.deepEqual(validateEvidence(evidence()), evidence());
  for (const mutate of [
    (e) => (e.status = "QUALIFIED"),
    (e) => (e.established = true),
    (e) => (e.source = "mock"),
    (e) => (e.transcript = "raw"),
    (e) => (e.code = "arbitrary native error"),
    (e) => (e.observations.output = "raw"),
    (e) => (e.observations.toolCount = 201),
    (e) => (e.observations.exitCode = -1),
    (e) => (e.session = "/machine/path"),
    (e) => (e.harnessSha256 = "stale"),
  ]) {
    const e = evidence();
    mutate(e);
    assert.throws(() => validateEvidence(e));
  }
});
test("all negative challenges have fixed harmless targets without user-supplied expansion", () => {
  for (const probe of [
    "fileRead",
    "fileWrite",
    "shell",
    "network",
    "mcp",
    "skills",
    "delegation",
    "agentLoading",
  ]) {
    assert.ok(probes.includes(probe));
    assert.match(probePrompt(probe), /Never seek permission/);
  }
  assert.match(probePrompt("network"), /127\.0\.0\.1:1/);
  assert.match(probePrompt("mcp"), /nonexistent/);
  assert.throws(() => probePrompt("custom-command"));
});
test("synthetic transport includes a long complete diff, binary patch, deletion and late defect", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "laita-qualification-test-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const snapshot = syntheticDiff(directory);
  assert.ok(snapshot.binding.diffBytes > 250000);
  assert.equal(snapshot.binding.diffSha256, sha256(snapshot.diff));
  assert.deepEqual(snapshot.binding.files, [
    "a-large.txt",
    "binary.dat",
    "removed.txt",
    "z-late.txt",
  ]);
  assert.match(snapshot.diff.toString(), /GIT binary patch/);
  assert.match(snapshot.diff.toString(), /deleted file mode/);
  assert.ok(
    snapshot.diff.toString().indexOf("isPositive = n => n < 0") > 250000,
  );
});

test("mock native diagnostics are bounded and never become model or effort attestations", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "laita-mock-probe-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "mock-native");
  fs.writeFileSync(
    executable,
    "#!/usr/bin/env node\nprocess.stdout.write('synthetic-model effort high');\n",
  );
  fs.chmodSync(executable, 0o700);
  const result = await nativeProbe(
    { executable, config: { ...config, timeoutMs: 1000 } },
    "modelEffort",
    directory,
    { binding: { files: [] } },
  );
  assert.equal(result.code, "NATIVE_DIAGNOSTIC_NOT_ATTESTATION");
  assert.equal(result.observations.promptSent, false);
  assert.equal(result.observations.nativeModelMentioned, true);
  assert.equal(result.observations.nativeEffortMentioned, true);
  assert.equal(result.observations.fixtureUnchanged, true);
});
test("mock native unknown diagnostics abort without emitting raw errors or sending a prompt", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "laita-mock-probe-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "mock-native");
  fs.writeFileSync(
    executable,
    "#!/usr/bin/env node\nprocess.stderr.write('DO_NOT_PUBLISH_NATIVE_TEXT');\nsetInterval(()=>{},1000);\n",
  );
  fs.chmodSync(executable, 0o700);
  const result = await nativeProbe(
    { executable, config: { ...config, timeoutMs: 1000 } },
    "fileRead",
    directory,
    { binding: { files: [] } },
  );
  assert.equal(result.code, "NATIVE_DIAGNOSTIC_REQUIRES_REVIEW");
  assert.equal(result.observations.promptSent, false);
  assert.equal(
    JSON.stringify(result).includes("DO_NOT_PUBLISH_NATIVE_TEXT"),
    false,
  );
});

test("mock failed diagnostics block all diagnostic probes without identity hints", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "laita-mock-exit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "mock-native");
  fs.writeFileSync(
    executable,
    "#!/usr/bin/env node\nprocess.stdout.write('synthetic-model effort high');\nprocess.exitCode = 2;\n",
  );
  fs.chmodSync(executable, 0o700);
  for (const probe of ["modelEffort", "invalidModel", "invalidEffort"]) {
    const result = await nativeProbe(
      { executable, config: { ...config, timeoutMs: 1000 } },
      probe,
      directory,
      { binding: { files: [] } },
    );
    assert.equal(result.observations.exitCode, 2);
    assert.equal(result.code, "NATIVE_EXIT_FAILED");
    assert.equal(evidenceStatus(result.code), "BLOCKED");
    assert.equal(
      Object.hasOwn(result.observations, "nativeModelMentioned"),
      false,
    );
    assert.equal(
      Object.hasOwn(result.observations, "nativeEffortMentioned"),
      false,
    );
    assert.equal(result.observations.promptSent, false);
    validateEvidence({
      ...evidence(),
      probe,
      ...result,
      status: evidenceStatus(result.code),
    });
  }
});
test("mock signal-terminated diagnostic blocks when exit code is null", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "laita-mock-signal-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "mock-native");
  fs.writeFileSync(
    executable,
    "#!/usr/bin/env node\nprocess.kill(process.pid, 'SIGTERM');\n",
  );
  fs.chmodSync(executable, 0o700);
  const result = await nativeProbe(
    { executable, config: { ...config, timeoutMs: 1000 } },
    "modelEffort",
    directory,
    { binding: { files: [] } },
  );
  assert.equal(result.observations.exitCode, null);
  assert.equal(result.code, "NATIVE_EXIT_FAILED");
  assert.equal(evidenceStatus(result.code), "BLOCKED");
  validateEvidence({
    ...evidence(),
    probe: "modelEffort",
    ...result,
    status: evidenceStatus(result.code),
  });
});
