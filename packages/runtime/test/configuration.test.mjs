import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { isClientConfiguration } from "@laita/contracts";
import {
  defaultConfiguration,
  loadConfiguration,
  parseConfiguration,
  projectClientConfiguration,
} from "@laita/runtime";

const example = (name) =>
  readFileSync(
    new URL(`../examples/${name}.example.json`, import.meta.url),
    "utf8",
  );
const invalid = { ok: false, code: "INVALID_CONFIGURATION" };

test("unset input starts local-only without a cloud credential; defaults and examples agree", () => {
  const result = loadConfiguration({});
  assert.deepEqual(result, {
    ok: true,
    value: JSON.parse(example("local-only")),
  });
  assert.equal(result.value.providers.openai.secretReference, null);
  assert.deepEqual(
    Object.entries(result.value.features)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name),
    ["local"],
  );
  const defaults = defaultConfiguration();
  defaults.features.openai = true;
  assert.deepEqual(loadConfiguration({}), result);
  const envExample = readFileSync(
    new URL("../../../.env.example", import.meta.url),
    "utf8",
  );
  assert.deepEqual(
    parseConfiguration(envExample.match(/^APP_CONFIG_JSON='(.*)'$/m)[1]),
    result,
  );
});

test("explicit demo uses only a placeholder reference and never resolves environment identifiers", () => {
  const json = example("openai-demo");
  const result = loadConfiguration({
    APP_CONFIG_JSON: json,
    PLACEHOLDER_SECRET: "synthetic-do-not-read",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.providers.openai.secretReference, {
    kind: "opaque",
    id: "placeholder-openai-reference",
  });
  const environment = { APP_CONFIG_JSON: json };
  Object.defineProperty(environment, "PLACEHOLDER_SECRET", {
    get() {
      throw new Error("must not resolve");
    },
  });
  assert.deepEqual(loadConfiguration(environment), result);
});

test("application and access stages cannot be mixed or defaulted across trust boundaries", () => {
  const local = JSON.parse(example("local-only"));
  const demo = JSON.parse(example("openai-demo"));
  assert.deepEqual(
    parseConfiguration(
      JSON.stringify({ ...demo, access: structuredClone(local.access) }),
    ),
    invalid,
  );
  assert.deepEqual(
    parseConfiguration(
      JSON.stringify({ ...local, access: structuredClone(demo.access) }),
    ),
    invalid,
  );
  delete demo.access;
  assert.deepEqual(parseConfiguration(JSON.stringify(demo)), invalid);
});

test("malformed, empty, oversized and schema-invalid input yields only a fixed code without fallback", () => {
  for (const json of [
    "",
    "synthetic-secret-marker",
    "{",
    "null",
    "[]",
    "false",
    "{}",
    " ".repeat(32769),
    '{"synthetic-private-field":"synthetic-secret-marker"}',
    example("local-only").replace('"port": 3100', '"port": "3100"'),
  ]) {
    assert.deepEqual(parseConfiguration(json), invalid);
    assert.deepEqual(loadConfiguration({ APP_CONFIG_JSON: json }), invalid);
    assert.deepEqual(projectClientConfiguration(json), invalid);
  }
  assert.deepEqual(parseConfiguration(undefined), invalid);
});

test("projection contains only version and explicit flags, including when a reference resembles an environment name", () => {
  const server = JSON.parse(example("openai-demo"));
  server.providers.openai.secretReference.id = "PLACEHOLDER_OPENAI_SECRET";
  server.server.port = 43210;
  const json = JSON.stringify(server);
  const result = projectClientConfiguration(json);
  assert.deepEqual(result, {
    ok: true,
    value: {
      contractVersion: "client-configuration.v2",
      configurationVersion: "application-configuration.v2",
      features: server.features,
    },
  });
  assert.equal(isClientConfiguration(result.value), true);
  const serialized = JSON.stringify(result.value);
  for (const marker of [
    "PLACEHOLDER_OPENAI_SECRET",
    "secretReference",
    "providers",
    "provenance",
    "server",
    "loopback",
    "43210",
    "APP_CONFIG_JSON",
    "operator",
    "access",
    "tokenSha256",
    server.access.publicOrigin,
    server.access.credentials[0].id,
  ]) {
    assert.equal(serialized.includes(marker), false);
  }
  result.value.features.openai = false;
  assert.equal(projectClientConfiguration(json).value.features.openai, true);
  for (const [key, value] of Object.entries(server)) {
    assert.equal(
      isClientConfiguration({
        ...projectClientConfiguration(json).value,
        [key]: value,
      }),
      key === "features",
    );
  }
  const tainted = projectClientConfiguration(json).value;
  tainted.features.secretReference = "synthetic-marker";
  assert.equal(isClientConfiguration(tainted), false);
  server.features.secretReference = "synthetic-marker";
  assert.deepEqual(projectClientConfiguration(JSON.stringify(server)), invalid);
});

test("browser conditions also deny the runtime package", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=browser",
      "--input-type=module",
      "-e",
      'import "@laita/runtime";',
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
});

test("explicit runtime paths never enter client-safe configuration", () => {
  const configuration = defaultConfiguration();
  configuration.runtimeRoot = "/synthetic/private/runtime-marker";
  const result = projectClientConfiguration(JSON.stringify(configuration));
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result.value).includes("runtime"), false);
  assert.equal(
    JSON.stringify(result.value).includes(configuration.runtimeRoot),
    false,
  );
});
