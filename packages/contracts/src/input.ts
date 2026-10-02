import {
  isProviderRunRequest,
  type ProviderRunRequest,
  type ProviderRunResult,
} from "./provider-control.ts";
export const inputLimits = {
  maxSessions: 16,
  maxJobs: 16,
  observationMs: 300_000,
  uploadMs: 20_000,
  uploadBytes: 524288,
  uploadChunks: 1024,
} as const;
export const isInputRef = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
export type InputClient = "PHONE" | "TABLET" | "COMPUTER" | "PI";
export const isInputClient = (v: unknown): v is InputClient =>
  ["PHONE", "TABLET", "COMPUTER", "PI"].includes(v as string);
export interface InputSubmission {
  turnRef?: string;
  contractVersion: "input-submission.v1";
  clientKind: InputClient;
  source: "TYPED" | "TRANSCRIPT";
  transcriptRef?: string;
  request: ProviderRunRequest;
}
export interface InputJob {
  history?: import("./history.ts").HistoryRef;
  contractVersion: "input-job.v1";
  jobRef: string;
  sequence: number;
  state:
    | "ACCEPTED"
    | "PROCESSING"
    | "REVIEW"
    | "COMPLETED"
    | "INVALID"
    | "FAILED"
    | "CANCELLED"
    | "TIMEOUT"
    | "CLEANUP_FAILED";
  cleanup: "NOT_REQUIRED" | "PENDING" | "DELETED" | "FAILED";
  transcript?: { transcriptRef: string; text: string };
  result?: ProviderRunResult;
}
export function isInputSubmission(v: unknown): v is InputSubmission {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const c = v as Partial<InputSubmission>;
  return (
    Object.keys(v).every((k) =>
      [
        "contractVersion",
        "clientKind",
        "source",
        "transcriptRef",
        "turnRef",
        "request",
      ].includes(k),
    ) &&
    c.contractVersion === "input-submission.v1" &&
    (c.turnRef === undefined || isInputRef(c.turnRef)) &&
    isInputClient(c.clientKind) &&
    ((c.source === "TYPED" && c.transcriptRef === undefined) ||
      (c.source === "TRANSCRIPT" && isInputRef(c.transcriptRef))) &&
    isProviderRunRequest(c.request)
  );
}

export interface InputSession {
  contractVersion: "input-session.v1";
  sessionRef: string;
  limits: typeof inputLimits;
}
export interface InputBuild {
  contractVersion: "input-build.v1";
  commit: string | null;
  profileVersion: "demo-profile.v4";
  sttIdentity: string | null;
  ttsIdentity: string | null;
}
export interface LocalSelection {
  selectedModel: "gemma4:12b-mlx" | "llama3.1:8b";
  residency:
    | "UNKNOWN"
    | "UNLOADED"
    | "LOADING"
    | "WARM"
    | "BUSY"
    | "SWITCHING"
    | "UNAVAILABLE";
}
export function isLocalSelection(v: unknown): v is LocalSelection {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const c = v as LocalSelection;
  return (
    Object.keys(v).length === 2 &&
    ["gemma4:12b-mlx", "llama3.1:8b"].includes(c.selectedModel) &&
    [
      "UNKNOWN",
      "UNLOADED",
      "LOADING",
      "WARM",
      "BUSY",
      "SWITCHING",
      "UNAVAILABLE",
    ].includes(c.residency)
  );
}
export interface InputChoices {
  contractVersion: "input-choices.v1";
  local?: LocalSelection;
  reasons?: { LOCAL: string; OPENAI: string; COMPARE: string };
  providers: import("./capability.ts").CapabilityAvailability;
  speech: "READY" | "BUSY" | "DISABLED" | "CLEANUP_FAILED";
  tts: "READY" | "BUSY" | "DISABLED" | "CLEANUP_FAILED";
  limits: typeof inputLimits;
}

export interface TtsSynthesisRequest {
  contractVersion: "tts-synthesis-request.v1";
  jobRef: string;
  runRef: `run-${string}`;
}
export function isTtsSynthesisRequest(
  value: unknown,
): value is TtsSynthesisRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<TtsSynthesisRequest>;
  return (
    Object.keys(value).length === 3 &&
    candidate.contractVersion === "tts-synthesis-request.v1" &&
    isInputRef(candidate.jobRef) &&
    typeof candidate.runRef === "string" &&
    /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      candidate.runRef,
    )
  );
}
// Conservative pre-synthesis eligibility, not an estimate of actual playback time.
// At most 600 code points and 150 speech units (Han=1, other words=2).
export function isShortSpokenAnswer(text: string): boolean {
  let characters = 0;
  for (const _character of text) if (++characters > 600) return false;
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const words =
    text.replace(/\p{Script=Han}/gu, " ").match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return text.trim().length > 0 && han + words * 2 <= 150;
}
export interface TtsSkipped {
  contractVersion: "tts-skipped.v1";
  reason: "LONG_ANSWER";
}
export interface TtsMedia {
  contractVersion: "tts-media.v1";
  mediaRef: string;
  contentType: "audio/wav";
  language: "en" | "zh";
  expiresAtEpochSeconds: number;
}
