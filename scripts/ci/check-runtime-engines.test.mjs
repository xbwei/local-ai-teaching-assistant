import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  supportsEngineRange,
  validateRuntimeEngines,
} from "./check-runtime-engines.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const validationScript = join(
  repositoryRoot,
  "scripts/ci/validate-application.sh",
);
const supportedEngines = { node: ">=24.16.0 <25", npm: ">=11 <12" };

function runValidation(mode, npmVersion, environment = {}, includeUv = false) {
  const fixture = mkdtempSync(join(tmpdir(), "laita-validation-toolchain-"));
  const fakeNpm = join(fixture, "npm");
  const uvSentinel = join(fixture, "uv-invoked");
  try {
    symlinkSync(process.execPath, join(fixture, "node"));
    writeFileSync(
      fakeNpm,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' "${npmVersion}"; fi\nexit 0\n`,
    );
    chmodSync(fakeNpm, 0o700);
    if (includeUv) {
      const fakeUv = join(fixture, "uv");
      writeFileSync(
        fakeUv,
        `#!/bin/sh\nprintf invoked > "${uvSentinel}"\nexit 97\n`,
      );
      chmodSync(fakeUv, 0o700);
    }
    const result = spawnSync("/bin/bash", [validationScript, mode], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture}:/usr/bin:/bin:/usr/sbin:/sbin`,
        REPOSITORY_ROOT: repositoryRoot,
        ...environment,
      },
    });
    let uvInvoked = false;
    try {
      uvInvoked = readFileSync(uvSentinel, "utf8") === "invoked";
    } catch {}
    return { ...result, uvInvoked };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test("declared runtime engine ranges accept supported Node and npm releases", () => {
  for (const npmVersion of ["11.0.0", "11.13.0", "11.17.0", "11.99.99"]) {
    assert.doesNotThrow(() =>
      validateRuntimeEngines({
        nodeVersion: "24.16.0",
        npmVersion,
        engines: supportedEngines,
      }),
    );
  }
  assert.equal(supportsEngineRange("24.19.0", ">=24.16.0 <25", "Node"), true);
});

test("deployment runtime compatibility rejects unsupported major versions", () => {
  for (const npmVersion of ["10.99.99", "12.0.0"]) {
    assert.throws(() =>
      validateRuntimeEngines({
        nodeVersion: "24.16.0",
        npmVersion,
        engines: supportedEngines,
      }),
    );
  }
  assert.throws(() =>
    validateRuntimeEngines({
      nodeVersion: "25.0.0",
      npmVersion: "11.13.0",
      engines: supportedEngines,
    }),
  );
  assert.throws(() => supportsEngineRange("11.13.0", ">=12 <11", "npm"));
  assert.throws(() => supportsEngineRange("11.13.0-beta.1", ">=11 <12", "npm"));
});

test("CI runtime compatibility retains its exact npm pin", () => {
  const result = runValidation("runtime-compatibility", "11.18.0", {
    EXPECTED_NODE_VERSION: process.versions.node,
    EXPECTED_NPM_VERSION: "11.17.0",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /npm version mismatch: expected 11\.17\.0/u);
});

test("canonical application validation retains the package-manager exact pin", () => {
  const result = runValidation("application", "11.17.0", {
    EXPECTED_NODE_VERSION: process.versions.node,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /npm version mismatch: expected 11\.13\.0/u);
});

test("deployment gate accepts supported npm without uv", () => {
  const result = runValidation("deployment-runtime-compatibility", "11.17.0");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Runtime engine compatibility passed\./u);
});

test("deployment gate neither requires nor invokes a different uv version", () => {
  const result = runValidation(
    "deployment-runtime-compatibility",
    "11.17.0",
    {},
    true,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.uvInvoked, false);
});

test("deployment gate rejects an unsupported npm major before validation", () => {
  const result = runValidation("deployment-runtime-compatibility", "12.0.0");
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Runtime engine compatibility failed: npm version is outside the supported runtime range\./u,
  );
});
