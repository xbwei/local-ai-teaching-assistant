import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  sha256,
  routeFiles,
  identity,
  canonicalExecutable,
  bindDiff,
  assertFreshBase,
  validateResult,
  streamValidator,
  assertNoCustomizations,
  reviewEnvironment,
  nativeArguments,
  runReview,
} from "../review/review.mjs";

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "laita-route-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function git(root, ...args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function repo(t) {
  const root = temporary(t);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Synthetic Reviewer Test");
  git(root, "config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(root, "old.txt"), "before\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD");
  fs.renameSync(path.join(root, "old.txt"), path.join(root, "new.txt"));
  fs.writeFileSync(path.join(root, "new.txt"), "after\n");
  fs.writeFileSync(path.join(root, "image.dat"), Buffer.from([0, 255, 1, 2]));
  git(root, "add", ".");
  git(root, "commit", "-qm", "candidate");
  return { root, base, head: git(root, "rev-parse", "HEAD") };
}
const artifacts = Object.fromEntries(
  routeFiles.map((name) => [name, Buffer.from(name)]),
);
const config = {
  cliSha256: "a".repeat(64),
  cliVersion: "1.5.1",
  model: "synthetic-model",
  effort: "high",
  profile: "HIGH_ASSURANCE_ANTIGRAVITY",
};
const route = () =>
  identity(config, artifacts, config.cliSha256, config.cliVersion);
test("canonical discovery resolves symlinks and only the known shim; never executes shims", (t) => {
  const root = temporary(t);
  const binary = path.join(root, "native");
  fs.writeFileSync(binary, Buffer.from([127, 69, 76, 70, 0]));
  fs.chmodSync(binary, 0o700);
  const link = path.join(root, "link");
  fs.symlinkSync(binary, link);
  assert.equal(canonicalExecutable(link).executable, binary);
  const shim = path.join(root, "shim");
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nexport XDG_CACHE_HOME="\${XDG_CACHE_HOME:-cache}"\nexec ${binary} "$@"\n`,
  );
  assert.equal(
    canonicalExecutable(shim).sha256,
    sha256(fs.readFileSync(binary)),
  );
  fs.appendFileSync(shim, "echo unexpected\n");
  assert.throws(() => canonicalExecutable(shim), /UNRECOGNIZED/);
});
test("machine-independent identity binds every artifact and CLI/model/effort", () => {
  const original = route();
  for (const name of routeFiles) {
    assert.notEqual(
      identity(
        config,
        { ...artifacts, [name]: Buffer.from("changed") },
        config.cliSha256,
        config.cliVersion,
      ).routeSha256,
      original.routeSha256,
    );
  }
  for (const key of ["model", "effort", "profile"]) {
    assert.notEqual(
      identity(
        { ...config, [key]: "changed" },
        artifacts,
        config.cliSha256,
        config.cliVersion,
      ).routeSha256,
      original.routeSha256,
    );
  }
  assert.throws(
    () => identity(config, artifacts, "b".repeat(64), config.cliVersion),
    /CLI_DRIFT/,
  );
  assert.throws(
    () => identity(config, artifacts, config.cliSha256, "changed"),
    /CLI_DRIFT/,
  );
  assert.deepEqual(route(), original);
});
test("complete binding includes deletion, addition and binary payload; rejects dirty/stale/empty/oversize", (t) => {
  const { root, base, head } = repo(t);
  const snapshot = bindDiff(root, base, head, 100000);
  assert.deepEqual(snapshot.binding.files, ["image.dat", "new.txt", "old.txt"]);
  assert.match(snapshot.diff.toString(), /GIT binary patch/);
  assert.match(snapshot.diff.toString(), /deleted file mode/);
  assert.equal(snapshot.binding.diffSha256, sha256(snapshot.diff));
  assert.equal(snapshot.binding.diffBytes, snapshot.diff.length);
  assert.throws(() => bindDiff(root, base, base, 100000), /HEAD_MISMATCH/);
  assert.throws(() => bindDiff(root, head, head, 100000), /EMPTY_OR_OVERSIZE/);
  assert.throws(() => bindDiff(root, base, head, 1), /EMPTY_OR_OVERSIZE/);
  assert.throws(() => bindDiff(root, "main", head, 100000), /FULL_COMMIT/);
  fs.writeFileSync(path.join(root, "untracked.txt"), "synthetic");
  assert.throws(() => bindDiff(root, base, head, 100000), /DIRTY/);
  fs.unlinkSync(path.join(root, "untracked.txt"));
  fs.appendFileSync(path.join(root, "new.txt"), "unstaged");
  assert.throws(() => bindDiff(root, base, head, 100000), /DIRTY/);
});
test("fresh base must match local tracking ref and live remote main", (t) => {
  const { root, base, head } = repo(t);
  git(root, "remote", "add", "origin", root);
  git(root, "branch", "main", base);
  git(root, "update-ref", "refs/remotes/origin/main", base);
  assertFreshBase(root, base);
  git(root, "branch", "-f", "main", head);
  assert.throws(() => assertFreshBase(root, base), /REMOTE_BASE_CHANGED/);
});
test("structured result rejects partial coverage, mismatched diff and unexpected fields", (t) => {
  const { root, base, head } = repo(t);
  const { binding } = bindDiff(root, base, head, 100000);
  const result = {
    binding,
    coverage: "complete",
    verdict: "PASS",
    findings: [],
  };
  assert.deepEqual(validateResult(result, binding), result);
  for (const field of [
    "base",
    "head",
    "diffSha256",
    "diffBytes",
    "files",
    "headTree",
  ]) {
    assert.throws(
      () =>
        validateResult(
          { ...result, binding: { ...binding, [field]: "changed" } },
          binding,
        ),
      /DIFF_BINDING/,
    );
  }
  assert.throws(
    () => validateResult({ ...result, coverage: "incomplete" }, binding),
    /INCONSISTENT/,
  );
  assert.throws(
    () => validateResult({ ...result, extra: true }, binding),
    /INVALID_RESULT/,
  );
  assert.throws(
    () =>
      validateResult(
        {
          ...result,
          findings: [
            { path: "not-in-diff", severity: "high", message: "synthetic" },
          ],
        },
        binding,
      ),
    /INVALID_FINDING/,
  );
});
function events(binding, verdict = "PASS") {
  const schema = JSON.parse(
    fs.readFileSync(new URL("../review/result.schema.json", import.meta.url)),
  );
  schema.properties.binding = { const: binding };
  return {
    init: {
      event: "init",
      conversation_id: "synthetic",
      init: {
        model: config.model,
        agent: "laita-restricted-reviewer",
        permission_mode: "strict",
        tools: ["view_file", "run_command"],
        json_schema: schema,
      },
    },
    result: {
      event: "result",
      result: {
        conversation_id: "synthetic",
        status: "SUCCESS",
        num_turns: 1,
        json_schema: schema,
        structured_output: {
          binding,
          coverage: verdict === "BLOCKED" ? "incomplete" : "complete",
          verdict,
          findings:
            verdict === "FINDINGS"
              ? [
                  {
                    path: binding.files[0],
                    severity: "medium",
                    message: "Synthetic defect",
                  },
                ]
              : [],
        },
      },
    },
    stream: () => streamValidator(config, binding, schema),
  };
}
test("supported init/step/result accepts PASS and adverse results without extra attestation fields", () => {
  const binding = { files: ["synthetic.txt"] };
  for (const verdict of ["PASS", "FINDINGS", "BLOCKED"]) {
    const { init, result, stream } = events(binding, verdict);
    const validator = stream();
    validator.accept(init);
    for (const step_type of ["user_input", "agent_response", "checkpoint"]) {
      validator.accept({
        event: "step_update",
        step_update: { conversation_id: "synthetic", step_type },
      });
    }
    validator.accept(result);
    assert.deepEqual(validator.finish(), {
      result: result.result.structured_output,
      reported: {
        model: config.model,
        effort: null,
        agent: "laita-restricted-reviewer",
        permissionMode: "strict",
        resultSource: "structured_output",
      },
    });
  }
  const { init, result, stream } = events(binding);
  init.init.effort = "high";
  const validator = stream();
  validator.accept(init);
  validator.accept(result);
  assert.equal(validator.finish().reported.effort, "high");
});
test("serialized native JSON results use the same schema and binding validation", () => {
  for (const field of ["response", "structured_output"]) {
    const { init, result, stream } = events({ files: ["synthetic.txt"] });
    const payload = result.result.structured_output;
    delete result.result.structured_output;
    result.result[field] = JSON.stringify(payload);
    const validator = stream();
    validator.accept(init);
    validator.accept(result);
    assert.deepEqual(validator.finish().result, payload);
    for (const value of [
      "not JSON",
      JSON.stringify({ ...payload, binding: { files: [] } }),
    ]) {
      const invalid = stream();
      invalid.accept(init);
      assert.throws(() =>
        invalid.accept({
          ...result,
          result: { ...result.result, [field]: value },
        }),
      );
    }
  }
});
test("the final streamed response is assembled by step and remains exactly bound", () => {
  const { init, result, stream } = events({ files: ["synthetic.txt"] });
  const payload = result.result.structured_output;
  delete result.result.structured_output;
  result.result.response = JSON.stringify(payload) + JSON.stringify(payload);
  for (const output of [payload, { ...payload, binding: { files: [] } }]) {
    const validator = stream();
    validator.accept(init);
    validator.accept({
      event: "step_update",
      step_update: {
        conversation_id: "synthetic",
        step_type: "agent_response",
        step_index: 1,
        state: "DONE",
        text_delta: "Earlier analysis",
      },
    });
    const json = JSON.stringify(output);
    const half = Math.floor(json.length / 2);
    for (const [state, text_delta] of [
      ["ACTIVE", json.slice(0, half)],
      ["DONE", json.slice(half)],
    ]) {
      validator.accept({
        event: "step_update",
        step_update: {
          conversation_id: "synthetic",
          step_type: "agent_response",
          step_index: 3,
          state,
          text_delta,
        },
      });
    }
    if (output === payload) {
      validator.accept(result);
      assert.deepEqual(validator.finish().result, payload);
      assert.equal(validator.finish().reported.resultSource, "agent_response");
    } else
      assert.throws(() => validator.accept(result), /DIFF_BINDING_MISMATCH/);
  }
});
test("a complete DONE response is not appended twice and an invalid snapshot cannot PASS", () => {
  const { init, result, stream } = events({ files: ["synthetic.txt"] });
  const payload = result.result.structured_output;
  delete result.result.structured_output;
  result.result.response = JSON.stringify(payload) + JSON.stringify(payload);
  for (const final of [payload, { ...payload, binding: { files: [] } }]) {
    const validator = stream();
    validator.accept(init);
    for (const [state, text] of [
      ["ACTIVE", payload],
      ["DONE", final],
    ]) {
      validator.accept({
        event: "step_update",
        step_update: {
          conversation_id: "synthetic",
          step_type: "agent_response",
          step_index: 3,
          state,
          text_delta: JSON.stringify(text),
        },
      });
    }
    if (final === payload) {
      validator.accept(result);
      assert.equal(validator.finish().result.verdict, "PASS");
    } else assert.throws(() => validator.accept(result));
  }
});
test("native turn counters do not replace exact input and result binding", () => {
  for (const num_turns of [0, 2, 17]) {
    const { init, result, stream } = events({ files: ["synthetic.txt"] });
    result.result.num_turns = num_turns;
    const validator = stream();
    validator.accept(init);
    validator.accept(result);
    assert.equal(validator.finish().result.verdict, "PASS");
  }
});
test("observed route drift, capabilities, denied attempts and conversation drift block", () => {
  const { init, stream } = events({ files: ["synthetic.txt"] });
  for (const [key, value] of [
    ["model", "other"],
    ["effort", "low"],
    ["agent", "other"],
    ["permission_mode", "always-proceed"],
    ["json_schema", {}],
  ]) {
    assert.throws(() =>
      stream().accept({ ...init, init: { ...init.init, [key]: value } }),
    );
  }
  for (const tool of [
    "view_file",
    "write_to_file",
    "run_command",
    "read_url_content",
    "call_mcp_tool",
    "load_skill",
    "invoke_plugin",
    "invoke_subagent",
    "delegate",
    "run_workflow",
  ]) {
    for (const event of [
      { event: tool },
      {
        event: "step_update",
        step_update: {
          conversation_id: "synthetic",
          step_type: "tool",
          tool_name: tool,
          tool_info: { error: "denied" },
        },
      },
      {
        event: "step_update",
        step_update: { conversation_id: "synthetic", step_type: tool },
      },
    ]) {
      const validator = stream();
      validator.accept(init);
      assert.throws(
        () => validator.accept(event),
        /CAPABILITY_OR_PROTOCOL_VIOLATION|UNKNOWN_EVENT/,
      );
    }
  }
  for (const extra of [
    { tool_info: null },
    { tool_name: "" },
    { subagent_info: {} },
    { conversation_id: "other" },
  ]) {
    const validator = stream();
    validator.accept(init);
    assert.throws(
      () =>
        validator.accept({
          event: "step_update",
          step_update: {
            conversation_id: "synthetic",
            step_type: "agent_response",
            ...extra,
          },
        }),
      /CAPABILITY_OR_PROTOCOL_VIOLATION/,
    );
  }
});
test("truncated, duplicate, out-of-order and mismatched terminal results cannot PASS", () => {
  const { init, result, stream } = events({ files: ["synthetic.txt"] });
  assert.throws(() => stream().finish(), /TRUNCATED_REVIEW/);
  assert.throws(() => stream().accept(result), /INIT_REQUIRED/);
  let validator = stream();
  validator.accept(init);
  assert.throws(() => validator.finish(), /TRUNCATED_REVIEW/);
  assert.throws(() => validator.accept(init), /UNKNOWN_EVENT/);
  validator = stream();
  validator.accept(init);
  validator.accept(result);
  assert.throws(() => validator.accept(result), /EVENT_AFTER_RESULT/);
  for (const change of [
    { conversation_id: "other" },
    { status: "ERROR" },
    { json_schema: {} },
    {
      structured_output: {
        ...result.result.structured_output,
        binding: { files: [] },
      },
    },
    {
      structured_output: {
        ...result.result.structured_output,
        coverage: "incomplete",
      },
    },
  ]) {
    validator = stream();
    validator.accept(init);
    assert.throws(() =>
      validator.accept({ ...result, result: { ...result.result, ...change } }),
    );
  }
});

test("ambient customizations and credential/provider environment injection fail closed", (t) => {
  const root = temporary(t);
  assertNoCustomizations(root);
  fs.mkdirSync(path.join(root, ".gemini/config"), { recursive: true });
  fs.writeFileSync(path.join(root, ".gemini/config/mcp_config.json"), "{}");
  assertNoCustomizations(root);
  fs.writeFileSync(path.join(root, ".gemini/config/hooks.json"), "{}");
  assert.throws(() => assertNoCustomizations(root), /AMBIENT_CUSTOMIZATION/);
  fs.unlinkSync(path.join(root, ".gemini/config/hooks.json"));
  fs.writeFileSync(
    path.join(root, ".gemini/config/mcp_config.json"),
    '{"mcpServers":{"synthetic":{}}}',
  );
  assert.throws(() => assertNoCustomizations(root), /AMBIENT_MCP/);
  assert.deepEqual(
    reviewEnvironment({
      HOME: "synthetic",
      GEMINI_API_KEY: "synthetic",
      AGY_CLI_DISABLE_AUTO_UPDATE: "false",
      UNRECOGNIZED_OVERRIDE: "1",
    }),
    { HOME: "synthetic", AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
  );
});
test("native arguments retain restrictions, exact schema and one-stream transport", () => {
  const schema = { type: "object" };
  const args = nativeArguments(config, schema, "synthetic prompt");
  for (const [flag, value] of [
    ["--model", config.model],
    ["--effort", config.effort],
    ["--agent", "laita-restricted-reviewer"],
    ["--print", "synthetic prompt"],
    ["--output-format", "stream-json"],
    ["--json-schema", JSON.stringify(schema)],
    ["--log-file", os.devNull],
  ])
    assert.equal(args[args.indexOf(flag) + 1], value);
  assert.ok(!args.includes("--input-format"));
  assert.ok(!args.includes("--mode")); // Plan is selected through settings, without slash-prefix injection.
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("--disable-slash-commands"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  const settings = JSON.parse(
    fs.readFileSync(new URL("../review/settings.json", import.meta.url)),
  );
  assert.equal(settings.agentMode, "plan");
  assert.equal(settings.toolPermission, "strict");
  assert.equal(settings.enableTerminalSandbox, true);
  assert.equal(settings.allowNonWorkspaceAccess, false);
  assert.deepEqual(settings.permissions.allow, []);
  assert.deepEqual(settings.permissions.ask, []);
  for (const capability of [
    "command",
    "read_file",
    "write_file",
    "read_url",
    "execute_url",
    "mcp",
    "unsandboxed",
  ]) {
    assert.ok(settings.permissions.deny.includes(`${capability}(*)`));
  }
});

function fakeCli(t, source) {
  const root = temporary(t);
  t.mock.method(os, "homedir", () => root);
  const executable = path.join(root, "synthetic-cli.mjs");
  fs.writeFileSync(
    executable,
    `#!${process.execPath}
import fs from "node:fs";
import {createHash} from "node:crypto";
const schema = JSON.parse(process.argv[process.argv.indexOf("--json-schema") + 1]);
const binding = schema.properties.binding.const;
const prompt = JSON.parse(process.argv[process.argv.indexOf("--print") + 1]);
const init = {event:"init",conversation_id:"synthetic",init:{model:${JSON.stringify(config.model)},agent:"laita-restricted-reviewer",permission_mode:"strict",tools:["view_file"],json_schema:schema}};
const result = {event:"result",result:{conversation_id:"synthetic",status:"SUCCESS",num_turns:1,json_schema:schema,structured_output:{binding,coverage:"complete",verdict:"PASS",findings:[]}}};
const emit = event => process.stdout.write(JSON.stringify(event)+"\\n");
${source}
`,
  );
  fs.chmodSync(executable, 0o700);
  return { root, executable };
}
function inputBinding(diff) {
  return {
    base: "a".repeat(40),
    head: "b".repeat(40),
    files: ["synthetic.txt"],
    diffBytes: diff.length,
    diffSha256: sha256(diff),
  };
}
test("transport delivers one complete UTF-8 prompt and accepts its bound structured result", async (t) => {
  const diff = Buffer.from(
    "synthetic padding 💡\n".repeat(2000) + "late synthetic marker",
  );
  const binding = inputBinding(diff);
  const { root, executable } = fakeCli(
    t,
    `
fs.writeFileSync("observed.json", JSON.stringify({messages:process.argv.filter(v=>v==="--print").length,binding:prompt.binding,policy:prompt.policy,schema:prompt.schema,bytes:Buffer.byteLength(prompt.diff),sha256:createHash("sha256").update(prompt.diff).digest("hex"),late:prompt.diff.endsWith("late synthetic marker")}));
emit(init);
emit(result);`,
  );
  const marker = path.join(root, "observed.json");
  fs.writeFileSync(
    executable,
    fs
      .readFileSync(executable, "utf8")
      .replace('"observed.json"', JSON.stringify(marker)),
  );
  const completed = await runReview(
    executable,
    { ...config, timeoutMs: 3000 },
    binding,
    diff,
    "synthetic policy",
  );
  assert.equal(completed.result.verdict, "PASS");
  assert.deepEqual(JSON.parse(fs.readFileSync(marker)), {
    messages: 1,
    binding,
    policy: "synthetic policy",
    schema: events(binding).init.init.json_schema,
    bytes: diff.length,
    sha256: sha256(diff),
    late: true,
  });
  await assert.rejects(
    runReview(
      executable,
      config,
      binding,
      diff.subarray(1),
      "synthetic policy",
    ),
    /INPUT_BINDING_MISMATCH/,
  );
});
test("only the exact literal-input notice is accepted, including split stderr chunks", async (t) => {
  const diff = Buffer.from("synthetic diff");
  const binding = inputBinding(diff);
  const notice =
    "warning: slash commands are unavailable for this run; the prompt was sent without expansion.";
  const { executable } = fakeCli(
    t,
    `
const notice = ${JSON.stringify(notice)};
process.stderr.write(notice.slice(0,20));
setTimeout(()=>{process.stderr.write(notice.slice(20)+String.fromCharCode(10));emit(init);emit(result);},10);`,
  );
  assert.equal(
    (
      await runReview(
        executable,
        { ...config, timeoutMs: 1000 },
        binding,
        diff,
        "synthetic policy",
      )
    ).result.verdict,
    "PASS",
  );
});
test("transport rejects CLI errors, incomplete output and prohibited events", async (t) => {
  const diff = Buffer.from("synthetic diff");
  const binding = inputBinding(diff);
  for (const [source, expected] of [
    [
      'init.init.model="other";emit(init);setInterval(()=>{},1000);',
      /RUNTIME_ROUTE_DRIFT/,
    ],
    [
      `process.stdout.write(${JSON.stringify("not JSON\n")});setInterval(()=>{},1000);`,
      SyntaxError,
    ],
    [
      'emit({event:"tool",tool_name:"run_command"});setInterval(()=>{},1000);',
      /INIT_REQUIRED/,
    ],
    [
      'process.stderr.write("synthetic diagnostic");setInterval(()=>{},1000);',
      /CLI_DIAGNOSTIC_REQUIRES_REVIEW/,
    ],
    ["setInterval(()=>{},1000);", /REVIEW_TIMEOUT/],
    ["emit(init);", /TRUNCATED_REVIEW/],
    [
      "emit(init);process.stdout.write(JSON.stringify(result));",
      /INCOMPLETE_REVIEW_STREAM/,
    ],
    ["emit(init);process.exitCode=2;", /INCOMPLETE_REVIEW_STREAM/],
    [
      'emit(init);emit({event:"step_update",step_update:{conversation_id:"synthetic",step_type:"tool",tool_name:"run_command"}});',
      /CAPABILITY_OR_PROTOCOL_VIOLATION/,
    ],
  ]) {
    const { executable } = fakeCli(t, source);
    await assert.rejects(
      runReview(
        executable,
        { ...config, timeoutMs: 1000 },
        binding,
        diff,
        "synthetic policy",
      ),
      expected,
    );
  }
});
