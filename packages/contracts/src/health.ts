import { Ajv } from "ajv";
import type { JSONSchemaType } from "ajv";
import { publicErrorSchema, type PublicError } from "./public-error.ts";

export interface HealthStatus {
  contractVersion: "health.v1";
  status: "healthy";
}
export const healthStatus: Readonly<HealthStatus> = Object.freeze({
  contractVersion: "health.v1",
  status: "healthy",
});
export const healthStatusSchema: JSONSchemaType<HealthStatus> = {
  $id: "urn:teaching:health:v1",
  type: "object",
  properties: {
    contractVersion: { type: "string", const: "health.v1" },
    status: { type: "string", const: "healthy" },
  },
  required: ["contractVersion", "status"],
  additionalProperties: false,
};
export type ReadinessStatus =
  | { contractVersion: "readiness.v1"; status: "ready" }
  | {
      contractVersion: "readiness.v1";
      status: "not-ready";
      error: PublicError & { code: "SERVICE_UNAVAILABLE" };
    };
export const readinessStatusSchema: JSONSchemaType<ReadinessStatus> = {
  $id: "urn:teaching:readiness:v1",
  oneOf: [
    {
      type: "object",
      properties: {
        contractVersion: { type: "string", const: "readiness.v1" },
        status: { type: "string", const: "ready" },
      },
      required: ["contractVersion", "status"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        contractVersion: { type: "string", const: "readiness.v1" },
        status: { type: "string", const: "not-ready" },
        error: {
          ...publicErrorSchema,
          $id: "urn:teaching:readiness-error:v1",
          properties: {
            ...publicErrorSchema.properties,
            code: { type: "string", const: "SERVICE_UNAVAILABLE" },
          },
        },
      },
      required: ["contractVersion", "status", "error"],
      additionalProperties: false,
    },
  ],
};
const ajv = new Ajv({ strict: true, ownProperties: true });
export const isHealthStatus = ajv.compile(healthStatusSchema);
export const isReadinessStatus = ajv.compile(readinessStatusSchema);
