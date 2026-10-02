import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  isShortSpokenAnswer,
  reviewedPolicyRuntimeContract,
} from "@laita/contracts";
import type { RuntimePaths } from "@laita/runtime";
export const speechProfile = reviewedPolicyRuntimeContract.successor.speech;
export interface SttAdapter {
  readonly identity: string;
  // Settle only after the worker exits and all file handles close.
  transcribe(
    file: string,
    language: "auto",
    signal: AbortSignal,
  ): Promise<string>;
}
export type SpeechLanguage = "en" | "zh";
export interface TtsAdapter {
  readonly identity: string;
  // Settle only after the worker exits and every output handle is closed.
  synthesize(
    text: string,
    language: SpeechLanguage,
    output: string,
    signal: AbortSignal,
  ): Promise<void>;
}
export type SpeechOutcome =
  | { state: "REVIEW"; text: string; cleanup: "DELETED" }
  | {
      state: "INVALID" | "FAILED" | "CANCELLED" | "TIMEOUT" | "CLEANUP_FAILED";
      cleanup: "DELETED" | "FAILED";
    };
export type SynthesisOutcome =
  | { state: "SKIPPED_LONG_ANSWER"; cleanup: "DELETED" }
  | {
      state: "READY";
      cleanup: "PENDING";
      mediaRef: string;
      contentType: "audio/wav";
      language: SpeechLanguage;
      expiresAtEpochSeconds: number;
    }
  | {
      state: "FAILED" | "CANCELLED" | "TIMEOUT" | "CLEANUP_FAILED";
      reason?: "ADAPTER_FAILED" | "INVALID_MEDIA" | "MEDIA_LIMIT";
      cleanup: "DELETED" | "FAILED";
    };
const mediaMaxBytes = 2 * 1024 * 1024;
const mediaLifetimeMs = speechProfile.maxAudioLifetimeSeconds * 1000;
const mediaRef = () => randomBytes(32).toString("hex");
export function speechLanguage(text: string): SpeechLanguage {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return han > 0 && han * 2 >= latin ? "zh" : "en";
}
export function validatePlaybackWav(b: Buffer): boolean {
  if (
    b.length < 44 ||
    b.length > mediaMaxBytes ||
    b.toString("latin1", 0, 4) !== "RIFF" ||
    b.readUInt32LE(4) !== b.length - 8 ||
    b.toString("latin1", 8, 12) !== "WAVE"
  )
    return false;
  let offset = 12,
    sampleRate = 0,
    bytesPerSecond = 0,
    dataBytes = 0,
    formatSeen = false,
    dataSeen = false;
  while (offset + 8 <= b.length) {
    const id = b.toString("latin1", offset, offset + 4);
    const size = b.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > b.length) return false;
    if (id === "fmt ") {
      if (
        formatSeen ||
        size < 16 ||
        b.readUInt16LE(start) !== 1 ||
        b.readUInt16LE(start + 2) !== 1 ||
        b.readUInt16LE(start + 14) !== 16
      )
        return false;
      sampleRate = b.readUInt32LE(start + 4);
      bytesPerSecond = b.readUInt32LE(start + 8);
      if (
        sampleRate < 8_000 ||
        sampleRate > 48_000 ||
        bytesPerSecond !== sampleRate * 2
      )
        return false;
      formatSeen = true;
    } else if (id === "data") {
      if (dataSeen || size === 0 || size % 2 !== 0) return false;
      dataBytes = size;
      dataSeen = true;
    }
    offset = end + (size % 2);
  }
  return (
    offset === b.length &&
    formatSeen &&
    dataSeen &&
    dataBytes / bytesPerSecond <= speechProfile.tts.maxPlaybackSeconds
  );
}
export function validateWav(b: Buffer): boolean {
  if (
    b.length < 3244 ||
    b.length > 44 + speechProfile.stt.maxCaptureSeconds * 32000
  )
    return false;
  if (
    b.toString("latin1", 0, 4) !== "RIFF" ||
    b.readUInt32LE(4) !== b.length - 8 ||
    b.toString("latin1", 8, 12) !== "WAVE" ||
    b.toString("latin1", 12, 16) !== "fmt " ||
    b.readUInt32LE(16) !== 16 ||
    b.readUInt16LE(20) !== 1 ||
    b.readUInt16LE(22) !== 1 ||
    b.readUInt32LE(24) !== 16000 ||
    b.readUInt32LE(28) !== 32000 ||
    b.readUInt16LE(32) !== 2 ||
    b.readUInt16LE(34) !== 16 ||
    b.toString("latin1", 36, 40) !== "data" ||
    b.readUInt32LE(40) !== b.length - 44 ||
    (b.length - 44) % 2 !== 0
  )
    return false;
  let energy = 0;
  for (let i = 44; i < b.length; i += 2) energy += b.readInt16LE(i) ** 2;
  return Math.sqrt(energy / ((b.length - 44) / 2)) >= 32;
}
export function createSpeechService(options: {
  paths: Pick<RuntimePaths, "speechDirectory">;
  adapter?: SttAdapter;
  ttsAdapter?: TtsAdapter;
  removeFile?: (file: string) => void;
  timeoutMs?: number;
  now?: () => number;
}) {
  let active = false;
  let disabled = false;
  const remove = options.removeFile ?? unlinkSync;
  const now = options.now ?? Date.now;
  const media = new Map<
    string,
    { owner: string; directory: string; file: string; expires: number }
  >();
  function removeDirectory(directory: string) {
    const files = readdirSync(directory);
    if (files.length > 8) return false;
    for (const name of files) {
      const file = path.join(directory, name);
      if (lstatSync(file).isDirectory()) return false;
      remove(file);
    }
    rmdirSync(directory);
    return true;
  }
  function cleanAll() {
    try {
      const root = options.paths.speechDirectory();
      const entries = readdirSync(root);
      if (entries.length > 32) return false;
      for (const name of entries) {
        const directory = path.join(root, name);
        const stat = lstatSync(directory);
        if (!stat.isDirectory()) {
          remove(directory);
          continue;
        }
        if (!removeDirectory(directory)) return false;
      }
      return readdirSync(root).length === 0;
    } catch {
      return false;
    }
  }
  function recover() {
    if (active) return false;
    media.clear();
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) ok = cleanAll();
    disabled = !ok;
    return ok;
  }
  recover();
  function release(ref: string) {
    const entry = media.get(ref);
    if (!entry) return true;
    media.delete(ref);
    try {
      if (!removeDirectory(entry.directory)) throw new Error();
      return true;
    } catch {
      disabled = true;
      return false;
    }
  }
  function expire() {
    if (active) return;
    for (const [ref, entry] of media) if (entry.expires <= now()) release(ref);
  }
  const sweeper = setInterval(() => {
    if (disabled && !active) recover();
    else expire();
  }, 30_000);
  sweeper.unref();
  return {
    status() {
      return disabled
        ? "CLEANUP_FAILED"
        : active
          ? "BUSY"
          : options.adapter
            ? "READY"
            : "DISABLED";
    },
    identity: options.adapter?.identity ?? "NOT_CONFIGURED",
    ttsStatus() {
      return disabled
        ? "CLEANUP_FAILED"
        : active
          ? "BUSY"
          : options.ttsAdapter
            ? "READY"
            : "DISABLED";
    },
    ttsIdentity: options.ttsAdapter?.identity ?? "NOT_CONFIGURED",
    recover,
    close() {
      clearInterval(sweeper);
      if (!active) recover();
    },
    async transcribe(
      b: Buffer,
      language: "auto",
      signal: AbortSignal,
    ): Promise<SpeechOutcome> {
      if (active || disabled || !options.adapter) {
        b.fill(0);
        return { state: "FAILED", cleanup: disabled ? "FAILED" : "DELETED" };
      }
      active = true;
      const controller = new AbortController();
      const abort = () => controller.abort();
      let timedOut = false;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(
        () => {
          timedOut = true;
          abort();
        },
        Math.min(
          options.timeoutMs ?? 30_000,
          speechProfile.stt.maxProcessingSeconds * 1000,
        ),
      );
      let state: Exclude<SpeechOutcome["state"], "CLEANUP_FAILED"> = "FAILED";
      let text = "";
      let directory: string | undefined;
      try {
        if (controller.signal.aborted) state = "CANCELLED";
        else if (!validateWav(b)) state = "INVALID";
        else {
          const root = options.paths.speechDirectory();
          directory = path.join(root, randomBytes(32).toString("hex"));
          // This durable directory registers ownership before the first byte.
          mkdirSync(directory, { mode: 0o700 });
          const file = path.join(directory, "input.wav");
          writeFileSync(file, b, { flag: "wx", mode: 0o600 });
          b.fill(0);
          text = await options.adapter.transcribe(
            file,
            language,
            controller.signal,
          );
          state =
            typeof text === "string" &&
            text.trim() &&
            Buffer.byteLength(text) <= 8192
              ? "REVIEW"
              : "INVALID";
        }
      } catch {
        state = "FAILED";
      } finally {
        b.fill(0);
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        active = false;
      }
      if (directory) {
        try {
          if (!removeDirectory(directory)) throw new Error();
        } catch {
          disabled = true;
          return { state: "CLEANUP_FAILED", cleanup: "FAILED" };
        }
      }
      if (controller.signal.aborted)
        return {
          state: timedOut ? "TIMEOUT" : "CANCELLED",
          cleanup: "DELETED",
        };
      return state === "REVIEW"
        ? { state, text: text.trim(), cleanup: "DELETED" }
        : { state, cleanup: "DELETED" };
    },
    async synthesize(
      text: string,
      language: SpeechLanguage,
      owner: string,
      signal: AbortSignal,
    ): Promise<SynthesisOutcome> {
      if (signal.aborted) return { state: "CANCELLED", cleanup: "DELETED" };
      if (text.trim() && !isShortSpokenAnswer(text))
        return { state: "SKIPPED_LONG_ANSWER", cleanup: "DELETED" };
      if (
        active ||
        disabled ||
        !options.ttsAdapter ||
        !/^[a-f0-9]{64}$/u.test(owner) ||
        !text.trim()
      )
        return { state: "FAILED", cleanup: disabled ? "FAILED" : "DELETED" };
      expire();
      if (disabled) return { state: "CLEANUP_FAILED", cleanup: "FAILED" };
      active = true;
      const controller = new AbortController();
      const abort = () => controller.abort();
      let timedOut = false;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(
        () => {
          timedOut = true;
          abort();
        },
        Math.min(
          options.timeoutMs ?? 30_000,
          speechProfile.tts.maxProcessingSeconds * 1000,
        ),
      );
      let reason:
        "ADAPTER_FAILED" | "INVALID_MEDIA" | "MEDIA_LIMIT" | undefined;
      let directory: string | undefined;
      let output: string | undefined;
      try {
        if (controller.signal.aborted) throw new Error();
        // Only one volatile replay buffer is retained for each conversation.
        for (const [ref, entry] of media)
          if (entry.owner === owner && !release(ref)) throw new Error();
        if (media.size >= 16) throw new Error();
        const root = options.paths.speechDirectory();
        directory = path.join(root, randomBytes(32).toString("hex"));
        mkdirSync(directory, { mode: 0o700 });
        output = path.join(directory, "output.wav");
        reason = "ADAPTER_FAILED";
        await options.ttsAdapter.synthesize(
          text,
          language,
          output,
          controller.signal,
        );
        if (controller.signal.aborted) throw new Error();
        reason = "INVALID_MEDIA";
        if (statSync(output).size > mediaMaxBytes) {
          reason = "MEDIA_LIMIT";
          throw new Error();
        }
        const bytes = readFileSync(output);
        const valid = validatePlaybackWav(bytes);
        bytes.fill(0);
        if (!valid) throw new Error();
        reason = undefined;
        for (const name of readdirSync(directory))
          if (name !== "output.wav") remove(path.join(directory, name));
        const ref = mediaRef();
        const expires = now() + mediaLifetimeMs;
        media.set(ref, { owner, directory, file: output, expires });
        directory = undefined;
        return {
          state: "READY",
          cleanup: "PENDING",
          mediaRef: ref,
          contentType: "audio/wav",
          language,
          expiresAtEpochSeconds: Math.floor(expires / 1000),
        };
      } catch {
        if (directory) {
          try {
            if (!removeDirectory(directory)) throw new Error();
          } catch {
            disabled = true;
            return { state: "CLEANUP_FAILED", cleanup: "FAILED" };
          }
        }
        if (disabled) return { state: "CLEANUP_FAILED", cleanup: "FAILED" };
        return {
          state: timedOut
            ? "TIMEOUT"
            : controller.signal.aborted
              ? "CANCELLED"
              : "FAILED",
          ...(!timedOut && !controller.signal.aborted && reason
            ? { reason }
            : {}),
          cleanup: "DELETED",
        };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        active = false;
      }
    },
    take(owner: string, ref: string) {
      expire();
      const entry = media.get(ref);
      if (!entry || entry.owner !== owner || entry.expires <= now()) return;
      let bytes: Buffer | undefined;
      try {
        bytes = readFileSync(entry.file);
        if (!validatePlaybackWav(bytes)) throw new Error();
        if (!release(ref)) throw new Error();
        return bytes;
      } catch {
        bytes?.fill(0);
        release(ref);
        return;
      }
    },
    release(owner: string, ref: string) {
      const entry = media.get(ref);
      return !entry ? true : entry.owner === owner && release(ref);
    },
    releaseOwner(owner: string) {
      let ok = true;
      for (const [ref, entry] of media)
        if (entry.owner === owner) ok = release(ref) && ok;
      return ok;
    },
  };
}
export { loadWhisperAdapter, whisperIdentity } from "./whisper.ts";
export {
  loadMacOSTtsAdapter,
  macOSTtsIdentity,
  selectLocalVoices,
} from "./tts.ts";
