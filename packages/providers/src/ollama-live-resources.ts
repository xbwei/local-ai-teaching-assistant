import { execFile } from "node:child_process";

import type { OllamaLiveResourceSample } from "./ollama-live-harness.ts";

const MAX_OUTPUT_BYTES = 16 * 1024;
const COMMAND_TIMEOUT_MS = 5_000;

function command(
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: COMMAND_TIMEOUT_MS,
        signal,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

function parseMemoryAvailablePercent(output: string): number | undefined {
  const match = /System-wide memory free percentage:\s*([0-9]{1,3})%/.exec(
    output,
  );
  const value = match ? Number(match[1]) : undefined;
  return Number.isSafeInteger(value) && Number(value) <= 100
    ? value
    : undefined;
}

function parseSwapUsedBytes(output: string): number | undefined {
  const match = /\bused\s*=\s*([0-9]+(?:\.[0-9]+)?)([KMG])\b/i.exec(output);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2]?.toUpperCase();
  const multiplier = unit === "G" ? 2 ** 30 : unit === "M" ? 2 ** 20 : 2 ** 10;
  const bytes = Math.round(value * multiplier);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
}

async function ollamaProcessMemoryBytes(
  signal: AbortSignal,
): Promise<number | undefined> {
  let identifiers: string;
  try {
    identifiers = await command("/usr/bin/pgrep", ["-x", "ollama"], signal);
  } catch (error) {
    return error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 1
      ? 0
      : undefined;
  }
  const pids = identifiers
    .trim()
    .split(/\s+/)
    .filter((entry) => /^[1-9][0-9]*$/.test(entry))
    .slice(0, 32);
  if (pids.length === 0) return 0;
  try {
    const output = await command(
      "/bin/ps",
      ["-o", "rss=", "-p", pids.join(",")],
      signal,
    );
    const kibibytes = output
      .trim()
      .split(/\s+/)
      .filter((entry) => /^[0-9]+$/.test(entry))
      .reduce((total, entry) => total + Number(entry), 0);
    const bytes = kibibytes * 1024;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

export async function sampleMacOllamaResources(
  signal: AbortSignal,
): Promise<OllamaLiveResourceSample> {
  if (process.platform !== "darwin" || signal.aborted) {
    return { status: "NOT_AVAILABLE" };
  }
  const [memory, swap, processMemory] = await Promise.all([
    command("/usr/bin/memory_pressure", ["-Q"], signal)
      .then(parseMemoryAvailablePercent)
      .catch(() => undefined),
    command("/usr/sbin/sysctl", ["-n", "vm.swapusage"], signal)
      .then(parseSwapUsedBytes)
      .catch(() => undefined),
    ollamaProcessMemoryBytes(signal),
  ]);
  if (
    memory === undefined &&
    swap === undefined &&
    processMemory === undefined
  ) {
    return { status: signal.aborted ? "INTERRUPTED" : "NOT_AVAILABLE" };
  }
  return {
    status: "MEASURED",
    ...(memory === undefined ? {} : { memoryAvailablePercent: memory }),
    ...(swap === undefined ? {} : { swapUsedBytes: swap }),
    ...(processMemory === undefined
      ? {}
      : { ollamaProcessMemoryBytes: processMemory }),
  };
}
