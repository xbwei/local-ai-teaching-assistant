import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repository = process.cwd();
const helper = path.join(repository, "ops/macos/prepare-provider-config.mjs");
const validator = path.join(
  repository,
  "ops/macos/validate-production-config.mjs",
);
const template = path.join(
  repository,
  "ops/macos/application-config.json.template",
);
const privateSentinel = "distinctive-private-sentinel";

function fixture(t) {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), `${privateSentinel}-`)),
  );
  chmodSync(root, 0o700);
  const runtime = path.join(root, "runtime-root");
  const source = path.join(root, "local-only.json");
  const candidate = path.join(root, "providerConfig-candidate.json");
  const mapping = path.join(root, "keychain-mapping.json");
  const configuration = JSON.parse(
    readFileSync(template, "utf8").replace(
      "__OPERATOR_ABSOLUTE_RUNTIME_ROOT__",
      runtime,
    ),
  );
  configuration.provenance = {
    demoProfileVersion: "demo-profile.v2",
    policyVersion: "demo-policy.v2",
  };
  configuration.runtime.operationTimeoutMs = 30000;
  configuration.features.openai = false;
  configuration.features.compare = false;
  configuration.providers.openai.secretReference = null;
  configuration.access = {
    ...configuration.access,
    enabled: true,
    publicOrigin: `https://${privateSentinel}.example.invalid`,
    credentials: [
      {
        id: "synthetic-instructor",
        role: "instructor",
        courseScopes: ["synthetic-course"],
        tokenSha256: "1".repeat(64),
        expiresAtEpochSeconds: 2_000_000_000,
        revoked: false,
      },
    ],
    adminCredentials: [
      {
        id: "synthetic-admin",
        tokenSha256: "2".repeat(64),
        expiresAtEpochSeconds: 2_000_000_000,
        revoked: false,
      },
    ],
  };
  writeFileSync(source, `${JSON.stringify(configuration, null, 2)}\n`, {
    mode: 0o600,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, runtime, source, candidate, mapping, configuration };
}

function run(command, args, environment = {}) {
  return spawnSync(process.execPath, [helper, command, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: "", ...environment },
  });
}

function prepareConfig(files, environment = {}) {
  return run(
    "config",
    [repository, files.source, files.candidate, files.runtime, "3100"],
    {
      LAITA_OPENAI_SECRET_REFERENCE_ID: "synthetic_openai_reference",
      ...environment,
    },
  );
}

function validate(file, runtime) {
  return spawnSync(
    process.execPath,
    [validator, repository, file, runtime, "3100"],
    { encoding: "utf8" },
  );
}

function assertSanitized(result, sentinels) {
  const output = `${result.stdout}${result.stderr}`;
  for (const sentinel of sentinels.filter(Boolean))
    assert.equal(output.includes(sentinel), false);
  assert.match(output, /^(?:PROVIDER_PREPARATION_ERROR=[A-Z_]+\n)?$/u);
}

test("valid Local-only configuration produces one validated fixed PROVIDER_ENABLED candidate", (t) => {
  const files = fixture(t);
  const original = readFileSync(files.source, "utf8");
  const result = prepareConfig(files);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "PROVIDER_CONFIG_PREPARED\n");
  assert.equal(result.stderr, "");
  assert.equal(readFileSync(files.source, "utf8"), original);
  assert.equal(lstatSync(files.candidate).mode & 0o777, 0o600);
  assert.equal(lstatSync(files.candidate).nlink, 1);
  const candidate = JSON.parse(readFileSync(files.candidate, "utf8"));
  assert.deepEqual(candidate.access, files.configuration.access);
  assert.deepEqual(candidate.runtime, files.configuration.runtime);
  assert.equal(candidate.runtimeRoot, files.runtime);
  assert.deepEqual(candidate.server, files.configuration.server);
  assert.deepEqual(candidate.providers.local, {
    provider: "LOCAL",
    model: "gemma4:12b-mlx",
    candidates: ["gemma4:12b-mlx", "llama3.1:8b"],
  });
  assert.deepEqual(candidate.providers.openai, {
    provider: "OPENAI",
    model: "gpt-5.6-luna",
    secretReference: { kind: "opaque", id: "synthetic_openai_reference" },
  });
  assert.deepEqual(candidate.features, {
    local: true,
    openai: true,
    compare: true,
    speech: false,
  });
  const validated = validate(files.candidate, files.runtime);
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(validated.stdout, "PROVIDER_ENABLED\n");

  const replaced = prepareConfig(files, {
    LAITA_OPENAI_SECRET_REFERENCE_ID: "replacement_openai_reference",
  });
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal(
    JSON.parse(readFileSync(files.candidate, "utf8")).providers.openai
      .secretReference.id,
    "replacement_openai_reference",
  );
  assert.equal(readFileSync(files.source, "utf8"), original);
});

test("mapping preparation is private, exact and independently verifiable", (t) => {
  const files = fixture(t);
  const environment = {
    LAITA_OPENAI_KEYCHAIN_SERVICE: "synthetic-service-identifier",
    LAITA_OPENAI_KEYCHAIN_ACCOUNT: "synthetic-account-identifier",
  };
  const prepared = run("mapping", [files.mapping], environment);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(prepared.stdout, "KEYCHAIN_MAPPING_PREPARED\n");
  assert.equal(lstatSync(files.mapping).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(files.mapping, "utf8")), {
    contractVersion: "openai-keychain-mapping.v1",
    service: environment.LAITA_OPENAI_KEYCHAIN_SERVICE,
    account: environment.LAITA_OPENAI_KEYCHAIN_ACCOUNT,
  });
  const verified = run("verify-mapping", [files.mapping]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.stdout, "KEYCHAIN_MAPPING_VALID\n");
  assert.equal(
    `${prepared.stdout}${prepared.stderr}${verified.stdout}${verified.stderr}`.includes(
      environment.LAITA_OPENAI_KEYCHAIN_SERVICE,
    ),
    false,
  );
});

test("failed atomic replacement preserves the prior candidate and removes partial files", (t) => {
  const files = fixture(t);
  const previous = "previous-private-candidate\n";
  writeFileSync(files.candidate, previous, { mode: 0o600 });
  const result = prepareConfig(files, {
    LAITA_OPERATIONS_TESTING: "1",
    LAITA_TEST_FAIL_PROVIDER_BEFORE_RENAME: "1",
  });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(files.candidate, "utf8"), previous);
  assert.equal(
    readdirSync(files.root).some((name) => name.includes(".partial-")),
    false,
  );
});

test("unsafe source or destination identity fails without replacement", (t) => {
  for (const kind of ["same", "symlink", "hardlink", "parent-mode"]) {
    const files = fixture(t);
    let destination = files.candidate;
    if (kind === "same") destination = files.source;
    if (kind === "symlink") symlinkSync(files.source, destination);
    if (kind === "hardlink") linkSync(files.source, destination);
    if (kind === "parent-mode") chmodSync(files.root, 0o755);
    const result = run(
      "config",
      [repository, files.source, destination, files.runtime, "3100"],
      { LAITA_OPENAI_SECRET_REFERENCE_ID: "synthetic_openai_reference" },
    );
    assert.notEqual(result.status, 0, kind);
    assertSanitized(result, [files.root, privateSentinel]);
  }
});

test("missing, malformed and credential-shaped private inputs fail closed", (t) => {
  const invalidReferences = [
    undefined,
    "",
    "9-invalid",
    "x".repeat(65),
    "sk-proj-DISTINCTIVE_PRIVATE_SECRET_123456789",
    "Bearer distinctive-private-secret",
  ];
  for (const reference of invalidReferences) {
    const files = fixture(t);
    const result = prepareConfig(files, {
      LAITA_OPENAI_SECRET_REFERENCE_ID: reference,
    });
    assert.notEqual(result.status, 0);
    assert.equal(lstatSync(files.source).mode & 0o777, 0o600);
    assert.equal(
      readFileSync(files.source, "utf8").includes(privateSentinel),
      true,
    );
    assert.equal(
      (() => {
        try {
          lstatSync(files.candidate);
          return true;
        } catch {
          return false;
        }
      })(),
      false,
    );
    assertSanitized(result, [files.root, privateSentinel, reference ?? ""]);
  }

  const invalidMappings = [
    {},
    {
      LAITA_OPENAI_KEYCHAIN_SERVICE: "service",
      LAITA_OPENAI_KEYCHAIN_ACCOUNT: "",
    },
    {
      LAITA_OPENAI_KEYCHAIN_SERVICE: "service\nprivate",
      LAITA_OPENAI_KEYCHAIN_ACCOUNT: "account",
    },
    {
      LAITA_OPENAI_KEYCHAIN_SERVICE:
        "sk-proj-DISTINCTIVE_PRIVATE_SECRET_123456789",
      LAITA_OPENAI_KEYCHAIN_ACCOUNT: "account",
    },
  ];
  for (const environment of invalidMappings) {
    const files = fixture(t);
    const result = run("mapping", [files.mapping], environment);
    assert.notEqual(result.status, 0);
    assertSanitized(result, [
      files.root,
      privateSentinel,
      environment.LAITA_OPENAI_KEYCHAIN_SERVICE ?? "",
      environment.LAITA_OPENAI_KEYCHAIN_ACCOUNT ?? "",
    ]);
  }
});

test("provider, model, feature and raw-field widening in the source is rejected", (t) => {
  const mutations = [
    (c) => (c.providers.local.model = "arbitrary-model"),
    (c) => c.providers.local.candidates.push("arbitrary-model"),
    (c) => (c.providers.openai.model = "arbitrary-model"),
    (c) => (c.features.ownerDemoWeb = true),
    (c) => (c.features.openai = true),
    (c) => (c.providers.openai.apiKey = "distinctive-private-secret"),
    (c) => (c.providers.openai.endpoint = "https://example.invalid"),
    (c) => (c.providers.local.fallback = "OPENAI"),
  ];
  for (const mutate of mutations) {
    const files = fixture(t);
    const configuration = JSON.parse(readFileSync(files.source, "utf8"));
    mutate(configuration);
    writeFileSync(files.source, `${JSON.stringify(configuration)}\n`, {
      mode: 0o600,
    });
    const result = prepareConfig(files);
    assert.notEqual(result.status, 0);
    assertSanitized(result, [
      files.root,
      privateSentinel,
      "distinctive-private-secret",
    ]);
  }
});

test("mapping verification rejects malformed, widened, linked and unsafe artifacts", (t) => {
  const valid = {
    contractVersion: "openai-keychain-mapping.v1",
    service: "synthetic-service",
    account: "synthetic-account",
  };
  for (const kind of ["extra", "mode", "symlink", "hardlink"]) {
    const files = fixture(t);
    writeFileSync(files.mapping, `${JSON.stringify(valid)}\n`, { mode: 0o600 });
    if (kind === "extra") {
      writeFileSync(
        files.mapping,
        `${JSON.stringify({ ...valid, secret: "distinctive-private-secret" })}\n`,
        { mode: 0o600 },
      );
    } else if (kind === "mode") chmodSync(files.mapping, 0o644);
    else {
      const alias = path.join(files.root, `mapping-${kind}.json`);
      if (kind === "symlink") symlinkSync(files.mapping, alias);
      else linkSync(files.mapping, alias);
      files.mapping = alias;
    }
    const result = run("verify-mapping", [files.mapping]);
    assert.notEqual(result.status, 0);
    assertSanitized(result, [
      files.root,
      privateSentinel,
      "distinctive-private-secret",
      valid.service,
      valid.account,
    ]);
  }
});

test("canonical repository boundary rejects an in-repository file through a symlinked checkout", (t) => {
  const aliasRoot = mkdtempSync(
    path.join(tmpdir(), "providerConfig-repository-alias-"),
  );
  const repositoryAlias = path.join(aliasRoot, "repository");
  const privateDirectory = mkdtempSync(
    path.join(repository, ".providerConfig-repository-boundary-"),
  );
  chmodSync(privateDirectory, 0o700);
  const mapping = path.join(privateDirectory, "mapping.json");
  writeFileSync(
    mapping,
    `${JSON.stringify({
      contractVersion: "openai-keychain-mapping.v1",
      service: "synthetic-service",
      account: "synthetic-account",
    })}\n`,
    { mode: 0o600 },
  );
  symlinkSync(repository, repositoryAlias, "dir");
  t.after(() => rmSync(aliasRoot, { recursive: true, force: true }));
  t.after(() => rmSync(privateDirectory, { recursive: true, force: true }));

  const moduleUrl = pathToFileURL(
    path.join(repositoryAlias, "ops/macos/keychain-mapping.mjs"),
  ).href;
  const program = `
    import { readKeychainMapping } from ${JSON.stringify(moduleUrl)};
    try {
      readKeychainMapping(${JSON.stringify(mapping)});
      process.exit(0);
    } catch {
      process.exit(23);
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--preserve-symlinks", "--input-type=module", "--eval", program],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 23, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("preparation needs no shell, security command or provider endpoint", (t) => {
  const files = fixture(t);
  assert.equal(prepareConfig(files).status, 0);
  const mapping = run("mapping", [files.mapping], {
    LAITA_OPENAI_KEYCHAIN_SERVICE: "synthetic-service",
    LAITA_OPENAI_KEYCHAIN_ACCOUNT: "synthetic-account",
  });
  assert.equal(mapping.status, 0, mapping.stderr);
});
