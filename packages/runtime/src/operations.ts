import { randomUUID } from "node:crypto";
import {
  correlationIdPattern,
  publicErrorMessages,
  type PublicError,
  type PublicErrorCode,
} from "@laita/contracts";

const idPattern = new RegExp(correlationIdPattern);
const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length === 36 && idPattern.test(value);
const validCode = (value: unknown): value is PublicErrorCode =>
  typeof value === "string" && Object.hasOwn(publicErrorMessages, value);

export function createCorrelationId(): string {
  return randomUUID();
}

export function createPublicError(
  code: unknown,
  correlationId: unknown,
): PublicError {
  const safeCode = validCode(code) ? code : "INTERNAL_FAILURE";
  return Object.freeze({
    contractVersion: "public-error.v1",
    code: safeCode,
    message: publicErrorMessages[safeCode],
    correlationId: validId(correlationId)
      ? correlationId
      : createCorrelationId(),
    retryable: false,
  });
}

// Intentionally do not read even .message, .code, .status, .stack or .cause.
export function mapUnexpectedFailure(
  _failure: unknown,
  correlationId: unknown,
): PublicError {
  return createPublicError("INTERNAL_FAILURE", correlationId);
}

export type Operation =
  | "API_STARTUP"
  | "SCAFFOLD"
  | "HEALTH"
  | "READINESS"
  | "CAPABILITY"
  | "POLICY_CONTROL"
  | "USAGE_CONTROL"
  | "PROVIDER_HEALTH"
  | "INPUT"
  | "PROVIDER_RUN"
  | "KIOSK_ACCESS"
  | "INSTRUCTOR_ACCESS"
  | "ADMIN_ACCESS"
  | "UNMATCHED";
export type OutcomeCode = "OK" | "CANCELLED" | PublicErrorCode;
export interface OperationalEventInput {
  operation: Operation;
  code: OutcomeCode;
  correlationId: string;
}
export type LogLevel = "info" | "warn" | "error";
export interface OperationalEvent extends OperationalEventInput {
  contractVersion: "operational-event.v1";
  timestamp: string;
  level: LogLevel;
  event: "API_STARTED" | "API_STARTUP_FAILED" | "HTTP_RESULT";
}
export type OperationalSink = (line: string, level: LogLevel) => void;
export interface OperationalLogger {
  write(input: OperationalEventInput): boolean;
}

function ownValue(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

// Inspect only three own data properties. Unknown fields are dropped without
// traversal; getters, toJSON, inherited values and thrown Proxy traps are not
// allowed to supply metadata. No arbitrary object/string serialization path.
export function safeOperationalEvent(input: unknown): OperationalEvent | null {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input))
      return null;
    const operation = ownValue(input, "operation");
    const code = ownValue(input, "code");
    const correlationId = ownValue(input, "correlationId");
    if (
      operation !== "API_STARTUP" &&
      operation !== "SCAFFOLD" &&
      operation !== "HEALTH" &&
      operation !== "READINESS" &&
      operation !== "CAPABILITY" &&
      operation !== "POLICY_CONTROL" &&
      operation !== "USAGE_CONTROL" &&
      operation !== "PROVIDER_HEALTH" &&
      operation !== "INPUT" &&
      operation !== "PROVIDER_RUN" &&
      operation !== "KIOSK_ACCESS" &&
      operation !== "INSTRUCTOR_ACCESS" &&
      operation !== "ADMIN_ACCESS" &&
      operation !== "UNMATCHED"
    )
      return null;
    if (code !== "OK" && code !== "CANCELLED" && !validCode(code)) return null;
    if (!validId(correlationId)) return null;
    // Bound current operation/outcome combinations; later issues extend these.
    if (
      operation === "API_STARTUP" &&
      code !== "OK" &&
      code !== "INVALID_CONFIGURATION" &&
      code !== "SERVICE_UNAVAILABLE" &&
      code !== "INTERNAL_FAILURE"
    )
      return null;
    if (
      operation === "UNMATCHED" &&
      code !== "NOT_FOUND" &&
      code !== "INTERNAL_FAILURE"
    )
      return null;
    if (
      operation === "SCAFFOLD" &&
      code !== "OK" &&
      code !== "INVALID_REQUEST" &&
      code !== "UNAUTHENTICATED" &&
      code !== "FORBIDDEN" &&
      code !== "ACCESS_DISABLED" &&
      code !== "MAINTENANCE" &&
      code !== "RATE_LIMITED" &&
      code !== "BUSY" &&
      code !== "OPERATION_TIMEOUT" &&
      code !== "CANCELLED" &&
      code !== "SERVICE_UNAVAILABLE" &&
      code !== "INTERNAL_FAILURE"
    )
      return null;
    if (operation === "HEALTH" && code !== "OK" && code !== "INTERNAL_FAILURE")
      return null;
    if (
      operation === "READINESS" &&
      code !== "OK" &&
      code !== "SERVICE_UNAVAILABLE" &&
      code !== "INTERNAL_FAILURE"
    )
      return null;
    if (
      (operation === "CAPABILITY" ||
        operation === "POLICY_CONTROL" ||
        operation === "USAGE_CONTROL" ||
        operation === "PROVIDER_HEALTH" ||
        operation === "INPUT" ||
        operation === "PROVIDER_RUN") &&
      code !== "OK" &&
      code !== "INVALID_REQUEST" &&
      code !== "UNAUTHENTICATED" &&
      code !== "FORBIDDEN" &&
      code !== "ACCESS_DISABLED" &&
      code !== "MAINTENANCE" &&
      code !== "RATE_LIMITED" &&
      code !== "NOT_FOUND" &&
      code !== "CONFLICT" &&
      code !== "SERVICE_UNAVAILABLE" &&
      code !== "INTERNAL_FAILURE"
    )
      return null;
    if (
      (operation === "KIOSK_ACCESS" ||
        operation === "INSTRUCTOR_ACCESS" ||
        operation === "ADMIN_ACCESS") &&
      code !== "OK" &&
      code !== "UNAUTHENTICATED" &&
      code !== "FORBIDDEN" &&
      code !== "ACCESS_DISABLED" &&
      code !== "MAINTENANCE" &&
      code !== "RATE_LIMITED" &&
      code !== "NOT_FOUND" &&
      code !== "INTERNAL_FAILURE"
    )
      return null;
    return Object.freeze({
      contractVersion: "operational-event.v1",
      timestamp: new Date().toISOString(),
      level:
        code === "OK"
          ? "info"
          : code === "NOT_FOUND" ||
              code === "INVALID_REQUEST" ||
              code === "BUSY" ||
              code === "UNAUTHENTICATED" ||
              code === "FORBIDDEN" ||
              code === "RATE_LIMITED" ||
              code === "CANCELLED"
            ? "warn"
            : "error",
      event:
        operation === "API_STARTUP"
          ? code === "OK"
            ? "API_STARTED"
            : "API_STARTUP_FAILED"
          : "HTTP_RESULT",
      operation,
      code,
      correlationId,
    });
  } catch {
    return null;
  }
}

const standardSink: OperationalSink = (line, level) => {
  if (level === "info") console.log(line);
  else console.error(line);
};

export function createOperationalLogger(
  sink: OperationalSink = standardSink,
): OperationalLogger {
  return {
    write(input) {
      const event = safeOperationalEvent(input);
      if (!event) return false;
      try {
        sink(JSON.stringify(event), event.level);
        return true;
      } catch {
        // Do not recursively log a sink exception or dump the rejected input.
        return false;
      }
    },
  };
}
