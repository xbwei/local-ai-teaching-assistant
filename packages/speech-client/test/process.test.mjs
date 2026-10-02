import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { transcribeProcess } from "../dist/whisper.js";
import { runSynthesisProcess, selectLocalVoices } from "../dist/tts.js";
function child() {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.kills = 0;
  c.kill = () => {
    c.kills++;
    return true;
  };
  return c;
}
test("native process stream boundary preserves split UTF-8", async () => {
  const c = child();
  const pending = transcribeProcess(() => c, new AbortController().signal);
  const encoded = Buffer.from("中文 synthetic");
  c.stdout.emit("data", Buffer.from(encoded.subarray(0, 1)));
  c.stdout.emit("data", Buffer.from(encoded.subarray(1, 4)));
  c.stdout.emit("data", Buffer.from(encoded.subarray(4)));
  c.emit("close", 0);
  assert.equal(await pending, "中文 synthetic");
});
test("stdout error, overflow, absent stream and cancellation kill and await close", async () => {
  for (const scenario of ["error", "overflow", "absent", "cancel"]) {
    const c = child();
    if (scenario === "absent") c.stdout = null;
    const controller = new AbortController();
    let settled = false;
    const pending = transcribeProcess(() => c, controller.signal).finally(
      () => {
        settled = true;
      },
    );
    if (scenario === "error")
      c.stdout.emit("error", new Error("synthetic-private-error"));
    if (scenario === "overflow") c.stdout.emit("data", Buffer.alloc(8193));
    if (scenario === "cancel") controller.abort();
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(c.kills, 1);
    c.emit("close", 0);
    await assert.rejects(pending);
  }
});
test("local voice inventory requires both English and Chinese without exposing a catalog", () => {
  assert.deepEqual(
    selectLocalVoices(
      "Samantha           en_US    # hello\nTingting           zh_CN    # 你好\n",
    ),
    { en: "Samantha", zh: "Tingting" },
  );
  assert.equal(selectLocalVoices("Samantha en_US # hello\n"), undefined);
});
test("TTS process receives text on stdin and cancellation kills the process group", async () => {
  const c = child();
  c.stdin = new PassThrough();
  let input = "";
  c.stdin.on("data", (chunk) => {
    input += chunk.toString("utf8");
  });
  const pending = runSynthesisProcess(
    () => c,
    "中文 synthetic",
    new AbortController().signal,
  );
  c.emit("close", 0);
  await pending;
  assert.equal(input, "中文 synthetic");

  const cancelled = child();
  cancelled.stdin = new PassThrough();
  const controller = new AbortController();
  const stopped = runSynthesisProcess(
    () => cancelled,
    "text",
    controller.signal,
  );
  controller.abort();
  assert.equal(cancelled.kills, 1);
  cancelled.emit("close", 0);
  await assert.rejects(stopped);
});
