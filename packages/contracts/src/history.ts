/** Protected development history. No audio, provider payloads or hidden prompts. */
export type RecordingState = "RECORDED" | "INCOMPLETE";
export interface HistoryRef {
  conversation: string;
  turn: string;
  recording: RecordingState;
}
export const historyStages = [
  "INPUT",
  "STT_RECEIVE",
  "STT_PROCESS",
  "STT_RESULT",
  "HANDOFF",
  "ADMISSION",
  "SAFETY",
  "COURSE",
  "FRESHNESS",
  "SNAPSHOT",
  "RETRIEVAL",
  "PROVIDER",
  "ANSWER",
  "TTS",
  "DELIVERY",
  "PLAYBACK",
  "CAPTURE",
] as const;
export type HistoryStage = (typeof historyStages)[number];
export interface HistorySnapshot {
  course: string;
  commit: string;
}
export interface HistoryEvent {
  stage: HistoryStage;
  outcome: string;
  at: string;
  durationMs?: number;
  leg?: string;
  origin: "SERVER" | "BROWSER";
  snapshot?: HistorySnapshot;
}
export type Trace = (
  stage: HistoryStage,
  outcome: string,
  durationMs?: number,
  source?: {
    course: string | null;
    lab: string | null;
    sources: HistorySource[];
    snapshot?: HistorySnapshot;
  },
) => void;
export type HistoryOutcome =
  | "PENDING"
  | "TRANSCRIBED"
  | "SUCCESS"
  | "PARTIAL"
  | "FAILED"
  | "TIMEOUT"
  | "CANCELLED"
  | "NO_ANSWER"
  | "INTERRUPTED";
export interface HistoryAnswer {
  leg: string;
  provider: string;
  model: string;
  actualProvider: string | null;
  actualModel: string | null;
  status: string;
  text: string | null;
  failure: string | null;
  latencyMs: number;
}
export interface HistorySource {
  course: string;
  commit: string;
  path: string;
  section: string;
  url: string;
}
export interface HistoryFeedback {
  leg: string;
  vote: "HELPFUL" | "NOT_HELPFUL" | null;
  report: boolean;
  reason: string;
  updated: string;
}
export interface HistoryTurn {
  id: string;
  conversation: string;
  ordinal: number;
  created: string;
  inputType: "TYPED" | "VOICE";
  text: string | null;
  outcome: HistoryOutcome;
  recording: RecordingState;
  correlation: string | null;
  interaction: string | null;
  course: string | null;
  lab: string | null;
  sources: HistorySource[];
  answers: HistoryAnswer[];
  events: HistoryEvent[];
  feedback: HistoryFeedback[];
  usage: {
    attempt: string;
    run: string;
    provider: string;
    model: string;
    outcome: string;
    basis: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCostNanoUsd: number | null;
    latencyMs: number | null;
  }[];
  review: "PENDING" | "REVIEWED" | "CONFIRMED_ISSUE" | "NO_ISSUE";
  note: string;
  suspected: boolean;
  suspicionReason: string;
  suspicionSource: "OWNER" | "SAFETY" | null;
}
export interface HistoryFilter {
  before?: number;
  limit?: number;
  search?: string;
  inputType?: "TYPED" | "VOICE";
  course?: "IA340" | "IA342";
  lab?: string;
  provider?: "LOCAL" | "OPENAI";
  model?: string;
  outcome?: HistoryOutcome;
  feedback?: "HELPFUL" | "NOT_HELPFUL" | "REPORT";
  review?: HistoryTurn["review"];
  problems?: boolean;
  suspected?: boolean;
  since?: string;
  until?: string;
}
export interface HistoryPage {
  items: {
    id: string;
    ordinal: number;
    conversation: string;
    created: string;
    text: string | null;
    inputType: string;
    outcome: string;
    recording: string;
    course: string | null;
    lab: string | null;
    review: string;
    suspected: boolean;
    providers: Pick<
      HistoryAnswer,
      "provider" | "model" | "actualProvider" | "actualModel"
    >[];
    problemSignals: (
      | "OWNER_CONFIRMED"
      | "TEXT_OUTCOME"
      | "INCOMPLETE"
      | "SUSPECTED"
      | "REPORTED"
      | "NOT_HELPFUL"
      | "TTS_PROBLEM"
      | "STAGE_FAILURE"
    )[];
  }[];
  next: number | null;
}
export interface ConversationPage {
  turns: HistoryTurn[];
  next: number | null;
}
