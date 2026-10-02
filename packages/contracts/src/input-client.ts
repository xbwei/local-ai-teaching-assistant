import {
  inputLimits,
  isLocalSelection,
  isInputRef,
  type InputSession,
  type InputBuild,
  type InputChoices,
  type InputJob,
  type TtsMedia,
  type TtsSkipped,
} from "./input.ts";
import { isBrowserCapability } from "./capability-client.ts";
import { isProviderRunResult } from "./provider-control.ts";
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const noExtraKeys = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).every((k) => keys.includes(k));
const limits = (v: unknown) =>
  record(v) &&
  Object.keys(v).length === Object.keys(inputLimits).length &&
  Object.entries(inputLimits).every(([key, value]) => v[key] === value);
export function isInputSession(v: unknown): v is InputSession {
  return (
    record(v) &&
    noExtraKeys(v, ["contractVersion", "sessionRef", "limits"]) &&
    v.contractVersion === "input-session.v1" &&
    isInputRef(v.sessionRef) &&
    limits(v.limits)
  );
}
export function isInputBuild(v: unknown): v is InputBuild {
  return (
    record(v) &&
    noExtraKeys(v, [
      "contractVersion",
      "commit",
      "profileVersion",
      "sttIdentity",
      "ttsIdentity",
    ]) &&
    v.contractVersion === "input-build.v1" &&
    (v.commit === null ||
      (typeof v.commit === "string" && /^[a-f0-9]{40}$/u.test(v.commit))) &&
    v.profileVersion === "demo-profile.v4" &&
    (v.sttIdentity === null ||
      (typeof v.sttIdentity === "string" && v.sttIdentity.length <= 256)) &&
    (v.ttsIdentity === null ||
      (typeof v.ttsIdentity === "string" && v.ttsIdentity.length <= 256))
  );
}
export function isInputChoices(v: unknown): v is InputChoices {
  return (
    record(v) &&
    noExtraKeys(v, [
      "contractVersion",
      "providers",
      "speech",
      "tts",
      "limits",
      "local",
      "reasons",
    ]) &&
    v.contractVersion === "input-choices.v1" &&
    isBrowserCapability(v.providers) &&
    (v.local === undefined || isLocalSelection(v.local)) &&
    (v.reasons === undefined ||
      (record(v.reasons) &&
        Object.keys(v.reasons).length === 3 &&
        ["LOCAL", "OPENAI", "COMPARE"].every(
          (k) =>
            typeof (v.reasons as Record<string, unknown>)[k] === "string" &&
            [
              "READY",
              "DISABLED",
              "UNAVAILABLE",
              "BUSY",
              "LOADING",
              "SWITCHING",
              "RECOVERING",
              "OVER_BUDGET",
              "OVER_QUOTA",
              "AUTHENTICATION_FAILED",
              "PROVIDER_FAILURE",
              "POLICY_DENIED",
              "BOTH_PROVIDERS_REQUIRED",
            ].includes((v.reasons as Record<string, string>)[k]!),
        ))) &&
    ["READY", "BUSY", "DISABLED", "CLEANUP_FAILED"].includes(
      v.speech as string,
    ) &&
    ["READY", "BUSY", "DISABLED", "CLEANUP_FAILED"].includes(v.tts as string) &&
    limits(v.limits)
  );
}
export function isTtsSkipped(v: unknown): v is TtsSkipped {
  return (
    record(v) &&
    Object.keys(v).length === 2 &&
    v.contractVersion === "tts-skipped.v1" &&
    v.reason === "LONG_ANSWER"
  );
}
export function isTtsMedia(v: unknown): v is TtsMedia {
  return (
    record(v) &&
    noExtraKeys(v, [
      "contractVersion",
      "mediaRef",
      "contentType",
      "language",
      "expiresAtEpochSeconds",
    ]) &&
    v.contractVersion === "tts-media.v1" &&
    isInputRef(v.mediaRef) &&
    v.contentType === "audio/wav" &&
    ["en", "zh"].includes(v.language as string) &&
    Number.isSafeInteger(v.expiresAtEpochSeconds) &&
    (v.expiresAtEpochSeconds as number) > 0
  );
}
export function isInputJob(v: unknown): v is InputJob {
  if (
    !record(v) ||
    !noExtraKeys(v, [
      "contractVersion",
      "jobRef",
      "history",
      "sequence",
      "state",
      "cleanup",
      "transcript",
      "result",
    ]) ||
    v.contractVersion !== "input-job.v1" ||
    !isInputRef(v.jobRef) ||
    !Number.isSafeInteger(v.sequence) ||
    (v.sequence as number) < 0 ||
    ![
      "ACCEPTED",
      "PROCESSING",
      "REVIEW",
      "COMPLETED",
      "INVALID",
      "FAILED",
      "CANCELLED",
      "TIMEOUT",
      "CLEANUP_FAILED",
    ].includes(v.state as string) ||
    !["NOT_REQUIRED", "PENDING", "DELETED", "FAILED"].includes(
      v.cleanup as string,
    )
  )
    return false;
  if (
    v.history !== undefined &&
    (!record(v.history) ||
      Object.keys(v.history).length !== 3 ||
      !isInputRef(v.history.conversation) ||
      !isInputRef(v.history.turn) ||
      !["RECORDED", "INCOMPLETE"].includes(v.history.recording as string))
  )
    return false;
  if (v.state === "REVIEW")
    return (
      v.cleanup === "DELETED" &&
      v.result === undefined &&
      record(v.transcript) &&
      noExtraKeys(v.transcript, ["transcriptRef", "text"]) &&
      isInputRef(v.transcript.transcriptRef) &&
      typeof v.transcript.text === "string" &&
      v.transcript.text.length > 0 &&
      v.transcript.text.length <= 4000
    );
  if (v.transcript !== undefined) return false;
  return v.state === "COMPLETED"
    ? isProviderRunResult(v.result) &&
        ((v.result.grounding !== undefined &&
          v.result.grounding.status !== "GROUNDED") ||
          v.result.mode === "COMPARE" ||
          v.result.legs[0]?.provider === v.result.mode)
    : v.result === undefined;
}
