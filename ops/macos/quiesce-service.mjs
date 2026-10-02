import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Fixed budgets, never configurable by deployment environment variables.
const observations = 20;
const intervalMs = 250;
const pause = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function quiesceService(executable, target, dependencies = {}) {
  const run = dependencies.run ?? spawnSync;
  const wait = dependencies.pause ?? pause;
  const match = /^gui\/([0-9]+)\/([A-Za-z0-9][A-Za-z0-9.-]{0,127})$/.exec(
    target,
  );
  if (!path.isAbsolute(executable) || !match) throw new Error();
  const missing = `Bad request.\nCould not find service "${match[2]}" in domain for user gui: ${match[1]}`;
  const command = (verb) => {
    const result = run(executable, [verb, target], {
      encoding: "utf8",
      timeout: verb === "bootout" ? 5000 : 1000,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024,
      env: {
        ...process.env,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LC_ALL: "C",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.signal) throw new Error();
    return result;
  };
  const unloaded = () => {
    const result = command("print");
    if (
      result.status === 113 &&
      result.stdout === "" &&
      result.stderr.trimEnd() === missing
    )
      return true;
    if (
      result.status === 0 &&
      result.stderr === "" &&
      /^\s*state = \S+/m.test(result.stdout)
    )
      return false;
    // Permission errors, missing domains, malformed output and timeouts are not absence.
    throw new Error();
  };
  if (unloaded()) return;
  const result = command("bootout");
  if (result.status !== 0 || result.stdout !== "" || result.stderr !== "")
    throw new Error();
  for (let attempt = 0; attempt < observations; attempt++) {
    if (unloaded()) return;
    if (attempt + 1 < observations) wait(intervalMs);
  }
  throw new Error();
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 4) throw new Error();
    quiesceService(process.argv[2], process.argv[3]);
  } catch {
    // Never forward launchctl output containing private service/domain identifiers.
    process.exitCode = 1;
  }
}
