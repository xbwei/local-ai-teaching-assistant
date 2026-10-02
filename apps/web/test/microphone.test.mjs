import test from "node:test";
import assert from "node:assert/strict";
import { Microphone } from "../src/client/microphone.ts";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(t, stage) {
  const pending = deferred(),
    entered = deferred();
  const streams = [],
    contexts = [],
    nodes = [];
  const descriptors = new Map(
    ["navigator", "AudioContext", "AudioWorkletNode"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  let mediaCalls = 0;
  const pause = (name, index) => {
    if (stage === name && index === 0) {
      entered.resolve();
      return pending.promise;
    }
    return Promise.resolve();
  };
  const globals = {
    navigator: {
      mediaDevices: {
        async getUserMedia() {
          const index = mediaCalls++;
          await pause("media", index);
          const track = {
            stopped: false,
            stop() {
              this.stopped = true;
            },
          };
          const stream = { getTracks: () => [track], track };
          streams.push(stream);
          return stream;
        },
      },
    },
    AudioContext: class {
      constructor() {
        this.index = contexts.length;
        this.closed = false;
        this.audioWorklet = { addModule: () => pause("module", this.index) };
        contexts.push(this);
      }
      createMediaStreamSource() {
        return { connect() {} };
      }
      resume() {
        return pause("resume", this.index);
      }
      async close() {
        this.closed = true;
      }
    },
    AudioWorkletNode: class {
      constructor() {
        this.port = {};
        this.disconnected = false;
        nodes.push(this);
      }
      connect() {}
      disconnect() {
        this.disconnected = true;
      }
    },
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const mic = new Microphone();
  t.after(() => {
    mic.cancel();
    for (const [key, descriptor] of descriptors)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  });
  return { mic, pending, entered, streams, contexts, nodes };
}

for (const stage of ["media", "module", "resume"])
  for (const outcome of ["resolve", "reject"])
    test(`stale microphone ${stage} ${outcome} cannot interrupt a new capture`, async (t) => {
      const f = fixture(t, stage);
      const older = f.mic.start(() => assert.fail("stale recording timer"));
      await f.entered.promise;
      assert.equal(await f.mic.start(() => {}), true);
      const activeStream = f.streams.at(-1),
        activeContext = f.contexts.at(-1);
      const activeNode = f.nodes.at(-1);
      activeNode.port.onmessage({ data: new Int16Array(1600).fill(123) });
      f.pending[outcome](
        outcome === "reject" ? new Error("synthetic failure") : undefined,
      );
      assert.equal(await older, false);
      assert.equal(activeStream.track.stopped, false);
      assert.equal(activeContext.closed, false);
      assert.equal(activeNode.disconnected, false);
      for (const stream of f.streams)
        if (stream !== activeStream) assert.equal(stream.track.stopped, true);
      for (const context of f.contexts)
        if (context !== activeContext) assert.equal(context.closed, true);
      const audio = f.mic.stop();
      assert.equal(audio.length, 3244);
      assert.equal(new DataView(audio.buffer).getInt16(44, true), 123);
      assert.equal(activeStream.track.stopped, true);
      assert.equal(activeContext.closed, true);
      assert.equal(activeNode.port.onmessage, null);
    });

for (const stage of ["media", "module", "resume"])
  test(`current microphone ${stage} failure cleans up and reports fixed denial`, async (t) => {
    const f = fixture(t, stage);
    const start = f.mic.start(() => {});
    await f.entered.promise;
    f.pending.reject(new Error("synthetic internal failure"));
    await assert.rejects(start, { message: "Microphone unavailable" });
    assert.ok(f.streams.every((stream) => stream.track.stopped));
    assert.ok(f.contexts.every((context) => context.closed));
    assert.ok(
      f.nodes.every(
        (node) => node.disconnected && node.port.onmessage === null,
      ),
    );
  });
