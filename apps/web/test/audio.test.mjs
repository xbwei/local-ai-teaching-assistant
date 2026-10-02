import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AnswerAudioPlayback,
  answerAudioKey,
  claimAutomaticPlayback,
} from "../src/client/audio.ts";

const answer = (suffix = "1") => ({
  jobRef: suffix.repeat(64).slice(0, 64),
  runRef: "run-123e4567-e89b-42d3-a456-42661417400" + suffix,
});
function fixture(options = {}) {
  const calls = { synthesize: 0, media: 0, release: [], revoked: [] };
  const players = [];
  const api = {
    async synthesize() {
      calls.synthesize++;
      if (options.synthesize) return options.synthesize();
      return {
        contractVersion: "tts-media.v1",
        mediaRef: "a".repeat(64),
        contentType: "audio/wav",
        language: "en",
        expiresAtEpochSeconds: 9999999999,
      };
    },
    async media() {
      calls.media++;
      if (options.mediaError) throw new Error("synthetic network failure");
      return new Uint8Array(44);
    },
    async releaseMedia(ref) {
      calls.release.push(ref);
    },
  };
  const playback = new AnswerAudioPlayback(api, () => {}, {
    createUrl: () => `blob:synthetic-${calls.media}`,
    revokeUrl: (url) => calls.revoked.push(url),
    createPlayer(url) {
      const player = {
        url,
        currentTime: 0,
        onended: null,
        onerror: null,
        plays: 0,
        pauses: 0,
        async play() {
          this.plays++;
          if (options.denyFirst && this.plays === 1) throw new Error();
        },
        pause() {
          this.pauses++;
        },
      };
      players.push(player);
      return player;
    },
  });
  return { playback, calls, players };
}

test("automatic playback is claimed only when an actual ready unmuted attempt starts", () => {
  const value = { ...answer(), automatic: true };
  const attempted = new Set();
  assert.equal(claimAutomaticPlayback(value, attempted, false, false), false);
  assert.equal(claimAutomaticPlayback(value, attempted, true, true), false);
  assert.equal(attempted.size, 0);
  assert.equal(claimAutomaticPlayback(value, attempted, false, true), true);
  assert.equal(attempted.has(answerAudioKey(value)), true);
  assert.equal(claimAutomaticPlayback(value, attempted, false, true), false);
  assert.equal(
    claimAutomaticPlayback(
      { ...answer("2"), automatic: false },
      attempted,
      false,
      true,
    ),
    false,
  );
});

test("text-only mute performs no synthesis and autoplay denial becomes an explicit Play state", async () => {
  const f = fixture({ denyFirst: true });
  f.playback.setMuted(true);
  await f.playback.play(answer());
  assert.equal(f.calls.synthesize, 0);
  assert.equal(f.playback.state, "idle");
  f.playback.setMuted(false);
  await f.playback.play(answer(), true);
  assert.equal(f.playback.state, "ready");
  assert.match(f.playback.status, /Press Play/);
  assert.equal(f.calls.synthesize, 1);
  await f.playback.play(answer());
  assert.equal(f.playback.state, "speaking");
  assert.equal(f.calls.synthesize, 1);
  f.players[0].onended();
  assert.equal(f.playback.state, "ready");
});

test("selecting another Compare answer stops and drops the first; reset rejects stale callbacks", async () => {
  const f = fixture();
  await f.playback.play(answer("1"));
  assert.equal(f.playback.state, "speaking");
  const first = f.players[0];
  await f.playback.play(answer("2"));
  assert.ok(first.pauses >= 1);
  assert.deepEqual(f.calls.revoked, ["blob:synthetic-1"]);
  first.onended?.();
  assert.equal(f.playback.activeKey.includes(answer("2").jobRef), true);
  f.playback.reset();
  assert.equal(f.playback.state, "idle");
  assert.equal(f.playback.activeKey, "");
});

test("network/playback failure keeps a text-safe error and releases undelivered media", async () => {
  const f = fixture({ mediaError: true });
  await f.playback.play(answer());
  assert.equal(f.playback.state, "error");
  assert.match(f.playback.status, /complete answer remains/);
  assert.deepEqual(f.calls.release, ["a".repeat(64)]);
});

test("cancel/reset while synthesis is pending invalidates the result and releases it without playback", async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const f = fixture({ synthesize: () => pending });
  const work = f.playback.play(answer());
  f.playback.reset();
  finish({
    contractVersion: "tts-media.v1",
    mediaRef: "b".repeat(64),
    contentType: "audio/wav",
    language: "en",
    expiresAtEpochSeconds: 9999999999,
  });
  await work;
  assert.equal(f.playback.state, "idle");
  assert.equal(f.calls.media, 0);
  assert.deepEqual(f.calls.release, ["b".repeat(64)]);
});

test("long answers never synthesize through automatic or manual Play", async () => {
  const f = fixture();
  const long = { ...answer(), speechEligible: false, automatic: true };
  assert.equal(claimAutomaticPlayback(long, new Set(), false, true), false);
  await f.playback.play(long, true);
  await f.playback.play(long);
  assert.equal(f.calls.synthesize, 0);
  assert.equal(f.calls.media, 0);
  assert.equal(f.playback.state, "idle");
  assert.match(f.playback.status, /long-answer speech skipped/);
});
test("audio UI keeps text-first controls, minimal blob-only CSP and reduced motion", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const css = readFileSync(
    new URL("../src/client/style.css", import.meta.url),
    "utf8",
  );
  assert.match(html, /Conversation and complete answers/);
  assert.match(html, /Text only \/ mute/);
  assert.match(html, /media-src blob:/);
  assert.doesNotMatch(html, /media-src https?:/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  for (const state of ["listening", "thinking", "speaking", "error"])
    assert.match(css, new RegExp(`data-state=["']${state}["']`));
});

for (const BufferType of [ArrayBuffer, SharedArrayBuffer])
  test(`default audio Blob snapshots only its ${BufferType.name} view before zeroing`, async () => {
    const backing = new Uint8Array(new BufferType(32)).fill(99);
    const bytes = backing.subarray(4, 12);
    bytes.set([1, 2, 3, 4, 5, 6, 7, 8]);
    let url;
    const api = {
      async synthesize() {
        return { contractVersion: "tts-media.v1", mediaRef: "a".repeat(64) };
      },
      async media() {
        return bytes;
      },
      async releaseMedia() {},
    };
    const playback = new AnswerAudioPlayback(api, () => {}, {
      createPlayer(value) {
        url = value;
        return {
          currentTime: 0,
          onended: null,
          onerror: null,
          async play() {},
          pause() {},
        };
      },
    });
    await playback.play(answer());
    assert.equal(playback.state, "speaking");
    assert.deepEqual([...bytes], Array(8).fill(0));
    assert.deepEqual(
      [...new Uint8Array(await (await fetch(url)).arrayBuffer())],
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(backing[0], 99);
    assert.equal(backing[31], 99);
    playback.reset();
    await assert.rejects(fetch(url));
  });
