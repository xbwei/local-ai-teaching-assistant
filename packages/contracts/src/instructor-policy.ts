import { Ajv } from "ajv";
import type {
  AccessClass,
  DataClassId,
  InputType,
  LearningMode,
  Workflow,
} from "./policy-contract.generated.ts";
import { reviewedPolicyRuntimeContract } from "./policy-contract.generated.ts";
import type { CapabilityAvailability } from "./capability.ts";

export const approvedInstructorLocalModels =
  reviewedPolicyRuntimeContract.demoModels.local;
export const approvedInstructorOpenAIModels =
  reviewedPolicyRuntimeContract.demoModels.openai;

export interface InstructorPolicySchedule {
  readonly timeZone: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface InstructorEligibilityControls {
  readonly courseRefs: readonly string[];
  readonly accessClasses: readonly AccessClass[];
  readonly workflows: readonly Workflow[];
  readonly learningModes: readonly LearningMode[];
  readonly inputTypes: readonly InputType[];
  readonly dataClasses: readonly DataClassId[];
}

export interface ComparisonContextPolicy {
  readonly enabled: boolean;
  readonly courseRef: string;
  readonly moduleRef: string;
  readonly workflow: Workflow;
  readonly learningMode: LearningMode;
  readonly inputType: InputType;
  readonly dataClass: DataClassId;
  readonly maxInputCharacters: number;
}

export interface InstructorPolicyDocument {
  readonly contractVersion: "instructor-policy.v1";
  readonly cloudEnabled: boolean;
  readonly emergencyCloudDisabled: boolean;
  readonly schedule: InstructorPolicySchedule | null;
  readonly eligibility: InstructorEligibilityControls;
  readonly models: {
    readonly local: readonly string[];
    readonly activeLocal: string;
    readonly openai: readonly string[];
  };
  readonly comparison: ComparisonContextPolicy;
}

export interface InstructorPolicyState {
  readonly contractVersion: "instructor-policy-state.v1";
  readonly version: number;
  readonly digest: `sha256:${string}`;
  readonly activatedAt: string;
  readonly policy: InstructorPolicyDocument;
}

export interface InstructorPolicyHistoryEntry {
  readonly contractVersion: "instructor-policy-history.v1";
  readonly version: number;
  readonly previousVersion: number | null;
  readonly actorRole: "ADMIN" | "INSTRUCTOR";
  readonly change: "ACTIVATE" | "ROLLBACK" | "EMERGENCY_CLOUD_DISABLE";
  readonly timestamp: string;
  readonly policyDigest: `sha256:${string}`;
}

export interface InstructorPolicyPreview {
  readonly contractVersion: "instructor-policy-preview.v1";
  readonly basedOnVersion: number;
  readonly policyDigest: `sha256:${string}`;
  readonly scheduleOpen: boolean;
  readonly capability: CapabilityAvailability;
}

export interface InstructorPolicyMutation {
  readonly contractVersion: "instructor-policy-mutation.v1";
  readonly expectedVersion: number;
  readonly previewDigest: `sha256:${string}`;
  readonly policy: InstructorPolicyDocument;
}

export interface InstructorPolicyPreviewRequest {
  readonly contractVersion: "instructor-policy-preview-request.v1";
  readonly expectedVersion: number;
  readonly policy: InstructorPolicyDocument;
}

export interface InstructorPolicyRollback {
  readonly contractVersion: "instructor-policy-rollback.v1";
  readonly expectedVersion: number;
}

export interface InstructorPolicyEmergencyDisable {
  readonly contractVersion: "instructor-policy-emergency-disable.v1";
  readonly expectedVersion: number;
}

const timestampPattern =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,3})?(?:Z|[+-][0-9]{2}:[0-9]{2})$";
const referencePattern = "^[A-Za-z][A-Za-z0-9_-]{0,63}$";
const uniqueStrings = (items: readonly string[], minItems = 1) => ({
  type: "array",
  items: { type: "string", enum: items },
  minItems,
  maxItems: items.length,
  uniqueItems: true,
});

export const instructorPolicySchema = {
  $id: "urn:teaching:instructor-policy:v1",
  type: "object",
  properties: {
    contractVersion: { const: "instructor-policy.v1" },
    cloudEnabled: { type: "boolean" },
    emergencyCloudDisabled: { type: "boolean" },
    schedule: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            timeZone: { type: "string", minLength: 1, maxLength: 64 },
            startsAt: { type: "string", pattern: timestampPattern },
            endsAt: { type: "string", pattern: timestampPattern },
          },
          required: ["timeZone", "startsAt", "endsAt"],
          additionalProperties: false,
        },
      ],
    },
    eligibility: {
      type: "object",
      properties: {
        courseRefs: {
          type: "array",
          items: { type: "string", pattern: referencePattern },
          minItems: 1,
          maxItems: 16,
          uniqueItems: true,
        },
        accessClasses: uniqueStrings(["INSTRUCTOR"]),
        workflows: uniqueStrings(["COURSE_QA", "CODING_COACH"]),
        learningModes: uniqueStrings(["DIRECT_EXPLANATION"]),
        inputTypes: uniqueStrings(["TEXT"]),
        dataClasses: uniqueStrings([
          "IDENTITY_FREE_USER_TEXT",
          "IDENTITY_MINIMIZED_USER_TEXT",
        ]),
      },
      required: [
        "courseRefs",
        "accessClasses",
        "workflows",
        "learningModes",
        "inputTypes",
        "dataClasses",
      ],
      additionalProperties: false,
    },
    models: {
      type: "object",
      properties: {
        local: uniqueStrings(approvedInstructorLocalModels),
        activeLocal: { type: "string", enum: approvedInstructorLocalModels },
        openai: uniqueStrings(approvedInstructorOpenAIModels, 0),
      },
      required: ["local", "activeLocal", "openai"],
      additionalProperties: false,
    },
    comparison: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        courseRef: { type: "string", pattern: referencePattern },
        moduleRef: { type: "string", pattern: referencePattern },
        workflow: { type: "string", enum: ["COURSE_QA", "CODING_COACH"] },
        learningMode: { type: "string", enum: ["DIRECT_EXPLANATION"] },
        inputType: { type: "string", enum: ["TEXT"] },
        dataClass: { type: "string", enum: ["IDENTITY_FREE_USER_TEXT"] },
        maxInputCharacters: {
          type: "integer",
          minimum: 1,
          maximum: 8192,
        },
      },
      required: [
        "enabled",
        "courseRef",
        "moduleRef",
        "workflow",
        "learningMode",
        "inputType",
        "dataClass",
        "maxInputCharacters",
      ],
      additionalProperties: false,
    },
  },
  required: [
    "contractVersion",
    "cloudEnabled",
    "emergencyCloudDisabled",
    "schedule",
    "eligibility",
    "models",
    "comparison",
  ],
  additionalProperties: false,
} as const;

const mutationSchema = {
  type: "object",
  properties: {
    contractVersion: { const: "instructor-policy-mutation.v1" },
    expectedVersion: { type: "integer", minimum: 1 },
    previewDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    policy: instructorPolicySchema,
  },
  required: ["contractVersion", "expectedVersion", "previewDigest", "policy"],
  additionalProperties: false,
} as const;
const previewRequestSchema = {
  type: "object",
  properties: {
    contractVersion: { const: "instructor-policy-preview-request.v1" },
    expectedVersion: { type: "integer", minimum: 1 },
    policy: instructorPolicySchema,
  },
  required: ["contractVersion", "expectedVersion", "policy"],
  additionalProperties: false,
} as const;
const rollbackSchema = {
  type: "object",
  properties: {
    contractVersion: { const: "instructor-policy-rollback.v1" },
    expectedVersion: { type: "integer", minimum: 2 },
  },
  required: ["contractVersion", "expectedVersion"],
  additionalProperties: false,
} as const;
const emergencySchema = {
  type: "object",
  properties: {
    contractVersion: { const: "instructor-policy-emergency-disable.v1" },
    expectedVersion: { type: "integer", minimum: 1 },
  },
  required: ["contractVersion", "expectedVersion"],
  additionalProperties: false,
} as const;

const ajv = new Ajv({ strict: true });
export const isInstructorPolicyDocument = ajv.compile<InstructorPolicyDocument>(
  instructorPolicySchema,
);
export const isInstructorPolicyMutation =
  ajv.compile<InstructorPolicyMutation>(mutationSchema);
export const isInstructorPolicyPreviewRequest =
  ajv.compile<InstructorPolicyPreviewRequest>(previewRequestSchema);
export const isInstructorPolicyRollback =
  ajv.compile<InstructorPolicyRollback>(rollbackSchema);
export const isInstructorPolicyEmergencyDisable =
  ajv.compile<InstructorPolicyEmergencyDisable>(emergencySchema);
