import { canvasFeedbackSubmittedAt } from "./canvas-feedback.ts";
import { canvasPageId, canvasPagePlanId } from "./canvas-page.ts";

export const verificationClassSize = 40;
export type AssignmentVerifier = "GITHUB";
export const isAssignmentVerifier = (
  value: unknown,
): value is AssignmentVerifier => value === "GITHUB";

export interface AssignmentVerificationScope {
  scope: string;
  assignments: {
    assignmentId: string;
    provider: AssignmentVerifier;
    studentIds: string[];
  }[];
}

export const verificationOutcomes = [
  "PRESENT",
  "ABSENT",
  "UNKNOWN",
  "NOT_REQUIRED",
  "OPEN",
  "CLOSED",
  "MERGED",
] as const;
type Observation = (typeof verificationOutcomes)[number];

export type AssignmentVerificationResult =
  | {
      state: "UNKNOWN";
      reason:
        | "NOT_SUBMITTED"
        | "SOURCE_UNAVAILABLE"
        | "ATTEMPT_CHANGED"
        | "PROVIDER_UNAVAILABLE";
    }
  | {
      state: "OBSERVED" | "PARTIAL";
      attempt: number;
      submittedAt: string;
      checks: Observation[];
    };

export function readAssignmentVerificationScope(
  value: unknown,
): AssignmentVerificationScope {
  if (!value || typeof value !== "object") throw new Error("INVALID_SCOPE");
  const { scope, assignments } = value as AssignmentVerificationScope;
  if (
    !canvasPagePlanId(scope) ||
    !Array.isArray(assignments) ||
    assignments.length < 1 ||
    assignments.length > 4 ||
    !assignments.every(
      (entry) =>
        entry &&
        canvasPageId(entry.assignmentId) &&
        isAssignmentVerifier(entry.provider) &&
        Array.isArray(entry.studentIds) &&
        entry.studentIds.length > 0 &&
        entry.studentIds.length <= verificationClassSize &&
        entry.studentIds.every(canvasPageId) &&
        new Set(entry.studentIds).size === entry.studentIds.length,
    )
  )
    throw new Error("INVALID_SCOPE");
  return { scope, assignments };
}

export function readAssignmentVerificationResult(
  value: unknown,
): AssignmentVerificationResult {
  const result = value as AssignmentVerificationResult;
  if (
    result?.state === "UNKNOWN" &&
    [
      "NOT_SUBMITTED",
      "SOURCE_UNAVAILABLE",
      "ATTEMPT_CHANGED",
      "PROVIDER_UNAVAILABLE",
    ].includes(result.reason)
  )
    return { state: result.state, reason: result.reason };
  if (
    (result?.state === "OBSERVED" || result?.state === "PARTIAL") &&
    Number.isSafeInteger(result.attempt) &&
    result.attempt > 0 &&
    canvasFeedbackSubmittedAt(result.submittedAt) &&
    Array.isArray(result.checks) &&
    result.checks.length >= 1 &&
    result.checks.length <= 5 &&
    result.checks.every((state) => verificationOutcomes.includes(state))
  ) {
    return {
      state: result.state,
      attempt: result.attempt,
      submittedAt: result.submittedAt,
      checks: result.checks,
    };
  }
  throw new Error("INVALID_RESULT");
}
