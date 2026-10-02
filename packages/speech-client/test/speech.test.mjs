import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createSpeechService,
  speechLanguage,
  validatePlaybackWav,
  validateWav,
  loadWhisperAdapter,
} from "../dist/index.js";
function wav() {
  const b = Buffer.alloc(3244);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(b.length - 44, 40);
  for (let i = 44; i < b.length; i += 2) b.writeInt16LE(500 * Math.sin(i), i);
  return b;
}
function fixture(t, adapter, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "speech-test-"));
  const service = createSpeechService({
    paths: { speechDirectory: () => root },
    ...(adapter
      ? { adapter: { identity: "synthetic-stt", transcribe: adapter } }
      : {}),
    ...options,
  });
  t.after(() => {
    service.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, service };
}
test("valid PCM only; silence, truncated, extra chunks, malformed, oversized", () => {
  assert.equal(validateWav(wav()), true);
  for (const change of [
    (b) => b.fill(0, 44),
    (b) => b.subarray(0, 100),
    (b) => Buffer.concat([b, Buffer.from("extra")]),
    (b) => {
      b.writeUInt16LE(2, 22);
      return b;
    },
    () => Buffer.alloc(524289),
    (b) => {
      b.write("../x", 0);
      return b;
    },
  ])
    assert.equal(validateWav(change(wav())), false);
});
test("answer language selection and playback WAV validation are deterministic", () => {
  assert.equal(speechLanguage("A complete English answer."), "en");
  assert.equal(speechLanguage("这是一个完整的中文回答。"), "zh");
  assert.equal(speechLanguage("Explain the 中文 label in English."), "en");
  assert.equal(validatePlaybackWav(wav()), true);
  const tooLong = Buffer.alloc(44 + 61 * 32000);
  wav().copy(tooLong, 0, 0, 44);
  tooLong.writeUInt32LE(tooLong.length - 8, 4);
  tooLong.writeUInt32LE(tooLong.length - 44, 40);
  assert.equal(validatePlaybackWav(tooLong), false);
});
test("TTS bounds the native output file before allocating its contents", () => {
  const source = readFileSync(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );
  const sizeCheck = source.indexOf(
    "if (statSync(output).size > mediaMaxBytes)",
  );
  const fileRead = source.indexOf("const bytes = readFileSync(output);");
  assert.ok(sizeCheck >= 0 && fileRead > sizeCheck);
});
test("local synthesis retains one opaque media item, consumes it once and releases on reset/expiry", async (t) => {
  let now = 1_000_000;
  const observed = [];
  const { root, service } = fixture(t, async () => "text", {
    now: () => now,
    ttsAdapter: {
      identity: "synthetic-local-tts",
      async synthesize(text, language, output) {
        observed.push({ text, language, output: path.basename(output) });
        writeFileSync(output, wav(), { flag: "wx", mode: 0o600 });
      },
    },
  });
  const owner = "a".repeat(64);
  const first = await service.synthesize(
    "A complete answer.",
    "en",
    owner,
    new AbortController().signal,
  );
  assert.equal(first.state, "READY");
  assert.deepEqual(observed[0], {
    text: "A complete answer.",
    language: "en",
    output: "output.wav",
  });
  assert.equal(readdirSync(root).length, 1);
  assert.equal(service.take("b".repeat(64), first.mediaRef), undefined);
  const bytes = service.take(owner, first.mediaRef);
  assert.equal(validatePlaybackWav(bytes), true);
  bytes.fill(0);
  assert.equal(service.take(owner, first.mediaRef), undefined);
  assert.deepEqual(readdirSync(root), []);

  const second = await service.synthesize(
    "这是中文回答。",
    "zh",
    owner,
    new AbortController().signal,
  );
  assert.equal(second.state, "READY");
  assert.equal(service.releaseOwner(owner), true);
  assert.deepEqual(readdirSync(root), []);

  const third = await service.synthesize(
    "Expiring answer.",
    "en",
    owner,
    new AbortController().signal,
  );
  now = third.expiresAtEpochSeconds * 1000 + 1;
  assert.equal(service.take(owner, third.mediaRef), undefined);
  assert.deepEqual(readdirSync(root), []);
});
test("expired retained media is reclaimed before synthesis capacity is checked", async (t) => {
  let now = 1_000_000;
  const { root, service } = fixture(t, async () => "text", {
    now: () => now,
    ttsAdapter: {
      identity: "synthetic-local-tts",
      async synthesize(_text, _language, output) {
        writeFileSync(output, wav(), { flag: "wx", mode: 0o600 });
      },
    },
  });
  const retained = [];
  for (let i = 0; i < 16; i++)
    retained.push(
      await service.synthesize(
        `answer ${i}`,
        "en",
        i.toString(16).padStart(64, "0"),
        new AbortController().signal,
      ),
    );
  assert.equal(
    retained.every((entry) => entry.state === "READY"),
    true,
  );
  assert.equal(readdirSync(root).length, 16);
  now =
    Math.max(...retained.map((entry) => entry.expiresAtEpochSeconds)) * 1000;
  const next = await service.synthesize(
    "next answer",
    "en",
    "f".repeat(64),
    new AbortController().signal,
  );
  assert.equal(next.state, "READY");
  assert.equal(readdirSync(root).length, 1);
});
test("TTS character, concurrency, timeout and cancellation bounds clean partial output", async (t) => {
  let finish;
  const entered = new Promise((resolve) => {
    finish = resolve;
  });
  let observedText = "";
  const { root, service } = fixture(t, async () => "text", {
    timeoutMs: 20,
    ttsAdapter: {
      identity: "synthetic-local-tts",
      async synthesize(text, _language, output, signal) {
        observedText = text;
        await entered;
        writeFileSync(output, wav(), { flag: "wx", mode: 0o600 });
        if (signal.aborted) throw new Error();
      },
    },
  });
  const owner = "a".repeat(64);
  const controller = new AbortController();
  const first = service.synthesize(
    "Short complete answer.",
    "en",
    owner,
    controller.signal,
  );
  assert.equal(service.ttsStatus(), "BUSY");
  assert.deepEqual(
    await service.synthesize(
      "second",
      "en",
      owner,
      new AbortController().signal,
    ),
    { state: "FAILED", cleanup: "DELETED" },
  );
  controller.abort();
  finish();
  assert.equal((await first).state, "CANCELLED");
  assert.equal(observedText, "Short complete answer.");
  assert.deepEqual(readdirSync(root), []);

  let timeoutFinish;
  const timeoutService = createSpeechService({
    paths: { speechDirectory: () => root },
    timeoutMs: 5,
    ttsAdapter: {
      identity: "synthetic-local-tts",
      synthesize: () =>
        new Promise((resolve) => {
          timeoutFinish = resolve;
        }),
    },
  });
  t.after(() => timeoutService.close());
  const timed = timeoutService.synthesize(
    "timeout",
    "en",
    owner,
    new AbortController().signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  timeoutFinish();
  assert.equal((await timed).state, "TIMEOUT");
  assert.deepEqual(readdirSync(root), []);
});
test("generated-media deletion failure revokes access and disables all speech until bounded recovery", async (t) => {
  let fail = true;
  const { root, service } = fixture(t, async () => "text", {
    ttsAdapter: {
      identity: "synthetic-local-tts",
      async synthesize(_text, _language, output) {
        writeFileSync(output, wav(), { flag: "wx", mode: 0o600 });
      },
    },
    removeFile(file) {
      if (fail) throw new Error();
      unlinkSync(file);
    },
  });
  const owner = "a".repeat(64);
  const media = await service.synthesize(
    "answer",
    "en",
    owner,
    new AbortController().signal,
  );
  assert.equal(media.state, "READY");
  assert.equal(service.releaseOwner(owner), false);
  assert.equal(service.ttsStatus(), "CLEANUP_FAILED");
  assert.equal(service.status(), "CLEANUP_FAILED");
  assert.equal(service.take(owner, media.mediaRef), undefined);
  fail = false;
  assert.equal(service.recover(), true);
  assert.equal(service.ttsStatus(), "READY");
  assert.deepEqual(readdirSync(root), []);
});
test("replacing retained media reports cleanup failure instead of ordinary synthesis failure", async (t) => {
  let fail = false;
  const { service } = fixture(t, async () => "text", {
    ttsAdapter: {
      identity: "synthetic-local-tts",
      async synthesize(_text, _language, output) {
        writeFileSync(output, wav(), { flag: "wx", mode: 0o600 });
      },
    },
    removeFile(file) {
      if (fail) throw new Error();
      unlinkSync(file);
    },
  });
  const owner = "a".repeat(64);
  assert.equal(
    (
      await service.synthesize(
        "first",
        "en",
        owner,
        new AbortController().signal,
      )
    ).state,
    "READY",
  );
  fail = true;
  assert.deepEqual(
    await service.synthesize(
      "second",
      "en",
      owner,
      new AbortController().signal,
    ),
    { state: "CLEANUP_FAILED", cleanup: "FAILED" },
  );
  assert.equal(service.ttsStatus(), "CLEANUP_FAILED");
});
test("success deletes raw and every conversion before returning review; no invented confidence", async (t) => {
  const { root, service } = fixture(t, async (file, language) => {
    assert.equal(language, "auto");
    assert.equal(validateWav(readFileSync(file)), true);
    writeFileSync(path.join(path.dirname(file), "conversion.tmp"), "synthetic");
    return "Explain a tree.";
  });
  const b = wav();
  const result = await service.transcribe(
    b,
    "auto",
    new AbortController().signal,
  );
  assert.deepEqual(result, {
    state: "REVIEW",
    text: "Explain a tree.",
    cleanup: "DELETED",
  });
  assert.deepEqual(readdirSync(root), []);
  assert.equal(
    b.every((v) => v === 0),
    true,
  );
});
test("failure, no-speech/noise output, malformed, timeout and cancellation all clear files", async (t) => {
  for (const mode of [
    "throw",
    "empty",
    "oversize",
    "timeout",
    "cancel",
    "invalid",
  ]) {
    const { root, service } = fixture(
      t,
      async (_file, _lang, signal) => {
        if (mode === "throw") throw new Error("private-path");
        if (mode === "empty") return "";
        if (mode === "oversize") return "x".repeat(8193);
        await new Promise((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
          if (signal.aborted) resolve();
        });
        throw new Error();
      },
      { timeoutMs: 5 },
    );
    const c = new AbortController();
    if (mode === "cancel") setTimeout(() => c.abort(), 1);
    const result = await service.transcribe(
      mode === "invalid" ? Buffer.alloc(32) : wav(),
      "auto",
      c.signal,
    );
    assert.notEqual(result.state, "REVIEW");
    assert.equal(result.cleanup, "DELETED");
    assert.deepEqual(readdirSync(root), []);
  }
});
test("concurrency rejects; cancellation waits for adapter settlement and cleanup", async (t) => {
  let finish;
  const { root, service } = fixture(
    t,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const c = new AbortController();
  const first = service.transcribe(wav(), "en", c.signal);
  assert.equal(service.status(), "BUSY");
  const second = await service.transcribe(wav(), "en", c.signal);
  assert.equal(second.state, "FAILED");
  c.abort();
  assert.equal(service.status(), "BUSY");
  finish("late transcript");
  assert.equal((await first).state, "CANCELLED");
  assert.deepEqual(readdirSync(root), []);
});
test("deletion failure disables intake; bounded recovery; startup unknown files and symlink escape", async (t) => {
  let fail = true;
  const { root, service } = fixture(t, async () => "text", {
    removeFile: (file) => {
      if (fail) throw new Error();
      unlinkSync(file);
    },
  });
  assert.equal(
    (await service.transcribe(wav(), "en", new AbortController().signal)).state,
    "CLEANUP_FAILED",
  );
  assert.equal(service.status(), "CLEANUP_FAILED");
  fail = false;
  assert.equal(service.recover(), true);
  service.close();
  const outside = path.join(
    path.dirname(root),
    path.basename(root) + "-sentinel",
  );
  writeFileSync(outside, "untouched");
  t.after(() => rmSync(outside, { force: true }));
  mkdirSync(path.join(root, "unknown"));
  writeFileSync(path.join(root, "unknown", "partial"), "synthetic");
  symlinkSync(outside, path.join(root, "escape"));
  const restarted = createSpeechService({
    paths: { speechDirectory: () => root },
  });
  t.after(() => restarted.close());
  assert.equal(restarted.status(), "DISABLED");
  assert.deepEqual(readdirSync(root), []);
  assert.equal(readFileSync(outside, "utf8"), "untouched");
});
test("unconfigured or missing native STT never installs or substitutes", () => {
  assert.equal(loadWhisperAdapter(), undefined);
  assert.throws(() =>
    loadWhisperAdapter("/nonexistent/synthetic-stt-profile.json"),
  );
});

test("WAV high-bit container aliases are invalid", () => {
  const b = wav();
  b[0] |= 128;
  assert.equal(validateWav(b), false);
});

test("English/Chinese long speech is skipped before adapter or audio allocation", async (t) => {
  const { isShortSpokenAnswer } = await import("@laita/contracts");
  let calls = 0;
  const { root, service } = fixture(t, undefined, {
    ttsAdapter: {
      identity: "synthetic",
      async synthesize() {
        calls++;
        assert.fail("must skip");
      },
    },
  });
  assert.equal(isShortSpokenAnswer("word ".repeat(75)), true);
  assert.equal(isShortSpokenAnswer("中".repeat(150)), true);
  for (const text of [
    "word ".repeat(76),
    "中".repeat(151),
    "x".repeat(601),
    "中".repeat(100) + " word".repeat(26),
  ]) {
    const result = await service.synthesize(
      text,
      speechLanguage(text),
      "a".repeat(64),
      new AbortController().signal,
    );
    assert.equal(result.state, "SKIPPED_LONG_ANSWER");
    assert.equal(service.ttsStatus(), "READY");
    assert.deepEqual(readdirSync(root), []);
  }
  assert.equal(calls, 0);
});

test("short speech adapter failures and invalid media have bounded distinct diagnostics", async (t) => {
  for (const [reason, synthesize] of [
    [
      "ADAPTER_FAILED",
      async () => {
        throw new Error("private native detail");
      },
    ],
    [
      "INVALID_MEDIA",
      async (_text, _language, output) =>
        writeFileSync(output, "invalid", { mode: 0o600 }),
    ],
  ]) {
    const { root, service } = fixture(t, undefined, {
      ttsAdapter: { identity: "synthetic", synthesize },
    });
    const result = await service.synthesize(
      "Short answer.",
      "en",
      "a".repeat(64),
      new AbortController().signal,
    );
    assert.deepEqual(result, { state: "FAILED", reason, cleanup: "DELETED" });
    assert.deepEqual(readdirSync(root), []);
    assert.ok(!JSON.stringify(result).includes("private native detail"));
  }
});
