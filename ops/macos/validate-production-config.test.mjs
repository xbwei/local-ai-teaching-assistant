import assert from "node:assert/strict";
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
import { spawnSync } from "node:child_process";
import test from "node:test";

const repository = process.cwd();
const validator = path.join(
  repository,
  "ops/macos/validate-production-config.mjs",
);
const template = path.join(
  repository,
  "ops/macos/application-config.json.template",
);

function fixture(t) {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "production-config-test-")),
  );
  chmodSync(root, 0o700);
  const runtime = path.join(root, "runtime");
  const configurationFile = path.join(root, "application-config.json");
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
  configuration.features.openai = true;
  configuration.features.compare = true;
  configuration.providers.openai.secretReference = {
    kind: "opaque",
    id: "synthetic-reference",
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { runtime, configurationFile, configuration };
}

function validate(configurationFile, runtime) {
  return spawnSync(
    process.execPath,
    [validator, repository, configurationFile, runtime, "3100"],
    { encoding: "utf8" },
  );
}

function write(configurationFile, configuration) {
  writeFileSync(configurationFile, `${JSON.stringify(configuration)}\n`, {
    mode: 0o600,
  });
}

test("Cloud-enabled and explicit Local-only production envelopes remain distinct", (t) => {
  const { runtime, configurationFile, configuration } = fixture(t);
  write(configurationFile, configuration);
  const providerConfig = validate(configurationFile, runtime);
  assert.equal(providerConfig.status, 0, providerConfig.stderr);
  assert.equal(providerConfig.stdout.trim(), "PROVIDER_ENABLED");

  configuration.features.openai = false;
  configuration.features.compare = false;
  configuration.providers.openai.secretReference = null;
  write(configurationFile, configuration);
  const localOnly = validate(configurationFile, runtime);
  assert.equal(localOnly.status, 0, localOnly.stderr);
  assert.equal(localOnly.stdout.trim(), "LOCAL_ONLY");
});

test("OpenAI and Compare require the exact reviewed opaque-reference envelope", (t) => {
  const invalid = [
    (c) => (c.providers.openai.secretReference = null),
    (c) => (c.providers.openai.secretReference = { kind: "opaque", id: "" }),
    (c) => (c.features.openai = false),
    (c) => (c.features.compare = false),
    (c) => (c.features.local = false),
  ];
  for (const mutate of invalid) {
    const { runtime, configurationFile, configuration } = fixture(t);
    mutate(configuration);
    write(configurationFile, configuration);
    assert.notEqual(validate(configurationFile, runtime).status, 0);
  }
});

test("provider, model, feature and provenance widening fails closed", (t) => {
  const invalid = [
    (c) => (c.contractVersion = "application-configuration.v999"),
    (c) => (c.provenance.policyVersion = "demo-policy.v999"),
    (c) => (c.providers.local.provider = "OPENAI"),
    (c) => (c.providers.local.model = "unrestricted-model"),
    (c) => c.providers.local.candidates.push("unrestricted-model"),
    (c) => c.providers.local.candidates.reverse(),
    (c) => (c.providers.openai.model = "unrestricted-model"),
    (c) => (c.features.ownerDemoWeb = true),
    (c) => (c.features.speech = true),
  ];
  for (const mutate of invalid) {
    const { runtime, configurationFile, configuration } = fixture(t);
    mutate(configuration);
    write(configurationFile, configuration);
    assert.notEqual(validate(configurationFile, runtime).status, 0);
  }
});

test("raw credentials, endpoints, fallback directives and unknown fields fail closed", (t) => {
  const invalid = [
    (c) => (c.providers.openai.apiKey = "synthetic-not-a-secret"),
    (c) => (c.providers.openai.endpoint = "https://example.invalid"),
    (c) => (c.providers.local.endpoint = "http://example.invalid"),
    (c) => (c.providers.local.fallback = "OPENAI"),
    (c) => (c.fallback = true),
    (c) => (c.features.futureFeature = true),
  ];
  for (const mutate of invalid) {
    const { runtime, configurationFile, configuration } = fixture(t);
    mutate(configuration);
    write(configurationFile, configuration);
    assert.notEqual(validate(configurationFile, runtime).status, 0);
  }
});

test("explicit v3 successor permits bounded speech intent without reinterpreting v2", (t) => {
  const { runtime, configurationFile, configuration } = fixture(t);
  configuration.provenance = {
    demoProfileVersion: "demo-profile.v4",
    policyVersion: "demo-policy.v4",
  };
  configuration.features.speech = true;
  write(configurationFile, configuration);
  assert.equal(validate(configurationFile, runtime).status, 0);
  configuration.provenance.policyVersion = "demo-policy.v2";
  write(configurationFile, configuration);
  assert.notEqual(validate(configurationFile, runtime).status, 0);
  configuration.provenance.demoProfileVersion = "demo-profile.v2";
  write(configurationFile, configuration);
  assert.notEqual(validate(configurationFile, runtime).status, 0);
});
