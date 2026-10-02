import type { TtsSynthesisRequest } from "@laita/contracts/browser";
import { ClientError, InputApi } from "./api.ts";

export interface AnswerAudioRef {
  jobRef: string;
  runRef: `run-${string}`;
  automatic?: boolean;
  speechEligible?: boolean;
}
type Player = Pick<
  HTMLAudioElement,
  "play" | "pause" | "currentTime" | "onended" | "onerror"
>;
export type PlaybackState = "idle" | "loading" | "ready" | "speaking" | "error";

export function answerAudioKey(answer: AnswerAudioRef) {
  return `${answer.jobRef}:${answer.runRef}`;
}

export function claimAutomaticPlayback(
  answer: AnswerAudioRef,
  attempted: Set<string>,
  muted: boolean,
  ready: boolean,
) {
  const key = answerAudioKey(answer);
  if (
    answer.speechEligible === false ||
    !answer.automatic ||
    attempted.has(key) ||
    muted ||
    !ready
  )
    return false;
  attempted.add(key);
  return true;
}

export class AnswerAudioPlayback {
  muted = false;
  recordingIncomplete = false;
  private answer: AnswerAudioRef | undefined;
  state: PlaybackState = "idle";
  status = "";
  activeKey = "";
  private api: Pick<InputApi, "synthesize" | "media" | "releaseMedia"> &
    Partial<Pick<InputApi, "observation">>;
  private notify: () => void;
  private createPlayer: (url: string) => Player;
  private createUrl: (bytes: Uint8Array) => string;
  private revokeUrl: (url: string) => void;
  private generation = 0;
  private abort = new AbortController();
  private player: Player | undefined;
  private url = "";
  private mediaRef = "";

  constructor(
    api: Pick<InputApi, "synthesize" | "media" | "releaseMedia"> &
      Partial<Pick<InputApi, "observation">>,
    notify: () => void,
    options: {
      createPlayer?: (url: string) => Player;
      createUrl?: (bytes: Uint8Array) => string;
      revokeUrl?: (url: string) => void;
    } = {},
  ) {
    this.api = api;
    this.notify = notify;
    this.createPlayer =
      options.createPlayer ??
      ((url) => {
        const audio = new Audio(url);
        audio.preload = "auto";
        return audio;
      });
    this.createUrl =
      options.createUrl ??
      ((bytes) =>
        URL.createObjectURL(
          // Uint8Array may use SharedArrayBuffer; BlobPart requires ArrayBuffer.
          // Copy only this view's bytes into an ordinary buffer before zeroing.
          new Blob([bytes.slice().buffer], { type: "audio/wav" }),
        ));
    this.revokeUrl = options.revokeUrl ?? URL.revokeObjectURL;
  }

  private observe(event: string) {
    if (!this.answer || !this.api.observation) return;
    void this.api
      .observation(this.answer.jobRef, this.answer.runRef, event)
      .catch(() => {
        this.recordingIncomplete = true;
        this.notify();
      });
  }
  private key(answer: AnswerAudioRef) {
    return answerAudioKey(answer);
  }

  private emit(state: PlaybackState, status = "") {
    this.state = state;
    this.status = status;
    this.notify();
  }

  private invalidate() {
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
    this.player?.pause();
    if (this.player) {
      this.player.onended = null;
      this.player.onerror = null;
    }
  }

  private drop() {
    this.invalidate();
    if (this.url) this.revokeUrl(this.url);
    this.url = "";
    this.player = undefined;
    this.activeKey = "";
  }

  setMuted(value: boolean) {
    if (this.muted === value) return;
    this.muted = value;
    this.reset();
  }

  private async startCached(automatic: boolean) {
    if (!this.player) return;
    const generation = ++this.generation;
    const player = this.player;
    player.onended = () => {
      if (generation === this.generation) this.observe("PLAY_ENDED");
      if (generation === this.generation)
        this.emit("ready", "Replay available.");
    };
    player.onerror = () => {
      if (generation === this.generation) this.observe("PLAY_FAILED");
      if (generation === this.generation) {
        this.drop();
        this.emit(
          "error",
          "Audio playback is unavailable. The complete answer remains above.",
        );
      }
    };
    try {
      player.currentTime = 0;
      await player.play();
      if (generation === this.generation) {
        this.observe("PLAY_STARTED");
        this.emit("speaking", "Speaking…");
      }
    } catch {
      if (generation === this.generation) this.observe("PLAY_BLOCKED");
      if (generation === this.generation)
        this.emit(
          "ready",
          automatic
            ? "Audio is ready. Press Play if your browser blocked autoplay."
            : "Audio output is unavailable. You can still read the complete answer.",
        );
    }
  }

  async play(answer: AnswerAudioRef, automatic = false) {
    if (this.muted) return;
    if (answer.speechEligible === false) {
      this.reset();
      this.emit("idle", "Text only: long-answer speech skipped.");
      return;
    }
    const key = this.key(answer);
    if (this.activeKey === key && this.player) {
      this.stop();
      await this.startCached(automatic);
      return;
    }
    this.drop();
    this.activeKey = key;
    this.answer = answer;
    const generation = this.generation;
    this.emit("loading", "Preparing local audio…");
    try {
      const request: TtsSynthesisRequest = {
        contractVersion: "tts-synthesis-request.v1",
        jobRef: answer.jobRef,
        runRef: answer.runRef,
      };
      const media = await this.api.synthesize(request, this.abort.signal);
      if (media.contractVersion === "tts-skipped.v1") {
        if (generation === this.generation)
          this.emit("idle", "Text only: long-answer speech skipped.");
        return;
      }
      if (generation !== this.generation) {
        void this.api.releaseMedia(media.mediaRef).catch(() => {});
        return;
      }
      this.mediaRef = media.mediaRef;
      const bytes = await this.api.media(media.mediaRef, this.abort.signal);
      this.mediaRef = ""; // GET consumes and deletes the server artifact.
      if (generation !== this.generation) {
        bytes.fill(0);
        return;
      }
      this.url = this.createUrl(bytes);
      bytes.fill(0);
      this.player = this.createPlayer(this.url);
      this.emit("ready");
      await this.startCached(automatic);
    } catch (error) {
      if (this.mediaRef) {
        const ref = this.mediaRef;
        this.mediaRef = "";
        void this.api.releaseMedia(ref).catch(() => {});
      }
      if (
        generation === this.generation &&
        !(error instanceof ClientError && this.abort.signal.aborted)
      ) {
        this.drop();
        this.emit(
          "error",
          "Local speech is unavailable. The complete answer remains above.",
        );
      }
    }
  }

  stop() {
    if (!this.player && this.state !== "loading") return;
    this.observe("PLAY_STOPPED");
    this.invalidate();
    if (this.player) this.player.currentTime = 0;
    this.emit(this.player ? "ready" : "idle");
  }

  reset() {
    const pending = this.mediaRef;
    this.mediaRef = "";
    this.drop();
    if (pending) void this.api.releaseMedia(pending).catch(() => {});
    this.emit("idle");
  }
}
