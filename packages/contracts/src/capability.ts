import { Ajv } from "ajv";

export type ClientLocalState =
  "READY" | "LOADING" | "SWITCHING" | "BUSY" | "UNAVAILABLE";

export interface CapabilityIdentity {
  readonly policy: {
    readonly runtimeDigest: `sha256:${string}`;
    readonly profileVersion: "demo-profile.v2" | "demo-profile.v4";
    readonly policyVersion: "demo-policy.v2" | "demo-policy.v4";
    readonly providerPolicyVersion:
      "demo-provider-eligibility.v2" | "demo-provider-eligibility.v4";
    readonly classificationVersion: "data-classification.v1";
    readonly retentionPolicyVersion: "retention-policy.v1";
    readonly gradingBoundaryVersion: "grading-boundary.v1";
  };
  readonly configuration: {
    readonly version: "application-configuration.v2";
    readonly digest: `sha256:${string}`;
  };
}

export interface CapabilityModelChoice {
  readonly id: string;
  readonly label: string;
}

export type ProviderAvailability =
  | {
      readonly id: "LOCAL";
      readonly label: "Local";
      readonly state: ClientLocalState;
      readonly models: readonly CapabilityModelChoice[];
    }
  | {
      readonly id: "OPENAI";
      readonly label: "OpenAI";
      readonly state: "READY";
      readonly models: readonly CapabilityModelChoice[];
    };

export interface CapabilityMode {
  readonly id: "LOCAL" | "OPENAI" | "COMPARE";
  readonly label: "Local" | "OpenAI" | "Compare";
  readonly providers: readonly ("LOCAL" | "OPENAI")[];
}

export interface CapabilityAvailability {
  readonly contractVersion: "capability-availability.v1";
  readonly decisionRef: `decision-${string}`;
  readonly identity: CapabilityIdentity;
  readonly providers: readonly ProviderAvailability[];
  readonly modes: readonly CapabilityMode[];
  readonly guidance:
    "SELECT_AVAILABLE_MODE" | "LOCAL_PROGRESS" | "NO_PROVIDER_AVAILABLE";
  readonly recheckOn: readonly [
    "INPUT_CHANGE",
    "ARTIFACT_CHANGE",
    "COURSE_OR_MODULE_CHANGE",
    "WORKFLOW_OR_MODE_CHANGE",
    "PROVIDER_OR_MODEL_CHANGE",
    "SCHEDULE_OR_FEATURE_CHANGE",
    "BUDGET_OR_QUOTA_CHANGE",
    "ASSESSMENT_STATE_CHANGE",
    "POLICY_VERSION_CHANGE",
    "PROVIDER_HEALTH_CHANGE",
  ];
}

const digestPattern = "^sha256:[a-f0-9]{64}$";
const modelSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 128 },
    label: { type: "string", minLength: 1, maxLength: 128 },
  },
  required: ["id", "label"],
  additionalProperties: false,
} as const;

export const capabilityAvailabilitySchema = {
  $id: "urn:teaching:capability-availability:v1",
  type: "object",
  properties: {
    contractVersion: { const: "capability-availability.v1" },
    decisionRef: { type: "string", pattern: "^decision-[a-f0-9]{24}$" },
    identity: {
      type: "object",
      properties: {
        policy: {
          type: "object",
          properties: {
            runtimeDigest: { type: "string", pattern: digestPattern },
            profileVersion: { enum: ["demo-profile.v2", "demo-profile.v4"] },
            policyVersion: { enum: ["demo-policy.v2", "demo-policy.v4"] },
            providerPolicyVersion: {
              enum: [
                "demo-provider-eligibility.v2",
                "demo-provider-eligibility.v4",
              ],
            },
            classificationVersion: { const: "data-classification.v1" },
            retentionPolicyVersion: { const: "retention-policy.v1" },
            gradingBoundaryVersion: { const: "grading-boundary.v1" },
          },
          required: [
            "runtimeDigest",
            "profileVersion",
            "policyVersion",
            "providerPolicyVersion",
            "classificationVersion",
            "retentionPolicyVersion",
            "gradingBoundaryVersion",
          ],
          additionalProperties: false,
        },
        configuration: {
          type: "object",
          properties: {
            version: { const: "application-configuration.v2" },
            digest: { type: "string", pattern: digestPattern },
          },
          required: ["version", "digest"],
          additionalProperties: false,
        },
      },
      required: ["policy", "configuration"],
      additionalProperties: false,
    },
    providers: {
      type: "array",
      maxItems: 2,
      uniqueItems: true,
      items: {
        oneOf: [
          {
            type: "object",
            properties: {
              id: { const: "LOCAL" },
              label: { const: "Local" },
              state: {
                enum: ["READY", "LOADING", "SWITCHING", "BUSY", "UNAVAILABLE"],
              },
              models: {
                type: "array",
                minItems: 1,
                maxItems: 8,
                items: modelSchema,
              },
            },
            required: ["id", "label", "state", "models"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              id: { const: "OPENAI" },
              label: { const: "OpenAI" },
              state: { const: "READY" },
              models: {
                type: "array",
                minItems: 1,
                maxItems: 8,
                items: modelSchema,
              },
            },
            required: ["id", "label", "state", "models"],
            additionalProperties: false,
          },
        ],
      },
    },
    modes: {
      type: "array",
      maxItems: 3,
      uniqueItems: true,
      items: {
        oneOf: [
          {
            type: "object",
            properties: {
              id: { const: "LOCAL" },
              label: { const: "Local" },
              providers: { const: ["LOCAL"] },
            },
            required: ["id", "label", "providers"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              id: { const: "OPENAI" },
              label: { const: "OpenAI" },
              providers: { const: ["OPENAI"] },
            },
            required: ["id", "label", "providers"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              id: { const: "COMPARE" },
              label: { const: "Compare" },
              providers: { const: ["LOCAL", "OPENAI"] },
            },
            required: ["id", "label", "providers"],
            additionalProperties: false,
          },
        ],
      },
    },
    guidance: {
      enum: [
        "SELECT_AVAILABLE_MODE",
        "LOCAL_PROGRESS",
        "NO_PROVIDER_AVAILABLE",
      ],
    },
    recheckOn: {
      const: [
        "INPUT_CHANGE",
        "ARTIFACT_CHANGE",
        "COURSE_OR_MODULE_CHANGE",
        "WORKFLOW_OR_MODE_CHANGE",
        "PROVIDER_OR_MODEL_CHANGE",
        "SCHEDULE_OR_FEATURE_CHANGE",
        "BUDGET_OR_QUOTA_CHANGE",
        "ASSESSMENT_STATE_CHANGE",
        "POLICY_VERSION_CHANGE",
        "PROVIDER_HEALTH_CHANGE",
      ],
    },
  },
  required: [
    "contractVersion",
    "decisionRef",
    "identity",
    "providers",
    "modes",
    "guidance",
    "recheckOn",
  ],
  additionalProperties: false,
} as const;

const validate = new Ajv({ strict: true, ownProperties: true }).compile(
  capabilityAvailabilitySchema,
);

export function isCapabilityAvailability(
  value: unknown,
): value is CapabilityAvailability {
  return validate(value);
}
