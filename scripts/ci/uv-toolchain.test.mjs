import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const gate = fileURLToPath(
  new URL("./validate-application.sh", import.meta.url),
);

function fixture(t, pin) {
  const root = mkdtempSync(path.join(tmpdir(), "laita-uv-toolchain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  if (pin !== undefined) writeFileSync(path.join(root, ".uv-version"), pin);
  writeFileSync(path.join(bin, "uv"), '#!/bin/sh\nprintf "uv 0.0.0\\n"\n', {
    mode: 0o700,
  });
  writeFileSync(
    path.join(bin, "npm"),
    '#!/bin/sh\nprintf "DEPENDENCY_INSTALL_REACHED\\n"\nexit 97\n',
    { mode: 0o700 },
  );
  return spawnSync("bash", [gate, "policy"], {
    env: {
      ...process.env,
      REPOSITORY_ROOT: root,
      PATH: `${bin}:${process.env.PATH}`,
    },
    encoding: "utf8",
    timeout: 10_000,
  });
}

for (const [name, pin] of [
  ["missing", undefined],
  ["empty", " \n\t"],
]) {
  test(`canonical policy gate rejects ${name} uv pin before installation`, (t) => {
    const result = fixture(t, pin);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Unable to derive the pinned uv version from \.uv-version\./u,
    );
    assert.doesNotMatch(result.stdout, /DEPENDENCY_INSTALL_REACHED/u);
  });
}

test("canonical policy gate rejects mismatched uv before installation", (t) => {
  const result = fixture(t, "0.0.1\n");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /uv version mismatch: expected 0\.0\.1, found 0\.0\.0\./u,
  );
  assert.doesNotMatch(result.stdout, /DEPENDENCY_INSTALL_REACHED/u);
});

test("canonical policy gate accepts matching unpackaged-project uv pin", (t) => {
  const result = fixture(t, "0.0.0\n");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 97);
  assert.match(result.stdout, /DEPENDENCY_INSTALL_REACHED/u);
  assert.doesNotMatch(result.stderr, /uv version mismatch|Unable to derive/u);
});
