import { Ajv } from "ajv";
import type { JSONSchemaType } from "ajv";

// Fixed public guidance only. No exception or caller-supplied message is used.
export const publicErrorMessages = Object.freeze({
  INVALID_CONFIGURATION: "Application configuration is invalid.",
  INVALID_REQUEST: "The request is invalid.",
  CONFLICT: "The requested state has changed.",
  UNAUTHENTICATED: "Authentication is required.",
  FORBIDDEN: "The request is not authorized.",
  ACCESS_DISABLED: "Application access is disabled.",
  MAINTENANCE: "The application is in maintenance mode.",
  RATE_LIMITED: "The request limit has been reached.",
  NOT_FOUND: "The requested operation is not supported.",
  INTERNAL_FAILURE: "An internal failure occurred.",
  BUSY: "The service is busy.",
  OPERATION_TIMEOUT: "The operation timed out.",
  SERVICE_UNAVAILABLE: "The service is unavailable.",
});
export type PublicErrorCode = keyof typeof publicErrorMessages;
export interface PublicError {
  contractVersion: "public-error.v1";
  code: PublicErrorCode;
  message: string;
  correlationId: string;
  // No automatic retry is authorized by this foundation.
  retryable: false;
}

export const correlationIdPattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
export const publicErrorSchema: JSONSchemaType<PublicError> = {
  $id: "urn:teaching:public-error:v1",
  type: "object",
  properties: {
    contractVersion: { type: "string", const: "public-error.v1" },
    code: {
      type: "string",
      enum: Object.keys(publicErrorMessages) as PublicErrorCode[],
    },
    message: { type: "string", enum: Object.values(publicErrorMessages) },
    correlationId: {
      type: "string",
      maxLength: 36,
      pattern: correlationIdPattern,
    },
    retryable: { type: "boolean", const: false },
  },
  required: [
    "contractVersion",
    "code",
    "message",
    "correlationId",
    "retryable",
  ],
  additionalProperties: false,
  allOf: Object.entries(publicErrorMessages).map(([code, message]) => ({
    if: { properties: { code: { const: code } } },
    then: { properties: { message: { const: message } } },
  })),
};
const validate = new Ajv({ strict: true, ownProperties: true }).compile(
  publicErrorSchema,
);
export function isPublicError(value: unknown): value is PublicError {
  return validate(value);
}
