import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  isApplicationConfiguration,
  applicationConfigurationSchema,
} from "../dist/configuration-server.js";
import { isClientConfiguration } from "@laita/contracts";
import { Ajv } from "ajv";

const read = (path) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const local = () => read("../../runtime/examples/local-only.example.json");
const demo = () => read("../../runtime/examples/openai-demo.example.json");

// Use the exported schema independently as well as the typed wrapper.
const validate = new Ajv({ strict: true, ownProperties: true }).compile(
  applicationConfigurationSchema,
);
test("public examples bind to canonical policy provenance and Local model choices", () => {
  const profile = read("../../../policy-contracts/demo/v2/demo-profile.json");
  for (const value of [local(), demo()]) {
    assert.equal(validate(value), true);
    assert.equal(isApplicationConfiguration(value), true);
    assert.equal(value.provenance.demoProfileVersion, profile.profileVersion);
    assert.equal(
      value.provenance.policyVersion,
      profile.policyBundle.policyVersion,
    );
    assert.equal(
      value.providers.local.provider,
      profile.evaluationContext.targetProvider,
    );
    assert.equal(value.providers.local.model, profile.local.model);
    assert.deepEqual(value.providers.local.candidates, [
      profile.local.model,
      profile.local.comparisonModel,
    ]);
    assert.equal(value.providers.openai.model, profile.openai.model);
  }
});

test("all 128 flag combinations in each mode enforce only the documented dependencies", () => {
  const keys = Object.keys(local().features);
  for (const mode of ["scaffold", "operator"]) {
    for (let bits = 0; bits < 16; bits++) {
      const value = demo();
      value.mode = mode;
      keys.forEach((key, index) => {
        value.features[key] = Boolean(bits & (1 << index));
      });
      const f = value.features;
      const optional = f.openai || f.compare || f.speech;
      const needsLocal = f.openai || f.compare || f.speech;
      const expected =
        !(mode === "scaffold" && optional) &&
        (!needsLocal || f.local) &&
        (!f.compare || f.openai);
      assert.equal(validate(value), expected, `${mode} flags ${bits}`);
    }
  }
});

for (const [name, change] of [
  [
    "unsupported version",
    (c) => {
      c.contractVersion = "application-configuration.v999";
    },
  ],
  [
    "superseded application version",
    (c) => {
      c.contractVersion = "application-configuration.v1";
    },
  ],
  [
    "unknown policy",
    (c) => {
      c.provenance.policyVersion = "unknown.v1";
    },
  ],
  [
    "unknown profile",
    (c) => {
      c.provenance.demoProfileVersion = "unknown.v1";
    },
  ],
  [
    "superseded profile and policy identity",
    (c) => {
      c.provenance.demoProfileVersion = "demo-profile.v1";
      c.provenance.policyVersion = "demo-policy.v1";
    },
  ],
  [
    "malformed boolean",
    (c) => {
      c.features.openai = "false";
    },
  ],
  [
    "null flag",
    (c) => {
      c.features.local = null;
    },
  ],
  [
    "unknown runtime mode",
    (c) => {
      c.mode = "production";
    },
  ],
  [
    "non-loopback binding",
    (c) => {
      c.server.bind = "public";
    },
  ],
  [
    "unapproved local model",
    (c) => {
      c.providers.local.model = "unapproved-model";
    },
  ],
  [
    "superseded ordinary Gemma primary",
    (c) => {
      c.providers.local.model = "gemma4:12b";
      c.providers.local.candidates[0] = "gemma4:12b";
    },
  ],
  [
    "unapproved local candidate",
    (c) => {
      c.providers.local.candidates[1] = "unapproved-model";
    },
  ],
  [
    "unapproved cloud model",
    (c) => {
      c.providers.openai.model = "unapproved-model";
    },
  ],
  [
    "provider substitution",
    (c) => {
      c.providers.local.provider = "OPENAI";
    },
  ],
  [
    "missing cloud metadata",
    (c) => {
      c.providers.openai.secretReference = null;
    },
  ],
  [
    "missing reference kind",
    (c) => {
      delete c.providers.openai.secretReference.kind;
    },
  ],
  [
    "missing reference id",
    (c) => {
      delete c.providers.openai.secretReference.id;
    },
  ],
  [
    "unsupported resolver",
    (c) => {
      c.providers.openai.secretReference.kind = "keychain";
    },
  ],
  [
    "reference value field",
    (c) => {
      c.providers.openai.secretReference.value = "synthetic-value";
    },
  ],
  [
    "reference path",
    (c) => {
      c.providers.openai.secretReference.id = "placeholder/path";
    },
  ],
  [
    "empty reference",
    (c) => {
      c.providers.openai.secretReference.id = "";
    },
  ],
  [
    "oversized reference",
    (c) => {
      c.providers.openai.secretReference.id = "x".repeat(65);
    },
  ],
  ...[0, 1023, 65536, 3100.1, "3100", null].map((port) => [
    `invalid port ${port}`,
    (c) => {
      c.server.port = port;
    },
  ]),
]) {
  test(`rejects ${name}`, () => {
    const value = demo();
    change(value);
    assert.equal(isApplicationConfiguration(value), false);
  });
}

test("every object is closed and every declared field is required", () => {
  const paths = [
    [],
    ["provenance"],
    ["server"],
    ["runtime"],
    ["providers"],
    ["providers", "local"],
    ["providers", "openai"],
    ["providers", "openai", "secretReference"],
    ["features"],
  ];
  for (const path of paths) {
    const get = (value) => path.reduce((object, key) => object[key], value);
    const value = demo();
    get(value).unexpected = "synthetic-marker";
    assert.equal(validate(value), false, `unknown field at ${path}`);
    for (const key of Object.keys(get(demo()))) {
      const missing = demo();
      delete get(missing)[key];
      assert.equal(validate(missing), false, `missing ${path}.${key}`);
    }
  }
});

test("browser conditions deny the server entry; the public entry exports no server contract", async () => {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=browser",
      "--input-type=module",
      "-e",
      'import "@laita/contracts/server";',
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
  const publicExports = await import("@laita/contracts");
  assert.equal("isApplicationConfiguration" in publicExports, false);
  assert.equal("applicationConfigurationSchema" in publicExports, false);
  assert.equal(isClientConfiguration(demo()), false);
});

test("runtime limits are integer/range bounded and fail closed without coercion or partial defaults", () => {
  for (const [field, invalidValues] of [
    ["maxConcurrentOperations", [0, -1, 5, 1.5, "1", null, true]],
    ["operationTimeoutMs", [0, -1, 9, 120001, 10.5, "30000", null, false]],
  ]) {
    for (const invalid of invalidValues) {
      const value = local();
      value.runtime[field] = invalid;
      assert.equal(validate(value), false);
    }
  }
  for (const runtime of [
    null,
    {},
    { maxConcurrentOperations: 1 },
    { operationTimeoutMs: 30000 },
  ]) {
    assert.equal(validate({ ...local(), runtime }), false);
  }
  for (const maxConcurrentOperations of [1, 4]) {
    for (const operationTimeoutMs of [10, 120000]) {
      assert.equal(
        validate({
          ...local(),
          runtime: { maxConcurrentOperations, operationTimeoutMs },
        }),
        true,
      );
    }
  }
});

test("runtime root is required, bounded, server-only and explicitly selected for private demo", () => {
  for (const runtimeRoot of [
    "",
    "relative/runtime",
    ":memory:",
    7,
    {},
    "/bad\0path",
    "/bad\npath",
    "/bad\n",
    "/bad\r\n",
    "/" + "x".repeat(4096),
  ]) {
    assert.equal(validate({ ...local(), runtimeRoot }), false);
  }
  assert.equal(validate({ ...local(), runtimeRoot: null }), true);
  assert.equal(validate({ ...demo(), runtimeRoot: null }), false);
  assert.equal(
    validate({
      ...demo(),
      runtimeRoot: "/absolute/path/to/protected-runtime-root",
    }),
    true,
  );
});
