import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { TtsAdapter } from "./index.ts";

export const macOSTtsIdentity = "macos-say/local-bilingual-v1";

export function selectLocalVoices(output: string) {
  const voices: { name: string; language: string }[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/u);
    if (match) voices.push({ name: match[1]!.trim(), language: match[2]! });
  }
  const choose = (language: "en" | "zh", preferred: string) =>
    voices.find((v) => v.name === preferred && v.language.startsWith(language))
      ?.name ?? voices.find((v) => v.language.startsWith(language))?.name;
  const en = choose("en", "Samantha");
  const zh = choose("zh", "Tingting");
  return en && zh ? { en, zh } : undefined;
}

export function runSynthesisProcess(
  createChild: () => Pick<ChildProcess, "stdin" | "once" | "pid" | "kill">,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error());
  return new Promise((resolve, reject) => {
    const child = createChild();
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
      if (code === 0 && !failed && !signal.aborted) resolve();
      else reject(new Error());
    });
    signal.addEventListener("abort", kill, { once: true });
    if (!child.stdin) kill();
    else {
      child.stdin.on("error", kill);
      child.stdin.end(text, "utf8");
    }
    if (signal.aborted) kill();
  });
}

export function loadMacOSTtsAdapter(): TtsAdapter | undefined {
  if (process.platform !== "darwin") return;
  const inventory = spawnSync("/usr/bin/say", ["-v", "?"], {
    shell: false,
    timeout: 3_000,
    maxBuffer: 64 * 1024,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  if (inventory.status !== 0 || inventory.error) return;
  const voices = selectLocalVoices(inventory.stdout);
  if (!voices) return;
  return {
    identity: macOSTtsIdentity,
    synthesize(text, language, output, signal) {
      if (signal.aborted) return Promise.reject(new Error());
      return runSynthesisProcess(
        () =>
          spawn(
            "/usr/bin/say",
            [
              "-v",
              voices[language],
              "-o",
              output,
              "--file-format=WAVE",
              "--data-format=LEI16@22050",
            ],
            {
              shell: false,
              detached: true,
              cwd: "/private/tmp",
              stdio: ["pipe", "ignore", "ignore"],
              env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
            },
          ),
        text,
        signal,
      );
    },
  };
}
