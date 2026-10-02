import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkBoundaries } from "./check-workspace-boundaries.mjs";

function fixture(t, source, extraDependencies = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "teaching-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "docs"));
  writeFileSync(
    path.join(root, "docs/MODULES.md"),
    readFileSync(new URL("../../docs/MODULES.md", import.meta.url)),
  );
  const workspaces = ["packages/contracts", "apps/api", "apps/web"];
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ workspaces }),
  );
  for (const directory of workspaces) {
    mkdirSync(path.join(root, directory, "src"), { recursive: true });
    const name = `@laita/${path.basename(directory)}`;
    writeFileSync(
      path.join(root, directory, "package.json"),
      JSON.stringify({
        name,
        dependencies:
          directory === "apps/web"
            ? { "@laita/contracts": "0.0.0", ...extraDependencies }
            : {},
      }),
    );
  }
  writeFileSync(path.join(root, "apps/web/src/main.ts"), source);
  return root;
}

test("allowed shared schema import follows the existing module map", (t) => {
  assert.doesNotThrow(() =>
    checkBoundaries(fixture(t, 'import { schema } from "@laita/contracts";')),
  );
});

test("duplicate workspace membership cannot hide an unlisted package", (t) => {
  const root = fixture(t, 'import "@laita/contracts";');
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      workspaces: ["packages/contracts", "apps/api", "apps/api"],
    }),
  );
  assert.throws(() => checkBoundaries(root), /Workspace membership/);
});

test("module-map parsing accepts CRLF line endings", (t) => {
  const root = fixture(t, 'import "@laita/contracts";');
  const document = path.join(root, "docs/MODULES.md");
  writeFileSync(
    document,
    readFileSync(document, "utf8").replace(/\r?\n/g, "\r\n"),
  );
  assert.doesNotThrow(() => checkBoundaries(root));
});

test("root aliases preserve valid within-module relative imports", (t) => {
  const root = fixture(t, 'import "./helper.ts";');
  writeFileSync(path.join(root, "apps/web/src/helper.ts"), "export {};");
  const alias = path.join(root, "root-alias");
  symlinkSync(root, alias, "dir");
  assert.doesNotThrow(() => checkBoundaries(alias));
  symlinkSync("helper.ts", path.join(root, "apps/web/src/helper-alias.ts"));
  assert.throws(
    () => checkBoundaries(alias),
    /Symlink in workspace source tree/,
  );
});

for (const specifier of ["node:fs", "fs"]) {
  test(`rejects shared-contract runtime builtin ${specifier}`, (t) => {
    const root = fixture(t, 'import "@laita/contracts";');
    writeFileSync(
      path.join(root, "packages/contracts/src/index.ts"),
      `import "${specifier}";`,
    );
    assert.throws(
      () => checkBoundaries(root),
      /runtime imports a Node builtin/,
    );
  });
}

test("backend runtime and shared-contract tests can use Node builtins", (t) => {
  const root = fixture(t, 'import "@laita/contracts";');
  writeFileSync(path.join(root, "apps/api/src/main.ts"), 'import "node:fs";');
  mkdirSync(path.join(root, "packages/contracts/test"));
  writeFileSync(
    path.join(root, "packages/contracts/test/schema.test.mjs"),
    'import "node:assert/strict";',
  );
  assert.doesNotThrow(() => checkBoundaries(root));
});

test("rejects a source FIFO without blocking on a read", (t) => {
  const root = fixture(t, 'import "@laita/contracts";');
  const fifo = spawnSync("mkfifo", [path.join(root, "apps/web/src/stream.ts")]);
  assert.equal(fifo.status, 0, "Synthetic FIFO creation must succeed");
  // Bound the subprocess so a regression cannot hang the entire test suite.
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "const { checkBoundaries } = await import(process.argv[1]); checkBoundaries(process.argv[2]);",
      new URL("./check-workspace-boundaries.mjs", import.meta.url).href,
      root,
    ],
    { timeout: 5000, encoding: "utf8" },
  );
  assert.equal(result.error, undefined, "Checker must exit before the timeout");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Non-regular file in workspace source tree/);
});

for (const [name, source, dependencies] of [
  [
    "forbidden declared edge",
    'import "@laita/api";',
    { "@laita/api": "0.0.0" },
  ],
  ["server-only schema entry", 'import "@laita/contracts/server";'],
  [
    "server-only schema type",
    'type Config = import("@laita/contracts/server");',
  ],
  ["relative bypass", 'import "../../api/src/main.ts";'],
  ["shared internal path", 'export * from "@laita/contracts/src/internal.ts";'],
  ["dynamic import", 'const moduleName = "synthetic"; import(moduleName);'],
  ["literal forbidden dynamic import", 'import("@laita/api");'],
  ["import type bypass", 'type Server = import("../../api/src/main.ts");'],
  ["undeclared dependency", 'import "unapproved-package";'],
  ["browser Node builtin", 'import "node:fs";'],
  ["CommonJS bypass", 'require("../../api/src/main.js");'],
]) {
  test(`rejects ${name}`, (t) => {
    assert.throws(() => checkBoundaries(fixture(t, source, dependencies)));
  });
}

test("API may import the explicit server schema but not arbitrary deep paths", (t) => {
  const root = fixture(t, 'import "@laita/contracts";');
  const manifest = path.join(root, "apps/api/package.json");
  const value = JSON.parse(readFileSync(manifest, "utf8"));
  value.dependencies = { "@laita/contracts": "0.0.0" };
  writeFileSync(manifest, JSON.stringify(value));
  const entry = path.join(root, "apps/api/src/main.ts");
  writeFileSync(entry, 'import "@laita/contracts/server";');
  assert.doesNotThrow(() => checkBoundaries(root));
  writeFileSync(
    entry,
    'import "@laita/contracts/dist/configuration-server.js";',
  );
  assert.throws(() => checkBoundaries(root), /Prohibited module import/);
});
