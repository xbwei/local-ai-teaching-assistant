import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const fail = () => {
  throw new Error("PROFILE_INVALID");
};
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export function canonical(file) {
  if (
    typeof file !== "string" ||
    !path.isAbsolute(file) ||
    path.normalize(file) !== file ||
    /[\0-\x1f\x7f]/u.test(file) ||
    realpathSync(file) !== file
  )
    fail();
  // Reject files in any checkout, including adjacent worktrees and nested repos.
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    try {
      lstatSync(path.join(dir, ".git"));
      fail();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (dir === path.dirname(dir)) break;
  }
  return file;
}
const same = (a, b) =>
  ["dev", "ino", "size", "mtimeMs", "ctimeMs", "mode", "uid", "nlink"].every(
    (key) => a[key] === b[key],
  );
export function privateFile(file, read = true) {
  canonical(file);
  const parent = lstatSync(path.dirname(file));
  if (
    !parent.isDirectory() ||
    parent.uid !== process.getuid() ||
    (parent.mode & 0o7777) !== 0o700
  )
    fail();
  const before = lstatSync(file);
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    before.uid !== process.getuid() ||
    (before.mode & 0o7777) !== 0o600 ||
    before.size > 32768
  )
    fail();
  const fd = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!same(before, fstatSync(fd))) fail();
    const bytes = read ? readFileSync(fd) : null;
    if (
      !same(before, fstatSync(fd)) ||
      !same(before, lstatSync(file)) ||
      !same(parent, lstatSync(path.dirname(file)))
    )
      fail();
    return {
      bytes,
      unchanged: () => {
        canonical(file);
        if (
          !same(before, lstatSync(file)) ||
          !same(parent, lstatSync(path.dirname(file)))
        )
          fail();
      },
    };
  } finally {
    closeSync(fd);
  }
}
