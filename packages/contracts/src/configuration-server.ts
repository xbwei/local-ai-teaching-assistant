import { Ajv } from "ajv";
import type { JSONSchemaType } from "ajv";
import {
  demoFeaturesSchema,
  type DemoFeatures,
} from "./configuration-client.ts";

export interface RuntimeLimits {
  maxConcurrentOperations: number;
  operationTimeoutMs: number;
}

export type AccessRole = "student" | "kiosk" | "instructor";
export type AccessAudience = AccessRole | "admin" | "control";
export type AccessMode =
  | "localhost-validation"
  | "single-operator"
  | "controlled-pilot"
  | "institution-approved";
export interface AccessCredential {
  id: string;
  role: AccessRole;
  courseScopes: string[];
  tokenSha256: string;
  expiresAtEpochSeconds: number;
  revoked: boolean;
}
export interface AdminCredential {
  id: string;
  tokenSha256: string;
  expiresAtEpochSeconds: number;
  revoked: boolean;
}
export interface AccessRateLimit {
  windowSeconds: number;
  maxRequests: number;
}
export interface AccessConfiguration {
  mode: AccessMode;
  enabled: boolean;
  maintenanceMode: boolean;
  publicOrigin: string;
  requireForwardedHttps: boolean;
  authenticationRateLimit: AccessRateLimit;
  credentialRateLimit: AccessRateLimit;
  credentials: AccessCredential[];
  adminCredentials: AdminCredential[];
}

const accessRateLimitSchema: JSONSchemaType<AccessRateLimit> = {
  type: "object",
  properties: {
    windowSeconds: { type: "integer", minimum: 1, maximum: 3600 },
    maxRequests: { type: "integer", minimum: 1, maximum: 1000 },
  },
  required: ["windowSeconds", "maxRequests"],
  additionalProperties: false,
};
const credentialProperties = {
  id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
  tokenSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
  expiresAtEpochSeconds: {
    type: "integer",
    minimum: 1,
    maximum: 8640000000000,
  },
  revoked: { type: "boolean" },
} as const;
export const accessConfigurationSchema: JSONSchemaType<AccessConfiguration> = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: [
        "localhost-validation",
        "single-operator",
        "controlled-pilot",
        "institution-approved",
      ],
    },
    enabled: { type: "boolean" },
    maintenanceMode: { type: "boolean" },
    publicOrigin: { type: "string", minLength: 1, maxLength: 255 },
    requireForwardedHttps: { type: "boolean" },
    authenticationRateLimit: accessRateLimitSchema,
    credentialRateLimit: accessRateLimitSchema,
    credentials: {
      type: "array",
      minItems: 0,
      maxItems: 64,
      uniqueItems: true,
      items: {
        type: "object",
        properties: {
          ...credentialProperties,
          role: {
            type: "string",
            enum: ["student", "kiosk", "instructor"],
          },
          courseScopes: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            uniqueItems: true,
            items: {
              type: "string",
              pattern: "^[a-z][a-z0-9-]{0,63}$",
            },
          },
        },
        required: [
          "id",
          "role",
          "courseScopes",
          "tokenSha256",
          "expiresAtEpochSeconds",
          "revoked",
        ],
        additionalProperties: false,
      },
    },
    adminCredentials: {
      type: "array",
      minItems: 0,
      maxItems: 8,
      uniqueItems: true,
      items: {
        type: "object",
        properties: credentialProperties,
        required: ["id", "tokenSha256", "expiresAtEpochSeconds", "revoked"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "mode",
    "enabled",
    "maintenanceMode",
    "publicOrigin",
    "requireForwardedHttps",
    "authenticationRateLimit",
    "credentialRateLimit",
    "credentials",
    "adminCredentials",
  ],
  additionalProperties: false,
};
const validateAccess = new Ajv({ strict: true, ownProperties: true }).compile(
  accessConfigurationSchema,
);

export function isAccessConfiguration(
  value: unknown,
): value is AccessConfiguration {
  if (!validateAccess(value)) return false;
  const localhost = value.mode === "localhost-validation";
  const localhostOrigin = /^http:\/\/127\.0\.0\.1(?::([1-9][0-9]{0,4}))?$/u;
  const httpsOrigin =
    /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::([1-9][0-9]{0,4}))?$/u;
  const originMatch = (localhost ? localhostOrigin : httpsOrigin).exec(
    value.publicOrigin,
  );
  if (!originMatch) return false;
  if (originMatch[1] !== undefined && Number(originMatch[1]) > 65535)
    return false;
  if (localhost === value.requireForwardedHttps) return false;
  if (
    value.mode === "institution-approved" &&
    (value.enabled ||
      value.credentials.length !== 0 ||
      value.adminCredentials.length !== 0)
  )
    return false;
  if (
    (value.mode === "single-operator" || value.mode === "controlled-pilot") &&
    value.enabled &&
    value.adminCredentials.length === 0
  )
    return false;
  const identifiers = [
    ...value.credentials.map(({ id }) => id),
    ...value.adminCredentials.map(({ id }) => id),
  ];
  const digests = [
    ...value.credentials.map(({ tokenSha256 }) => tokenSha256),
    ...value.adminCredentials.map(({ tokenSha256 }) => tokenSha256),
  ];
  return (
    new Set(identifiers).size === identifiers.length &&
    new Set(digests).size === digests.length
  );
}
export const runtimeLimitsSchema: JSONSchemaType<RuntimeLimits> = {
  type: "object",
  properties: {
    maxConcurrentOperations: { type: "integer", minimum: 1, maximum: 4 },
    operationTimeoutMs: { type: "integer", minimum: 10, maximum: 120000 },
  },
  required: ["maxConcurrentOperations", "operationTimeoutMs"],
  additionalProperties: false,
};
export const isRuntimeLimits = new Ajv({
  strict: true,
  ownProperties: true,
}).compile(runtimeLimitsSchema);
// not copies of policy rules.
export interface ApplicationConfiguration {
  contractVersion: "application-configuration.v2";
  provenance: {
    demoProfileVersion: "demo-profile.v2" | "demo-profile.v4";
    policyVersion: "demo-policy.v2" | "demo-policy.v4";
  };
  mode: "scaffold" | "operator";
  server: { bind: "loopback"; port: number };
  runtime: RuntimeLimits;
  runtimeRoot: string | null;
  access: AccessConfiguration;
  providers: {
    local: {
      provider: "LOCAL";
      model: "gemma4:12b-mlx" | "llama3.1:8b";
      candidates: readonly ["gemma4:12b-mlx", "llama3.1:8b"];
    };
    openai: {
      provider: "OPENAI";
      model: "gpt-5.6-luna";
      secretReference: { kind: "opaque"; id: string } | null;
    };
  };
  features: DemoFeatures;
}

export const applicationConfigurationSchema: JSONSchemaType<ApplicationConfiguration> =
  {
    $id: "urn:teaching:application-configuration:v2",
    type: "object",
    properties: {
      contractVersion: {
        type: "string",
        const: "application-configuration.v2",
      },
      provenance: {
        type: "object",
        properties: {
          demoProfileVersion: {
            type: "string",
            enum: ["demo-profile.v2", "demo-profile.v4"],
          },
          policyVersion: {
            type: "string",
            enum: ["demo-policy.v2", "demo-policy.v4"],
          },
        },
        required: ["demoProfileVersion", "policyVersion"],
        additionalProperties: false,
      },
      mode: { type: "string", enum: ["scaffold", "operator"] },
      server: {
        type: "object",
        properties: {
          bind: { type: "string", const: "loopback" },
          port: { type: "integer", minimum: 1024, maximum: 65535 },
        },
        required: ["bind", "port"],
        additionalProperties: false,
      },
      runtime: runtimeLimitsSchema,
      runtimeRoot: {
        anyOf: [
          { type: "null", nullable: true },
          {
            type: "string",
            minLength: 1,
            maxLength: 4096,
            pattern: "^/[^\\u0000-\\u001f\\u007f]*(?![\\s\\S])",
          },
        ],
      },
      access: accessConfigurationSchema,
      providers: {
        type: "object",
        properties: {
          local: {
            type: "object",
            properties: {
              provider: { type: "string", const: "LOCAL" },
              model: {
                type: "string",
                enum: ["gemma4:12b-mlx", "llama3.1:8b"],
              },
              candidates: {
                type: "array",
                items: [
                  { type: "string", const: "gemma4:12b-mlx" },
                  { type: "string", const: "llama3.1:8b" },
                ],
                minItems: 2,
                maxItems: 2,
              },
            },
            required: ["provider", "model", "candidates"],
            additionalProperties: false,
          },
          openai: {
            type: "object",
            properties: {
              provider: { type: "string", const: "OPENAI" },
              model: { type: "string", const: "gpt-5.6-luna" },
              secretReference: {
                anyOf: [
                  { type: "null", nullable: true },
                  {
                    type: "object",
                    properties: {
                      kind: { type: "string", const: "opaque" },
                      id: {
                        type: "string",
                        pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
                      },
                    },
                    required: ["kind", "id"],
                    additionalProperties: false,
                  },
                ],
              },
            },
            required: ["provider", "model", "secretReference"],
            additionalProperties: false,
          },
        },
        required: ["local", "openai"],
        additionalProperties: false,
      },
      features: demoFeaturesSchema,
    },
    required: [
      "contractVersion",
      "provenance",
      "mode",
      "server",
      "runtime",
      "runtimeRoot",
      "access",
      "providers",
      "features",
    ],
    additionalProperties: false,
    allOf: [
      {
        if: { properties: { mode: { const: "operator" } } },
        then: { properties: { runtimeRoot: { type: "string" } } },
      },
      {
        if: { properties: { mode: { const: "scaffold" } } },
        then: {
          properties: {
            features: {
              type: "object",
              properties: Object.fromEntries(
                ["openai", "compare", "speech"].map((flag) => [
                  flag,
                  { const: false },
                ]),
              ),
            },
          },
        },
      },
      {
        if: {
          properties: {
            features: {
              type: "object",
              properties: { openai: { const: true } },
            },
          },
        },
        then: {
          properties: {
            providers: {
              type: "object",
              properties: {
                openai: {
                  type: "object",
                  properties: { secretReference: { type: "object" } },
                },
              },
            },
          },
        },
      },
    ],
  };
const validateApplication = new Ajv({
  strict: true,
  ownProperties: true,
}).compile(applicationConfigurationSchema);

export function isApplicationConfiguration(
  value: unknown,
): value is ApplicationConfiguration {
  return validateApplication(value) && isAccessConfiguration(value.access);
}
