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
  assertQualified,
  assertFreshBase,
  validateResult,
  streamValidator,
  assertNoCustomizations,
  reviewEnvironment,
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
function qualified() {
  return {
    format: 1,
    status: "QUALIFIED",
    routeSha256: route().routeSha256,
    authority:
      "https://github.com/xbwei/local-ai-teaching-assistant/issues/67#issuecomment-1",
    sessions: [1, 2].map((n) => ({
      id: `synthetic-session-${n}`,
      evidence: `https://github.com/xbwei/local-ai-teaching-assistant/issues/67#issuecomment-${n + 1}`,
      coverage: [
        "fileRead",
        "fileWrite",
        "shell",
        "network",
        "mcp",
        "skills",
        "delegation",
        "modelEffort",
        "completeDiff",
        "drift",
      ],
    })),
    expectedTools: [],
  };
}
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
test("qualification is mandatory, route-bound, and requires two distinct complete session records", () => {
  assertQualified(qualified(), route());
  for (const mutate of [
    (q) => {
      q.status = "UNQUALIFIED";
    },
    (q) => {
      q.routeSha256 = "0".repeat(64);
    },
    (q) => {
      q.sessions.pop();
    },
    (q) => {
      q.sessions[1].id = q.sessions[0].id;
    },
    (q) => {
      q.sessions[1].evidence = q.sessions[0].evidence;
    },
    (q) => {
      q.sessions[0].coverage.pop();
    },
    (q) => {
      q.authority = "";
    },
  ]) {
    const record = qualified();
    mutate(record);
    assert.throws(() => assertQualified(record, route()));
  }
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
test("mock stream rejects tools (including denied attempts), delegation, drift, duplicate or truncated output", () => {
  const binding = { files: ["synthetic.txt"] };
  const schema = { type: "object" };
  const init = {
    event: "init",
    conversation_id: "synthetic",
    init: {
      model: config.model,
      agent: "laita-restricted-reviewer",
      permission_mode: "strict",
      tools: [],
      json_schema: schema,
    },
  };
  const result = {
    event: "result",
    result: {
      conversation_id: "synthetic",
      status: "SUCCESS",
      num_turns: 1,
      json_schema: schema,
      structured_output: {
        binding,
        coverage: "complete",
        verdict: "PASS",
        findings: [],
      },
    },
  };
  const stream = () => streamValidator(config, qualified(), binding, schema);
  let validator = stream();
  validator.accept(init);
  validator.accept(result);
  assert.equal(validator.finish().verdict, "PASS");
  assert.throws(() => validator.accept(result), /EVENT_AFTER/);
  for (const tool of [
    "view_file",
    "write_to_file",
    "run_command",
    "read_url_content",
    "call_mcp_tool",
    "invoke_subagent",
    "run_workflow",
  ]) {
    validator = stream();
    validator.accept(init);
    assert.throws(
      () =>
        validator.accept({
          event: "step_update",
          step_update: {
            conversation_id: "synthetic",
            step_type: "tool",
            tool_name: tool,
            tool_info: { error: "denied" },
          },
        }),
      /CAPABILITY/,
    );
  }
  for (const [key, value] of [
    ["model", "other"],
    ["agent", "other"],
    ["permission_mode", "always-proceed"],
    ["tools", ["view_file"]],
    ["json_schema", {}],
  ]) {
    assert.throws(() =>
      stream().accept({ ...init, init: { ...init.init, [key]: value } }),
    );
  }
  validator = stream();
  validator.accept(init);
  assert.throws(() => validator.finish(), /TRUNCATED/);
  assert.throws(() => stream().accept(result), /INIT_REQUIRED/);
  assert.throws(() => validator.accept({ event: "unknown" }), /UNKNOWN_EVENT/);
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
test("shipped bootstrap qualification cannot authorize a production review", () => {
  const record = JSON.parse(
    fs.readFileSync(new URL("../review/qualification.json", import.meta.url)),
  );
  assert.equal(record.status, "UNQUALIFIED");
  assert.throws(() => assertQualified(record, route()), /ROUTE_UNQUALIFIED/);
});
