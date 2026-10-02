import type {
  CapabilityEvaluationContext,
  DataClassId,
  EvaluationOutcome,
  GradeLayer,
  GradeProhibition,
  InteractionRecord,
  RetentionProfile,
  FixedRetentionDuration,
  DeletionTrigger,
} from "./policy-v1.js";

const validContext: CapabilityEvaluationContext = {
  contractVersion: "capability-evaluation.v1",
  policyVersion: "teaching-policy.v1",
  classificationVersion: "data-classification.v1",
  retentionPolicyVersion: "retention-policy.v1",
  gradingBoundaryVersion: "grading-boundary.v1",
  accessClass: "STUDENT",
  courseRef: "course-synthetic",
  moduleRef: "module-intro",
  workflow: "CONCEPT_REVIEW",
  learningMode: "SOCRATIC",
  inputType: "TEXT",
  dataClass: "IDENTITY_FREE_USER_TEXT",
  artifactState: "NONE",
  targetProvider: "OPENAI",
  targetModel: "cloud-approved-model",
  scheduleOpen: true,
  providerFeatureEnabled: true,
  withinBudget: true,
  quotaAvailable: true,
  activeAssessment: false,
  clientPolicyOverrideRequested: false,
};

const deniedDecision: EvaluationOutcome = {
  allowed: false,
  reason: "CLOUD_NOT_EXPLICITLY_ALLOWED",
};

const aiLayer: GradeLayer = {
  id: "AI_RECOMMENDATION",
  authority: "AI",
  aiMayCreate: true,
  mutableByAI: false,
  interactionStoreAllowed: true,
};

const validInteraction: InteractionRecord = {
  contractVersion: "interaction-record.v1",
  sessionRef: "session-synthetic-a1",
  dataClass: "IDENTITY_FREE_USER_TEXT",
  retentionProfile: "SESSION_TEXT",
  policyVersion: "teaching-policy.v1",
  createdAt: "2026-01-01T00:00:00Z",
  content: "Explain a public synthetic example.",
};

// @ts-expect-error Official grades are not a valid interaction data class.
const invalidDataClass: DataClassId = "OFFICIAL_GRADE";
// @ts-expect-error Allowed decisions must use EXPLICIT_ALLOW.
const invalidDecision: EvaluationOutcome = {allowed: true, reason: "OVER_BUDGET"};
// @ts-expect-error Recorded grading layers are immutable to AI.
const invalidAiLayer: GradeLayer = {...aiLayer, mutableByAI: true};
// @ts-expect-error Persistent student identity is not an interaction field.
const interactionWithIdentity: InteractionRecord = {...validInteraction, studentId: "synthetic-identity"};
// @ts-expect-error Official grades are not an interaction field.
const interactionWithGrade: InteractionRecord = {...validInteraction, officialGrade: 95};
// @ts-expect-error Retention triggers are a closed contract.
const invalidDeletionTrigger: DeletionTrigger = "KEEP_FOREVER";
// @ts-expect-error Grading prohibitions are a closed contract.
const invalidGradeProhibition: GradeProhibition = "AI_WRITES_GRADE";

void validContext;
void deniedDecision;
void aiLayer;
void invalidDataClass;
void invalidDecision;
void invalidAiLayer;
void validInteraction;
void interactionWithIdentity;
void interactionWithGrade;
void invalidDeletionTrigger;
void invalidGradeProhibition;

const finiteRetention: RetentionProfile = {
  id: "SESSION_TEXT", purpose: "Synthetic session retention", duration: "P1D",
  expiryBasis: "SESSION_END", storageLocation: "LOCAL_ONLY", contentPersistence: "CONTENT_ALLOWED",
  deletionTriggers: ["EXPIRY"], onSessionReset: "DELETE", onSessionEnd: "KEEP_UNTIL_EXPIRY",
  deletionFailure: {retry: "BOUNDED_BACKOFF", recordMetadataOnly: true, contentMayPersistOnlyUntilDeleted: true},
};
const prohibitedRetention: RetentionProfile = {
  ...finiteRetention, duration: "PROHIBITED", expiryBasis: "NEVER_PERSIST",
  storageLocation: "NO_STORAGE", contentPersistence: "PROHIBITED",
};
// @ts-expect-error A finite duration cannot select NEVER_PERSIST.
const invalidFiniteRetention: RetentionProfile = {...finiteRetention, expiryBasis: "NEVER_PERSIST"};
// @ts-expect-error A prohibited duration cannot select a timed expiry basis.
const invalidProhibitedBasis: RetentionProfile = {...prohibitedRetention, expiryBasis: "CREATED_AT"};
// @ts-expect-error Prohibited retention cannot allow storage.
const invalidProhibitedStorage: RetentionProfile = {...prohibitedRetention, storageLocation: "LOCAL_ONLY"};
// @ts-expect-error Prohibited retention cannot allow content persistence.
const invalidProhibitedContent: RetentionProfile = {...prohibitedRetention, contentPersistence: "CONTENT_ALLOWED"};
// @ts-expect-error Calendar months are not a supported fixed duration unit.
const invalidCalendarDuration: FixedRetentionDuration = "P1M";

void finiteRetention;
void prohibitedRetention;
void invalidFiniteRetention;
void invalidProhibitedBasis;
void invalidProhibitedStorage;
void invalidProhibitedContent;
void invalidCalendarDuration;
