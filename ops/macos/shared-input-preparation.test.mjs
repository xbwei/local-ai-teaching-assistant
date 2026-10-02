import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  truncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  prepareInstructor,
  prepareStt,
  protectedAssetPath,
  sttIdentity,
  sttSource,
  sttModelBytes,
  sttModelSha256,
} from "./shared-input-preparation.mjs";
const repository = process.cwd();
const helper = path.join(repository, "ops/macos/prepare-provider-config.mjs");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (file, value) =>
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
function fixture(t, parent = tmpdir()) {
  const root = realpathSync(
    mkdtempSync(path.join(parent, ".synthetic-preparation-")),
  );
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = JSON.parse(
    readFileSync(
      path.join(repository, "ops/macos/application-config.json.template"),
      "utf8",
    ).replace("__OPERATOR_ABSOLUTE_RUNTIME_ROOT__", path.join(root, "runtime")),
  );
  config.provenance = {
    demoProfileVersion: "demo-profile.v2",
    policyVersion: "demo-policy.v2",
  };
  config.runtime.operationTimeoutMs = 30000;
  config.features.openai = true;
  config.features.compare = true;
  config.providers.openai.secretReference = {
    kind: "opaque",
    id: "synthetic-reference",
  };
  config.access.enabled = true;
  config.access.publicOrigin = "https://private-sentinel.example.invalid";
  config.access.credentials = [
    {
      id: "expired-instructor",
      role: "instructor",
      courseScopes: ["course-synthetic-demo"],
      tokenSha256: "1".repeat(64),
      expiresAtEpochSeconds: 1000000000,
      revoked: true,
    },
  ];
  config.access.adminCredentials = [
    {
      id: "separate-admin",
      tokenSha256: "2".repeat(64),
      expiresAtEpochSeconds: 2000000000,
      revoked: false,
    },
  ];
  const source = path.join(root, "source.json");
  const destination = path.join(root, "candidate.json");
  save(source, config);
  const run = (command, args, env = {}) =>
    spawnSync(process.execPath, [helper, command, ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: "", ...env },
    });
  const configArgs = () => [
    repository,
    source,
    destination,
    config.runtimeRoot,
    "3100",
  ];
  return { root, config, source, destination, run, configArgs };
}
function denied(result) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "PROVIDER_PREPARATION_ERROR=SHARED_INPUT_PREPARATION_FAILED\n",
  );
}
function v4(f) {
  f.config.provenance = {
    demoProfileVersion: "demo-profile.v4",
    policyVersion: "demo-policy.v4",
  };
  f.config.features.speech = true;
  save(f.source, f.config);
}
function credentialRequest(f) {
  const now = Math.floor(Date.now() / 1000);
  return {
    contractVersion: "instructor-preparation.v1",
    expectedConfigurationSha256: digest(readFileSync(f.source)),
    expectedCredential: structuredClone(f.config.access.credentials[0]),
    provisionedAtEpochSeconds: now,
    credential: {
      id: "instructor-operational-001",
      role: "instructor",
      courseScopes: ["course-synthetic-demo"],
      tokenSha256: "3".repeat(64),
      expiresAtEpochSeconds: now + 2592000,
      revoked: false,
    },
  };
}
test("current PROVIDER_ENABLED source changes exactly provenance and speech; original bytes and independent fields survive", (t) => {
  const f = fixture(t);
  const original = readFileSync(f.source);
  const result = f.run("shared-input-config", f.configArgs());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "SHARED_INPUT_CONFIG_PREPARED\n");
  assert.equal(result.stderr, "");
  const expected = structuredClone(f.config);
  expected.provenance = {
    demoProfileVersion: "demo-profile.v4",
    policyVersion: "demo-policy.v4",
  };
  expected.features.speech = true;
  assert.deepEqual(JSON.parse(readFileSync(f.destination)), expected);
  assert.deepEqual(readFileSync(f.source), original);
  assert.equal(lstatSync(f.destination).mode & 0o7777, 0o600);
});
test("v2 speech, provenance/provider/model/access/reference drift and duplicate JSON keys fail closed", (t) => {
  for (const change of [
    (c) => (c.features.speech = true),
    (c) => (c.provenance.demoProfileVersion = "demo-profile.v4"),
    (c) => (c.provenance.policyVersion = "demo-policy.v4"),
    (c) => (c.features.openai = false),
    (c) => (c.features.compare = false),
    (c) => (c.features.kiosk = true),
    (c) => (c.features.courseGrounding = true),
    (c) => (c.features.ownerDemoWeb = true),
    (c) => (c.providers.local.model = "unknown"),
    (c) => c.providers.local.candidates.reverse(),
    (c) => (c.providers.openai.model = "unknown"),
    (c) => (c.providers.openai.secretReference = null),
    (c) =>
      (c.providers.openai.secretReference = {
        kind: "raw",
        id: "private-sentinel",
      }),
    (c) =>
      (c.providers.openai.endpoint =
        "https://private-sentinel.example.invalid"),
    (c) => (c.access.enabled = false),
    (c) => (c.access.requireForwardedHttps = false),
    (c) => (c.access.publicOrigin = "http://private-sentinel.example.invalid"),
    (c) => (c.runtime.fallback = true),
  ]) {
    const f = fixture(t);
    change(f.config);
    save(f.source, f.config);
    const before = readFileSync(f.source);
    denied(f.run("shared-input-config", f.configArgs()));
    assert.deepEqual(readFileSync(f.source), before);
    assert.equal(readdirSync(f.root).includes("candidate.json"), false);
  }
  const f = fixture(t);
  writeFileSync(
    f.source,
    readFileSync(f.source, "utf8").replace(
      '"speech":false',
      '"speech":true,"speech":false',
    ),
  );
  denied(f.run("shared-input-config", f.configArgs()));
});
test("unsafe and noncanonical destinations, source alias and interrupted writes retain prior artifact", (t) => {
  for (const kind of [
    "symlink",
    "hardlink",
    "mode",
    "special-mode",
    "parent",
    "dot",
    "same",
    "directory",
    "interrupt",
  ]) {
    const f = fixture(t);
    save(f.destination, f.config);
    const previous = readFileSync(f.destination);
    const args = f.configArgs();
    if (kind === "symlink" || kind === "hardlink") {
      rmSync(f.destination);
      (kind === "symlink" ? symlinkSync : linkSync)(f.source, f.destination);
    }
    if (kind === "mode") chmodSync(f.destination, 0o644);
    if (kind === "special-mode") chmodSync(f.destination, 0o4600);
    if (kind === "parent") chmodSync(f.root, 0o755);
    if (kind === "dot") args[2] = `${f.root}/./candidate.json`;
    if (kind === "same") args[2] = f.source;
    if (kind === "directory") {
      rmSync(f.destination);
      mkdirSync(f.destination);
    }
    denied(
      f.run(
        "shared-input-config",
        args,
        kind === "interrupt"
          ? {
              LAITA_OPERATIONS_TESTING: "1",
              LAITA_TEST_FAIL_PROVIDER_BEFORE_RENAME: "1",
            }
          : {},
      ),
    );
    if (kind !== "directory")
      assert.deepEqual(readFileSync(f.destination), previous);
    assert.equal(
      readdirSync(f.root).some((x) => x.includes(".partial-")),
      false,
    );
  }
});
test("verifier replacement and insertion preserve independent admin/access; source untouched and fixed output", (t) => {
  for (const insert of [false, true]) {
    const f = fixture(t);
    v4(f);
    if (insert) {
      f.config.access.credentials = [
        {
          ...f.config.access.credentials[0],
          id: "unrelated-kiosk",
          role: "kiosk",
        },
      ];
      save(f.source, f.config);
    }
    const request = credentialRequest(f);
    if (insert) request.expectedCredential = null;
    else
      request.expectedCredential = Object.fromEntries(
        Object.entries(request.expectedCredential).reverse(),
      );
    const file = path.join(f.root, "request.json");
    save(file, request);
    const before = readFileSync(f.source);
    const result = f.run("instructor-verifier", [...f.configArgs(), file]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "INSTRUCTOR_VERIFIER_PREPARED\n");
    assert.equal(result.stderr, "");
    const expected = structuredClone(f.config);
    expected.access.credentials = insert
      ? [...f.config.access.credentials, request.credential]
      : [request.credential];
    assert.deepEqual(JSON.parse(readFileSync(f.destination)), expected);
    assert.deepEqual(readFileSync(f.source), before);
  }
});
function legacyInstructorFixture(t, revoked = true) {
  const f = fixture(t);
  v4(f);
  Object.assign(f.config.access.credentials[0], {
    id: "instructor-operational-000",
    courseScopes: ["course-legacy-demo"],
    revoked,
    expiresAtEpochSeconds:
      Math.floor(Date.now() / 1000) + (revoked ? 3600 : -1),
  });
  f.config.access.credentials.push({
    id: "instructor-operational-002",
    role: "kiosk",
    courseScopes: ["course-unrelated-demo"],
    tokenSha256: "5".repeat(64),
    expiresAtEpochSeconds: 2000000000,
    revoked: false,
  });
  save(f.source, f.config);
  return f;
}
for (const revoked of [true, false]) {
  test(`exact replacement of ${revoked ? "revoked" : "expired non-revoked"} legacy scope preserves source, admin and unrelated records`, (t) => {
    const f = legacyInstructorFixture(t, revoked);
    const request = credentialRequest(f);
    request.expectedCredential = Object.fromEntries(
      Object.entries(request.expectedCredential).reverse(),
    );
    const file = path.join(f.root, "request.json");
    save(file, request);
    const before = readFileSync(f.source);
    const result = f.run("instructor-verifier", [...f.configArgs(), file]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "INSTRUCTOR_VERIFIER_PREPARED\n");
    assert.equal(result.stderr, "");
    const expected = structuredClone(f.config);
    expected.access.credentials[0] = request.credential;
    assert.deepEqual(JSON.parse(readFileSync(f.destination)), expected);
    assert.deepEqual(readFileSync(f.source), before);
    assert.equal(lstatSync(f.destination).mode & 0o7777, 0o600);
  });
}
test("legacy replacement retains source validation, exact-state and new authority guards", (t) => {
  const cases = [
    [
      "active instructor",
      (f) => (f.config.access.credentials[0].revoked = false),
    ],
    [
      "multiple instructors",
      (f) =>
        f.config.access.credentials.push({
          ...f.config.access.credentials[0],
          id: "another-instructor",
          tokenSha256: "6".repeat(64),
        }),
    ],
    ["wrong old role", (f) => (f.config.access.credentials[0].role = "kiosk")],
    [
      "schema-invalid old scope",
      (f) => (f.config.access.credentials[0].courseScopes = ["invalid scope"]),
    ],
    [
      "unknown old field",
      (f) => (f.config.access.credentials[0].unknown = true),
    ],
    [
      "stale expected scope",
      null,
      (r) => (r.expectedCredential.courseScopes = ["course-stale-demo"]),
    ],
    [
      "stale expected verifier",
      null,
      (r) => (r.expectedCredential.tokenSha256 = "7".repeat(64)),
    ],
    [
      "unknown expected field",
      null,
      (r) => (r.expectedCredential.unknown = true),
    ],
    [
      "widened replacement scope",
      null,
      (r) => r.credential.courseScopes.push("course-legacy-demo"),
    ],
    ["wrong replacement role", null, (r) => (r.credential.role = "kiosk")],
    [
      "invalid replacement ID",
      null,
      (r) => (r.credential.id = "instructor-operational-1"),
    ],
    ["reused old ID", null, (r) => (r.credential.id = r.expectedCredential.id)],
    [
      "reused old verifier",
      null,
      (r) => (r.credential.tokenSha256 = r.expectedCredential.tokenSha256),
    ],
    [
      "reused unrelated ID",
      null,
      (r) => (r.credential.id = "instructor-operational-002"),
    ],
    [
      "reused unrelated verifier",
      null,
      (r) => (r.credential.tokenSha256 = "5".repeat(64)),
    ],
    [
      "reused admin verifier",
      null,
      (r) => (r.credential.tokenSha256 = "2".repeat(64)),
    ],
    ["short lifetime", null, (r) => r.credential.expiresAtEpochSeconds--],
    ["extended lifetime", null, (r) => r.credential.expiresAtEpochSeconds++],
    [
      "raw bearer",
      null,
      (r) => (r.credential.rawBearer = "synthetic-sentinel"),
    ],
    ["unknown request field", null, (r) => (r.unknown = true)],
    [
      "admin state drift",
      null,
      (_r, f) => (f.config.access.adminCredentials[0].revoked = true),
    ],
    [
      "unrelated state drift",
      null,
      (_r, f) => (f.config.access.credentials[1].revoked = true),
    ],
  ];
  for (const [name, changeSource, changeRequest] of cases) {
    const f = legacyInstructorFixture(t);
    changeSource?.(f);
    save(f.source, f.config);
    const request = credentialRequest(f);
    changeRequest?.(request, f);
    save(f.source, f.config);
    const file = path.join(f.root, "request.json");
    save(file, request);
    const before = readFileSync(f.source);
    const result = f.run("instructor-verifier", [...f.configArgs(), file]);
    assert.equal(result.status, 1, name);
    denied(result);
    assert.deepEqual(readFileSync(f.source), before, name);
    assert.equal(readdirSync(f.root).includes("candidate.json"), false, name);
    assert.equal(
      readdirSync(f.root).some((entry) => entry.includes(".partial-")),
      false,
      name,
    );
  }
});
test("closed verifier input rejects authority/identity/lifetime/reuse and stale or ambiguous state", (t) => {
  for (const change of [
    (r) => (r.credential.role = "admin"),
    (r) => r.credential.courseScopes.push("other-course"),
    (r) => (r.credential.tokenSha256 = "A".repeat(64)),
    (r) => (r.credential.id = "person@example.invalid"),
    (r) => (r.credential.id = "instructor-alice"),
    (r) => r.credential.expiresAtEpochSeconds--,
    (r) => r.credential.expiresAtEpochSeconds++,
    (r) => (r.credential.expiresAtEpochSeconds = 1),
    (r) => (r.provisionedAtEpochSeconds += 3600),
    (r) => (r.credential.revoked = true),
    (r) => (r.credential.rawBearer = "private-sentinel"),
    (r) => (r.expectedConfigurationSha256 = "0".repeat(64)),
    (r) => (r.expectedCredential.tokenSha256 = "4".repeat(64)),
    (r) => (r.expectedCredential = null),
    (r) => (r.credential.id = r.expectedCredential.id),
    (r) => (r.credential.tokenSha256 = r.expectedCredential.tokenSha256),
    (r) => (r.credential.tokenSha256 = "2".repeat(64)),
  ]) {
    const f = fixture(t);
    v4(f);
    const request = credentialRequest(f);
    change(request);
    const file = path.join(f.root, "request.json");
    save(file, request);
    denied(f.run("instructor-verifier", [...f.configArgs(), file]));
  }
  for (const change of [
    (c) =>
      c.access.credentials.push({
        ...c.access.credentials[0],
        id: "other-instructor",
        tokenSha256: "5".repeat(64),
      }),
    (c) => {
      c.access.credentials[0].revoked = false;
      c.access.credentials[0].expiresAtEpochSeconds = 2000000000;
    },
  ]) {
    const f = fixture(t);
    v4(f);
    change(f.config);
    save(f.source, f.config);
    const request = credentialRequest(f);
    assert.throws(() =>
      prepareInstructor(f.config, request, request.provisionedAtEpochSeconds),
    );
  }
});
function sttRequest(f) {
  return {
    contractVersion: "stt-preparation.v1",
    sourceCommit: sttSource,
    identity: sttIdentity,
    binary: path.join(f.root, "whisper-cli"),
    binarySha256: "a".repeat(64),
    model: path.join(f.root, "ggml-small.bin"),
    modelSha256: sttModelSha256,
    modelBytes: sttModelBytes,
  };
}
test("STT prepares only exact runner profile with explicitly unverified assets; verify fails without installed assets", (t) => {
  // Runtime STT disallows writable ancestors, including /tmp. Use a disposable
  // owner-only HOME directory on both macOS and CI, never an installed asset.
  const f = fixture(t, homedir());
  const request = sttRequest(f);
  const file = path.join(f.root, "request.json");
  save(file, request);
  const output = path.join(f.root, "stt-profile.json");
  const result = f.run("stt-profile", [file, output]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "STT_PROFILE_PREPARED_ASSETS_NOT_VERIFIED\n");
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(readFileSync(output)), {
    identity: sttIdentity,
    binary: request.binary,
    binarySha256: request.binarySha256,
    model: request.model,
  });
  assert.equal(lstatSync(output).mode & 0o7777, 0o600);
  denied(f.run("verify-stt-profile", [repository, output]));
  writeFileSync(request.binary, "synthetic executable bytes", { mode: 0o700 });
  writeFileSync(request.model, "synthetic model bytes", { mode: 0o600 });
  assert.doesNotThrow(() => prepareStt(request));
  denied(f.run("verify-stt-profile", [repository, output]));
});
test("active small contract agrees with runtime and rejects wrong actual size and old identities", async (t) => {
  const { loadWhisperAdapter, whisperIdentity } =
    await import("../../packages/speech-client/dist/whisper.js");
  assert.equal(sttIdentity, "whisper.cpp/1.8.3/small-multilingual/ggml-f16");
  assert.equal(whisperIdentity, sttIdentity);
  assert.equal(sttModelBytes, 487601967);
  assert.equal(
    sttModelSha256,
    "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
  );
  const f = fixture(t, homedir());
  const request = sttRequest(f);
  const binary = Buffer.from("synthetic never executed");
  writeFileSync(request.binary, binary, { mode: 0o700 });
  writeFileSync(request.model, "", { mode: 0o600 });
  const profile = path.join(f.root, "stt-profile.json");
  const config = {
    identity: sttIdentity,
    binary: request.binary,
    binarySha256: digest(binary),
    model: request.model,
  };
  save(profile, config);
  // Sparse synthetic files exercise exact size without installing any weights.
  for (const bytes of [
    77691713,
    487614201,
    sttModelBytes - 1,
    sttModelBytes + 1,
  ]) {
    truncateSync(request.model, bytes);
    assert.throws(() => loadWhisperAdapter(profile));
    denied(f.run("verify-stt-profile", [repository, profile]));
  }
  for (const identity of [
    "whisper.cpp/1.8.3/tiny-multilingual/ggml-f16",
    "whisper.cpp/1.8.3/small.en/ggml-f16",
  ]) {
    save(profile, { ...config, identity });
    assert.throws(() => loadWhisperAdapter(profile));
  }
});

test("STT exact manifest rejects substitution, remote/FFmpeg, hashes, sizes, paths and links", (t) => {
  const f = fixture(t, homedir());
  const valid = sttRequest(f);
  for (const change of [
    (r) => (r.identity += "/other"),
    (r) =>
      Object.assign(r, {
        identity: "whisper.cpp/1.8.3/tiny-multilingual/ggml-f16",
        modelBytes: 77691713,
        modelSha256:
          "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
      }),
    (r) =>
      Object.assign(r, {
        identity: "whisper.cpp/1.8.3/small.en/ggml-f16",
        modelBytes: 487614201,
        modelSha256:
          "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
      }),
    (r) => (r.sourceCommit = "0".repeat(40)),
    (r) => r.modelBytes--,
    (r) => (r.modelSha256 = "0".repeat(64)),
    (r) => (r.binarySha256 = "A".repeat(64)),
    (r) => (r.ffmpeg = "/bin/ffmpeg"),
    (r) => (r.binary = "https://remote.invalid/stt"),
    (r) => (r.model = r.binary),
    (r) => (r.model = `${f.root}/../ggml-small.bin`),
  ]) {
    const r = structuredClone(valid);
    change(r);
    assert.throws(() => prepareStt(r));
  }
  for (const kind of ["mode", "symlink", "hardlink", "directory"]) {
    const r = structuredClone(valid);
    const target = path.join(f.root, `asset-${kind}`);
    writeFileSync(target, "synthetic", { mode: 0o600 });
    r.model = target;
    if (kind === "mode") chmodSync(target, 0o644);
    if (kind === "directory") {
      rmSync(target);
      mkdirSync(target);
    }
    if (kind === "symlink" || kind === "hardlink") {
      r.model = `${target}-alias`;
      (kind === "symlink" ? symlinkSync : linkSync)(target, r.model);
    }
    assert.throws(() => prepareStt(r));
  }
  assert.throws(() =>
    protectedAssetPath(
      path.join(tmpdir(), "absent-synthetic-model"),
      0o600,
      true,
    ),
  );
});

test("synthetic ownership mismatch is rejected without touching file ownership", (t) => {
  const f = fixture(t);
  const program = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.lstatSync;
    fs.lstatSync = (file, ...args) => {
      const result = original(file, ...args);
      if (file === ${JSON.stringify(f.source)}) result.uid += 1;
      return result;
    };
    syncBuiltinESMExports();
    process.argv = [process.execPath, ${JSON.stringify(helper)}, 'shared-input-config', ...${JSON.stringify(f.configArgs())}];
    await import(${JSON.stringify(helper)});
  `;
  denied(
    spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8",
    }),
  );
});

test("installed STT verification uses real loader hash checks; synthetic hash seam proves success without native execution", (t) => {
  const f = fixture(t, homedir());
  const request = sttRequest(f);
  const binary = Buffer.from("synthetic non-executable STT fixture");
  request.binarySha256 = digest(binary);
  writeFileSync(request.binary, binary, { mode: 0o700 });
  // Not a model. Never executed. Exact size exercises the real bounded loader.
  writeFileSync(request.model, "", { mode: 0o600 });
  truncateSync(request.model, sttModelBytes);
  const file = path.join(f.root, "request.json");
  save(file, request);
  const profile = path.join(f.root, "stt-profile.json");
  assert.equal(f.run("stt-profile", [file, profile]).status, 0);
  // Real hashing must reject these bytes despite their approved size/metadata.
  denied(f.run("verify-stt-profile", [repository, profile]));
  const program = `
    import crypto from 'node:crypto';
    import { syncBuiltinESMExports } from 'node:module';
    const original = crypto.createHash;
    let modelChecks = 0;
    crypto.createHash = (...args) => {
      const hash = original(...args);
      const update = hash.update.bind(hash);
      const digest = hash.digest.bind(hash);
      let modelFixture = false;
      hash.update = (bytes, ...rest) => {
        modelFixture = Buffer.isBuffer(bytes) && bytes.length === ${sttModelBytes} && bytes.every(b => b === 0);
        update(bytes, ...rest); return hash;
      };
      hash.digest = (...args) => {
        if (modelFixture) { modelChecks++; return ${JSON.stringify(sttModelSha256)}; }
        return digest(...args);
      };
      return hash;
    };
    syncBuiltinESMExports();
    process.argv = [process.execPath, ${JSON.stringify(helper)}, 'verify-stt-profile', ${JSON.stringify(repository)}, ${JSON.stringify(profile)}];
    await import(${JSON.stringify(helper)});
    if (modelChecks !== 1) process.exit(19);
  `;
  const accepted = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", program],
    { encoding: "utf8" },
  );
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, "STT_PROFILE_ASSETS_VERIFIED\n");
  assert.equal(accepted.stderr, "");
  // A binary mismatch remains rejected even when only model digest is mocked.
  save(profile, {
    ...JSON.parse(readFileSync(profile)),
    binarySha256: "0".repeat(64),
  });
  denied(
    spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8",
    }),
  );
});

test("owner-config removes only retired v3 settings, preserves original and rejects unrelated drift", (t) => {
  for (const mutation of [
    null,
    (c) => (c.access.requireForwardedHttps = false),
    (c) => (c.features.courseGrounding = true),
    (c) => (c.access.browserSessions.extra = true),
    (c) => (c.providers.local.model = "unapproved"),
  ]) {
    const f = fixture(t);
    f.config.provenance = {
      demoProfileVersion: "demo-profile.v3",
      policyVersion: "demo-policy.v3",
    };
    Object.assign(f.config.features, {
      speech: true,
      courseGrounding: false,
      kiosk: false,
      ownerDemoWeb: true,
    });
    f.config.access.browserSessions = {
      pairingTtlSeconds: 60,
      sessionTtlSeconds: 3600,
    };
    mutation?.(f.config);
    save(f.source, f.config);
    const before = readFileSync(f.source);
    const result = f.run("owner-config", f.configArgs());
    assert.deepEqual(readFileSync(f.source), before);
    if (mutation) {
      denied(result);
      assert.equal(readdirSync(f.root).includes("candidate.json"), false);
    } else {
      assert.equal(result.status, 0, result.stderr);
      const expected = structuredClone(f.config);
      delete expected.access.browserSessions;
      for (const k of ["courseGrounding", "kiosk", "ownerDemoWeb"])
        delete expected.features[k];
      expected.provenance = {
        demoProfileVersion: "demo-profile.v4",
        policyVersion: "demo-policy.v4",
      };
      assert.deepEqual(JSON.parse(readFileSync(f.destination)), expected);
    }
  }
});
