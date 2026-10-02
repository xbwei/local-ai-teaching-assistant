import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  fstatSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export type FoundationResult<T> =
  { ok: true; value: T } | { ok: false; code: "SERVICE_UNAVAILABLE" };
export const unavailable = (): FoundationResult<never> => ({
  ok: false,
  code: "SERVICE_UNAVAILABLE",
});

// Function-only server capability: JSON serialization cannot disclose paths.
export interface RuntimePaths {
  prepareDatabaseFile(): string;
  courseSourceDirectory(): string;
  speechDirectory(): string;
  withTemporaryWork<T>(
    operation: (directory: string) => Promise<T>,
  ): Promise<FoundationResult<T>>;
}
const repository = realpathSync(
  fileURLToPath(new URL("../../../", import.meta.url)),
);
const within = (candidate: string, root: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};

// Pure selection seam: tests supply a synthetic home without touching real state.
export function developmentRuntimeRoot(home = homedir()): string {
  const id = createHash("sha256").update(repository).digest("hex").slice(0, 16);
  return path.join(home, ".local", "state", "laita", id);
}
function assertOutsideRepository(candidate: string) {
  if (within(candidate, repository) || within(repository, candidate))
    throw new Error();
  // Also protect the primary checkout, sibling worktrees and any other Git tree.
  for (let current = candidate; ; current = path.dirname(current)) {
    if (existsSync(path.join(current, ".git"))) throw new Error();
    if (path.dirname(current) === current) break;
  }
}
function resolveCandidate(input: string): string {
  if (
    !path.isAbsolute(input) ||
    input.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(input) ||
    input.split(path.sep).includes("..")
  )
    throw new Error();
  let ancestor = input;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    // A dangling symlink must fail, not be mistaken for an absent directory.
    if (lstatSync(ancestor, { throwIfNoEntry: false })) throw new Error();
    missing.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error();
    ancestor = parent;
  }
  const candidate = path.join(realpathSync(ancestor), ...missing);
  assertOutsideRepository(candidate);
  checkParentTrust(candidate);
  return candidate;
}
function checkParentTrust(candidate: string) {
  // Owner-only leaf permissions are insufficient below a replaceable ancestor.
  for (
    let current = path.dirname(candidate);
    ;
    current = path.dirname(current)
  ) {
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (
      info &&
      (!info.isDirectory() ||
        (info.uid !== 0 && info.uid !== process.getuid!()) ||
        ((info.mode & 0o022) !== 0 &&
          !(info.uid === 0 && (info.mode & 0o1000) !== 0)))
    )
      throw new Error();
    if (path.dirname(current) === current) break;
  }
}
function checkDirectory(directory: string) {
  const info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid!() ||
    (info.mode & 0o777) !== 0o700 ||
    realpathSync(directory) !== directory
  )
    throw new Error();
  accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK);
}
function privateDirectory(directory: string) {
  if (!existsSync(directory))
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  checkDirectory(directory);
}
function privateFile(file: string) {
  let descriptor: number | undefined;
  try {
    // No following symlinks, no FIFO blocking, no truncation or silent reset.
    descriptor = openSync(
      file,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    const info = fstatSync(descriptor);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid!() ||
      (info.mode & 0o777) !== 0o600
    )
      throw new Error();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
export function initializeRuntimePaths(
  configuredRoot: string | null,
): FoundationResult<RuntimePaths> {
  try {
    // The supported application/process-test platforms have POSIX ownership.
    if (process.platform !== "darwin" && process.platform !== "linux")
      return unavailable();
    const root = resolveCandidate(configuredRoot ?? developmentRuntimeRoot());
    privateDirectory(root);
    const data = path.join(root, "data");
    const temporary = path.join(root, "tmp");
    privateDirectory(data);
    privateDirectory(temporary);
    // Actual create/remove verifies writability even when access() is permissive.
    const probe = mkdtempSync(path.join(temporary, "probe-"));
    rmSync(probe, { recursive: true });
    const verify = () => {
      assertOutsideRepository(root);
      checkParentTrust(root);
      for (const directory of [root, data, temporary])
        checkDirectory(directory);
    };
    let temporaryActive = false;
    return {
      ok: true,
      value: Object.freeze({
        courseSourceDirectory() {
          verify();
          const directory = path.join(data, "course-sources");
          privateDirectory(directory);
          return directory;
        },
        speechDirectory() {
          verify();
          const directory = path.join(temporary, "speech");
          privateDirectory(directory);
          return directory;
        },
        prepareDatabaseFile() {
          verify();
          const database = path.join(data, "foundation.sqlite");
          privateFile(database);
          // SQLite itself opens sidecars; reject aliases before it can touch them.
          for (const suffix of ["-journal", "-wal", "-shm"]) {
            const sidecar = database + suffix;
            if (lstatSync(sidecar, { throwIfNoEntry: false }))
              privateFile(sidecar);
          }
          return database;
        },
        async withTemporaryWork<T>(
          operation: (directory: string) => Promise<T>,
        ): Promise<FoundationResult<T>> {
          if (temporaryActive) return unavailable();
          temporaryActive = true;
          let directory: string | undefined;
          let result: FoundationResult<T>;
          let cleanupFailed = false;
          try {
            verify();
            directory = mkdtempSync(path.join(temporary, "operation-"));
            result = { ok: true, value: await operation(directory) };
          } catch {
            result = unavailable();
          } finally {
            if (directory !== undefined) {
              try {
                verify();
                rmSync(directory, { recursive: true });
              } catch {
                result = unavailable();
                cleanupFailed = true;
              }
            }
          }
          temporaryActive = cleanupFailed;
          return result!;
        },
      }),
    };
  } catch {
    return unavailable();
  }
}
