import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  existsSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  chmodSync,
  statSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { initializeRuntimePaths } from "@laita/runtime";
import { developmentRuntimeRoot } from "../dist/paths.js";

const unavailable = { ok: false, code: "SERVICE_UNAVAILABLE" };
function fixture(t) {
  const base = realpathSync(
    mkdtempSync(path.join(tmpdir(), "teaching-path-test-")),
  );
  t.after(() => {
    chmodSync(base, 0o700);
    rmSync(base, { recursive: true, force: true });
    assert.equal(existsSync(base), false);
  });
  return base;
}
test("minimal isolated private directories and nonserializable path capability", async (t) => {
  const base = fixture(t);
  const root = path.join(base, "runtime");
  const result = initializeRuntimePaths(root);
  assert.equal(result.ok, true);
  assert.deepEqual(readdirSync(root).sort(), ["data", "tmp"]);
  assert.equal(JSON.stringify(result.value), "{}");
  const file = result.value.prepareDatabaseFile();
  assert.equal(file, path.join(root, "data", "foundation.sqlite"));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const sources = result.value.courseSourceDirectory();
  assert.equal(sources, path.join(root, "data", "course-sources"));
  assert.equal(statSync(sources).mode & 0o777, 0o700);
  for (const directory of [
    root,
    path.join(root, "data"),
    path.join(root, "tmp"),
  ])
    assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(path.join(root, "tmp")), []);
});

test("development selection is deterministic per checkout, validated outside Git, and uses synthetic home", (t) => {
  const home = fixture(t);
  const candidate = developmentRuntimeRoot(home);
  assert.equal(candidate, developmentRuntimeRoot(home));
  assert.ok(candidate.startsWith(home + path.sep));
  assert.equal(initializeRuntimePaths(candidate).ok, true);
  const repository = realpathSync(new URL("../../../", import.meta.url));
  assert.deepEqual(
    initializeRuntimePaths(developmentRuntimeRoot(repository)),
    unavailable,
  );
});

test("repository, child, traversal, symlink alias and any other Git checkout are rejected before writes", (t) => {
  const base = fixture(t);
  const repository = realpathSync(new URL("../../../", import.meta.url));
  const alias = path.join(base, "alias");
  symlinkSync(repository, alias);
  const otherRepository = path.join(base, "other-repository");
  mkdirSync(otherRepository);
  writeFileSync(path.join(otherRepository, ".git"), "synthetic git marker");
  for (const unsafe of [
    repository,
    path.join(repository, "synthetic-runtime"),
    `${base}/../${path.basename(base)}/alias`,
    alias,
    path.join(alias, "synthetic-runtime"),
    path.join(otherRepository, "runtime"),
    path.dirname(repository),
    "relative",
    ":memory:",
    "file:synthetic",
    `${base}/bad\0name`,
  ]) {
    assert.deepEqual(initializeRuntimePaths(unsafe), unavailable);
  }
  assert.equal(existsSync(path.join(repository, "synthetic-runtime")), false);
  assert.equal(existsSync(path.join(otherRepository, "runtime")), false);
});

test("safe platform aliases resolve canonically; dangling aliases and internal symlinks fail closed", (t) => {
  const base = fixture(t);
  const target = path.join(base, "target");
  mkdirSync(target, { mode: 0o700 });
  const alias = path.join(base, "alias");
  symlinkSync(target, alias);
  const result = initializeRuntimePaths(alias);
  assert.equal(result.ok, true);
  assert.equal(
    result.value.prepareDatabaseFile(),
    path.join(target, "data", "foundation.sqlite"),
  );
  const dangling = path.join(base, "dangling");
  symlinkSync(path.join(base, "absent"), dangling);
  assert.deepEqual(initializeRuntimePaths(dangling), unavailable);
  const unsafe = path.join(base, "unsafe");
  mkdirSync(unsafe, { mode: 0o700 });
  symlinkSync(target, path.join(unsafe, "data"));
  assert.deepEqual(initializeRuntimePaths(unsafe), unavailable);
});

test("uncreatable and unwritable roots fail deterministically, including privileged test runners", (t) => {
  const base = fixture(t);
  const file = path.join(base, "file");
  writeFileSync(file, "synthetic");
  assert.deepEqual(
    initializeRuntimePaths(path.join(file, "runtime")),
    unavailable,
  );
  for (const mode of [0o500, 0o755, 0o777]) {
    const directory = path.join(base, `mode-${mode}`);
    mkdirSync(directory, { mode });
    try {
      assert.deepEqual(initializeRuntimePaths(directory), unavailable);
    } finally {
      chmodSync(directory, 0o700);
    }
  }
});

test("database and sidecar symlinks/hardlinks cannot target other files", (t) => {
  const base = fixture(t);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    for (const link of [symlinkSync, linkSync]) {
      const root = path.join(base, `runtime-${suffix}-${link.name}`);
      const result = initializeRuntimePaths(root);
      assert.equal(result.ok, true);
      const target = path.join(base, `target-${suffix}-${link.name}`);
      writeFileSync(target, "untouched", { mode: 0o600 });
      link(target, path.join(root, "data", "foundation.sqlite" + suffix));
      assert.throws(() => result.value.prepareDatabaseFile());
      assert.equal(statSync(target).size, 9);
    }
  }
});

test("temporary operations use random names, single-operation bound, cleanup on success/failure and isolation", async (t) => {
  const base = fixture(t);
  const first = initializeRuntimePaths(path.join(base, "one")).value;
  const second = initializeRuntimePaths(path.join(base, "two")).value;
  let firstDirectory;
  let overlappingCalls = 0;
  const completion = await first.withTemporaryWork(async (directory) => {
    firstDirectory = directory;
    assert.match(path.basename(directory), /^operation-/);
    writeFileSync(path.join(directory, "synthetic.txt"), "synthetic", {
      mode: 0o600,
    });
    assert.deepEqual(
      await first.withTemporaryWork(async () => {
        overlappingCalls++;
      }),
      unavailable,
    );
    const isolated = await second.withTemporaryWork(async (other) => {
      assert.notEqual(other, directory);
      assert.equal(existsSync(directory), true);
    });
    assert.equal(isolated.ok, true);
    return "complete";
  });
  assert.deepEqual(completion, { ok: true, value: "complete" });
  assert.equal(existsSync(firstDirectory), false);
  assert.equal(overlappingCalls, 0);
  let failedDirectory;
  assert.deepEqual(
    await first.withTemporaryWork(async (directory) => {
      failedDirectory = directory;
      throw new Error("synthetic-private-path-and-content");
    }),
    unavailable,
  );
  assert.notEqual(failedDirectory, firstDirectory);
  assert.equal(existsSync(failedDirectory), false);
  assert.deepEqual(readdirSync(path.join(base, "one", "tmp")), []);
  assert.deepEqual(readdirSync(path.join(base, "two", "tmp")), []);
});

test("replaceable non-sticky ancestor is rejected before creating the root", (t) => {
  const base = fixture(t);
  const parent = path.join(base, "replaceable");
  mkdirSync(parent, { mode: 0o700 });
  chmodSync(parent, 0o777);
  try {
    const root = path.join(parent, "runtime");
    assert.deepEqual(initializeRuntimePaths(root), unavailable);
    assert.equal(existsSync(root), false);
  } finally {
    chmodSync(parent, 0o700);
  }
});

test("temporary cleanup failure stays bounded and does not admit more operations", async (t) => {
  const base = fixture(t);
  const paths = initializeRuntimePaths(base).value;
  const temporary = path.join(base, "tmp");
  let owned;
  try {
    const result = await paths.withTemporaryWork(async (directory) => {
      owned = directory;
      chmodSync(temporary, 0o500); // deterministic invariant failure, even as root
    });
    assert.deepEqual(result, unavailable);
  } finally {
    chmodSync(temporary, 0o700);
  }
  assert.equal(existsSync(owned), true);
  let calls = 0;
  assert.deepEqual(
    await paths.withTemporaryWork(async () => {
      calls++;
    }),
    unavailable,
  );
  assert.equal(calls, 0);
  rmSync(owned, { recursive: true });
});
