import { StringDecoder } from "node:string_decoder";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, readFileSync } from "node:fs";
import path from "node:path";
import type { SttAdapter } from "./index.ts";
export const whisperIdentity = "whisper.cpp/1.8.3/small-multilingual/ggml-f16";
const modelSha256 =
  "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b";
function protectedFile(file: string, max: number, exactSize = false) {
  if (!path.isAbsolute(file) || realpathSync(file) !== file) throw new Error();
  const stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid!() ||
    (stat.mode & 0o022) !== 0 ||
    stat.size > max ||
    (exactSize && stat.size !== max)
  )
    throw new Error();
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const s = lstatSync(dir);
    if (
      !s.isDirectory() ||
      (s.uid !== 0 && s.uid !== process.getuid!()) ||
      (s.mode & 0o022) !== 0
    )
      throw new Error();
    if (dir === path.dirname(dir)) break;
  }
  return readFileSync(file);
}
export function loadWhisperAdapter(
  profilePath?: string,
): SttAdapter | undefined {
  if (!profilePath) return;
  if ((lstatSync(profilePath).mode & 0o777) !== 0o600) throw new Error();
  const c = JSON.parse(protectedFile(profilePath, 4096).toString("utf8"));
  if (
    !c ||
    Object.keys(c).sort().join(",") !== "binary,binarySha256,identity,model" ||
    c.identity !== whisperIdentity ||
    typeof c.binary !== "string" ||
    typeof c.model !== "string" ||
    !/^[a-f0-9]{64}$/u.test(c.binarySha256)
  )
    throw new Error();
  const verify = () => {
    if (
      createHash("sha256")
        .update(protectedFile(c.binary, 64 * 1024 * 1024))
        .digest("hex") !== c.binarySha256 ||
      createHash("sha256")
        .update(protectedFile(c.model, 487601967, true))
        .digest("hex") !== modelSha256
    )
      throw new Error();
  };
  verify();
  return {
    identity: whisperIdentity,
    async transcribe(file, language, signal) {
      verify();
      if (signal.aborted) throw new Error();
      return transcribeProcess(
        () =>
          spawn(
            c.binary,
            [
              "-m",
              c.model,
              "-f",
              file,
              "-l",
              language,
              "-t",
              "2",
              "-ng",
              "-nt",
              "-np",
            ],
            {
              shell: false,
              detached: true,
              cwd: path.dirname(file),
              stdio: ["ignore", "pipe", "ignore"],
              env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
            },
          ),
        signal,
      );
    },
  };
}

// Internal process seam: tests provide synthetic streams, never a model install.
export function transcribeProcess(
  createChild: () => Pick<ChildProcess, "stdout" | "once" | "pid" | "kill">,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) return Promise.reject(new Error());
  return new Promise((resolve, reject) => {
    const child = createChild();
    const decoder = new StringDecoder("utf8");
    let output = "";
    let bytes = 0;
    let failed = false;
    const kill = () => {
      failed = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", kill);
      if (code === 0 && !failed && !signal.aborted)
        resolve(output + decoder.end());
      else reject(new Error());
      output = "";
    });
    signal.addEventListener("abort", kill, { once: true });
    if (child.stdout) {
      child.stdout.on("error", kill);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 8192) kill();
        else output += decoder.write(chunk);
        chunk.fill(0);
      });
    } else kill();
    if (signal.aborted) kill();
  });
}
