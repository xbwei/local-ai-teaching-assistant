export { canonicalJson } from "./canonical-json.ts";

// Browser-safe exports only. Server configuration has a separate Node-only entry.
export {
  clientConfigurationSchema,
  isClientConfiguration,
} from "./configuration-client.ts";
export type {
  ClientConfiguration,
  DemoFeatures,
} from "./configuration-client.ts";

export {
  publicErrorMessages,
  publicErrorSchema,
  correlationIdPattern,
  isPublicError,
} from "./public-error.ts";
export type { PublicError, PublicErrorCode } from "./public-error.ts";

export {
  healthStatus,
  healthStatusSchema,
  readinessStatusSchema,
  isHealthStatus,
  isReadinessStatus,
} from "./health.ts";
export type { HealthStatus, ReadinessStatus } from "./health.ts";

export {
  capabilityAvailabilitySchema,
  isCapabilityAvailability,
} from "./capability.ts";
export type {
  CapabilityAvailability,
  CapabilityIdentity,
  CapabilityMode,
  CapabilityModelChoice,
  ClientLocalState,
  ProviderAvailability,
} from "./capability.ts";

export {
  isProviderRequest,
  isProviderOutcome,
  isProviderStreamEvent,
  isCapabilityDecision,
  isCapabilityEvaluationContext,
  reviewedPolicyRuntimeContract,
} from "./provider.ts";

export {
  isProviderHealthSnapshot,
  isProviderRunRequest,
  isProviderRunResult,
} from "./provider-control.ts";
export type {
  ClientProviderFailureCode,
  ClientRunLeg,
  CourseGrounding,
  CourseSourceReference,
  ProviderHealthSnapshot,
  ProviderHealthStatus,
  ProviderRunRequest,
  ProviderRunResult,
} from "./provider-control.ts";

export {
  isUsageAdmissionRequest,
  isProviderUsageSummary,
  isUsageReconciliation,
  isUsageTerminalUpdate,
} from "./provider-usage.ts";
export type {
  ProviderUsagePolicy,
  ProviderUsageRecord,
  ProviderUsageRepository,
  ProviderUsageSummary,
  UsageAggregate,
  UsageAdmissionRequest,
  UsageLimitCode,
  UsageOutcome,
  UsageReconciliation,
  UsageRepositoryResult,
  UsageReservationCommand,
  UsageState,
  UsageTerminalUpdate,
} from "./provider-usage.ts";

export {
  approvedInstructorLocalModels,
  approvedInstructorOpenAIModels,
  instructorPolicySchema,
  isInstructorPolicyDocument,
  isInstructorPolicyEmergencyDisable,
  isInstructorPolicyMutation,
  isInstructorPolicyPreviewRequest,
  isInstructorPolicyRollback,
} from "./instructor-policy.ts";
export type {
  ComparisonContextPolicy,
  InstructorEligibilityControls,
  InstructorPolicyDocument,
  InstructorPolicyEmergencyDisable,
  InstructorPolicyHistoryEntry,
  InstructorPolicyMutation,
  InstructorPolicyPreview,
  InstructorPolicyPreviewRequest,
  InstructorPolicyRollback,
  InstructorPolicySchedule,
  InstructorPolicyState,
} from "./instructor-policy.ts";
export type {
  AccessClass,
  ArtifactState,
  CapabilityDecision,
  CapabilityEvaluationContext,
  DataClassId,
  DenyReason,
  InputType,
  LearningMode,
  ProviderEligibilityPolicy,
  VersionIdentifier,
  Workflow,
} from "./policy-contract.generated.ts";
export type {
  AllowedProviderPolicyDecision,
  GenerationConfiguration,
  LocalModelResidency,
  LocalProviderProvenance,
  LocalResourceMetadata,
  ModelIdentity,
  OpenAIProviderProvenance,
  ProviderAdapter,
  ProviderErrorCode,
  ProviderExecutionContext,
  ProviderFailure,
  ProviderIdentity,
  ProviderOutcome,
  ProviderId,
  ProviderPolicyDecision,
  ProviderRequest,
  ProviderSelection,
  ProviderStreamEvent,
  ProviderSuccess,
  ProviderUsage,
} from "./provider.ts";
export * from "./input.ts";

export * from "./input-client.ts";

export {
  replyInstruction,
  conversationLimits,
  validConversation,
} from "./provider-control.ts";
export type { ConversationMessage } from "./provider-control.ts";

export {
  providerMessages,
  reservedProviderInput,
  conversationForProvider,
} from "./provider-control.ts";

export * from "./history.ts";
