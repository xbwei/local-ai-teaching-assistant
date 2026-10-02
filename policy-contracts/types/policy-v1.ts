export type VersionIdentifier = `${string}.v${number}`;

export type DataClassId =
  | "APPROVED_PUBLIC_COURSE_KNOWLEDGE"
  | "APPROVED_PRIVATE_COURSE_MATERIAL"
  | "IDENTITY_FREE_USER_TEXT"
  | "IDENTITY_MINIMIZED_USER_TEXT"
  | "PRIVACY_SENSITIVE_STUDENT_CONTENT"
  | "TEMPORARY_UPLOAD"
  | "ASSIGNMENT_ARTIFACT"
  | "DERIVED_VERIFIER_EVIDENCE"
  | "RESTRICTED_ASSESSMENT_CONTENT"
  | "INSTRUCTOR_ONLY_SOLUTION_MATERIAL"
  | "OPERATIONAL_METADATA"
  | "FEEDBACK_REPORT_CONTENT"
  | "TEMPORARY_SPEECH_AUDIO"
  | "RESEARCH_DATA";

export type RetentionProfileId =
  | "APPROVED_COURSE_KNOWLEDGE"
  | "SESSION_TEXT"
  | "INTERACTION_METADATA"
  | "FEEDBACK"
  | "ISSUE_REPORT"
  | "OPTIONAL_RETAINED_REPORT_CONTENT"
  | "SAFETY_OPERATIONS_METADATA"
  | "UPLOAD"
  | "GENERATED_TEMPORARY_FILE"
  | "RAW_MICROPHONE_AUDIO"
  | "GENERATED_TTS_AUDIO"
  | "VERIFIER_WORKSPACE"
  | "DETERMINISTIC_EVIDENCE"
  | "DELETION_FAILURE_METADATA"
  | "EVALUATION_FIXTURE_RESULT"
  | "RETENTION_PROHIBITED";

export interface DataClassification {
  readonly id: DataClassId;
  readonly description: string;
  readonly providerProcessing:
    | "LOCAL_ONLY"
    | "CLOUD_EXPLICIT_ALLOW"
    | "PROHIBITED";
  readonly storage:
    | "APPROVED_KNOWLEDGE"
    | "LOCAL_IDENTITY_MINIMIZED"
    | "LOCAL_TEMPORARY"
    | "NO_PERSISTENCE";
  readonly retentionProfile: RetentionProfileId;
}

export interface DataClassificationPolicy {
  readonly schemaVersion: "data-classification-schema.v1";
  readonly classificationVersion: VersionIdentifier;
  readonly classes: readonly DataClassification[];
}

export type AccessClass =
  | "ANONYMOUS_SESSION"
  | "STUDENT"
  | "INSTRUCTOR"
  | "OPERATOR"
  | "RESEARCHER";
export type Workflow =
  | "COURSE_QA"
  | "CONCEPT_REVIEW"
  | "EXAM_PRACTICE"
  | "CODING_COACH"
  | "ASSIGNMENT_VERIFICATION"
  | "FACULTY_AUTHORING"
  | "FEEDBACK_REPORT"
  | "RESEARCH_EVALUATION";
export type LearningMode =
  | "DIRECT_EXPLANATION"
  | "SOCRATIC"
  | "PRACTICE"
  | "VERIFICATION"
  | "AUTHORING"
  | "EVALUATION";
export type InputType =
  | "TEXT"
  | "KNOWLEDGE_REFERENCE"
  | "UPLOAD_REFERENCE"
  | "DETERMINISTIC_EVIDENCE_REFERENCE"
  | "AUDIO_REFERENCE";
export type ArtifactState =
  | "NONE"
  | "MINIMIZED_DERIVATION"
  | "TEMPORARY_UPLOAD"
  | "ASSIGNMENT_ARTIFACT";

export interface ProviderAllowRule {
  readonly id: string;
  readonly provider: "LOCAL" | "OPENAI";
  readonly models: readonly string[];
  readonly accessClasses: readonly AccessClass[];
  readonly workflows: readonly Workflow[];
  readonly learningModes: readonly LearningMode[];
  readonly inputTypes: readonly InputType[];
  readonly dataClasses: readonly DataClassId[];
  readonly artifactStates: readonly ArtifactState[];
  readonly requireFeatureEnabled: true;
  readonly requireScheduleOpen: true;
  readonly requireWithinBudget: true;
  readonly requireQuotaAvailable: true;
  readonly activeAssessment: "DENY" | "ALLOW";
}

export type DenyReason =
  | "POLICY_VERSION_MISMATCH"
  | "CLIENT_POLICY_OVERRIDE"
  | "UNKNOWN_DATA_CLASS"
  | "PROVIDER_PROCESSING_PROHIBITED"
  | "CLOUD_NOT_EXPLICITLY_ALLOWED"
  | "LOCAL_ONLY_DATA"
  | "PROVIDER_DISABLED"
  | "SCHEDULE_CLOSED"
  | "ACTIVE_ASSESSMENT"
  | "OVER_BUDGET"
  | "QUOTA_UNAVAILABLE"
  | "MODEL_NOT_ALLOWED"
  | "CONTEXT_NOT_ALLOWED";

export interface ProviderEligibilityPolicy {
  readonly schemaVersion: "provider-eligibility-schema.v1";
  readonly providerPolicyVersion: VersionIdentifier;
  readonly defaultProvider: "LOCAL";
  readonly cloudDefault: "DENY";
  readonly fallback: "PROHIBITED";
  readonly allowRules: readonly ProviderAllowRule[];
  readonly denyReasonPrecedence: readonly DenyReason[];
}

export interface CapabilityEvaluationContext {
  readonly contractVersion: "capability-evaluation.v1";
  readonly policyVersion: VersionIdentifier;
  readonly classificationVersion: VersionIdentifier;
  readonly retentionPolicyVersion: VersionIdentifier;
  readonly gradingBoundaryVersion: VersionIdentifier;
  readonly accessClass: AccessClass;
  readonly courseRef: string;
  readonly moduleRef: string;
  readonly workflow: Workflow;
  readonly learningMode: LearningMode;
  readonly inputType: InputType;
  readonly dataClass: DataClassId;
  readonly artifactState: ArtifactState;
  readonly targetProvider: "LOCAL" | "OPENAI";
  readonly targetModel: string;
  readonly scheduleOpen: boolean;
  readonly providerFeatureEnabled: boolean;
  readonly withinBudget: boolean;
  readonly quotaAvailable: boolean;
  readonly activeAssessment: boolean;
  readonly clientPolicyOverrideRequested: boolean;
}

export interface InteractionRecord {
  readonly contractVersion: "interaction-record.v1";
  readonly sessionRef: `session-${string}`;
  readonly dataClass: DataClassId;
  readonly retentionProfile: RetentionProfileId;
  readonly policyVersion: VersionIdentifier;
  readonly createdAt: string;
  readonly content?: string;
  readonly objectiveFormativePoints?: number;
  readonly aiRecommendation?: string;
  readonly instructorApprovedResultRef?: `result-${string}`;
}

export type EvaluationOutcome =
  | {readonly allowed: true; readonly reason: "EXPLICIT_ALLOW"}
  | {readonly allowed: false; readonly reason: DenyReason};

interface CapabilityDecisionBase {
  readonly contractVersion: "capability-decision.v1";
  readonly decisionRef: string;
  readonly evaluatedContextDigest: `sha256:${string}`;
  readonly policyVersion: VersionIdentifier;
  readonly classificationVersion: VersionIdentifier;
  readonly retentionPolicyVersion: VersionIdentifier;
  readonly gradingBoundaryVersion: VersionIdentifier;
  readonly targetProvider: "LOCAL" | "OPENAI";
  readonly targetModel: string;
  readonly constraints: {
    readonly localOnly: boolean;
    readonly noFallback: true;
    readonly minimizedContentRequired: boolean;
  };
  readonly recheckOn: readonly (
    | "INPUT_CHANGE"
    | "ARTIFACT_CHANGE"
    | "COURSE_OR_MODULE_CHANGE"
    | "WORKFLOW_OR_MODE_CHANGE"
    | "PROVIDER_OR_MODEL_CHANGE"
    | "SCHEDULE_OR_FEATURE_CHANGE"
    | "BUDGET_OR_QUOTA_CHANGE"
    | "ASSESSMENT_STATE_CHANGE"
    | "POLICY_VERSION_CHANGE"
    | "DECISION_EXPIRY"
  )[];
}

export type CapabilityDecision = CapabilityDecisionBase &
  (
    | {readonly allowed: true; readonly reasonCodes: readonly ["EXPLICIT_ALLOW"]}
    | {readonly allowed: false; readonly reasonCodes: readonly DenyReason[]}
  );

// JSON Schema further requires bounded, non-negative integer components.
export type FixedRetentionDuration =
  | `P${number}D`
  | `PT${number}H`
  | `PT${number}M`
  | `PT${number}H${number}M`
  | `P${number}DT${number}H`
  | `P${number}DT${number}M`
  | `P${number}DT${number}H${number}M`;

interface RetentionProfileBase {
  readonly id: RetentionProfileId;
  readonly purpose: string;
  readonly deletionTriggers: readonly DeletionTrigger[];
  readonly onSessionReset: "DELETE" | "KEEP_UNTIL_EXPIRY" | "NOT_APPLICABLE";
  readonly onSessionEnd: "DELETE" | "KEEP_UNTIL_EXPIRY" | "NOT_APPLICABLE";
  readonly deletionFailure: {
    readonly retry: "BOUNDED_BACKOFF" | "NO_RETRY";
    readonly recordMetadataOnly: boolean;
    readonly contentMayPersistOnlyUntilDeleted: boolean;
  };
}

export type RetentionProfile = RetentionProfileBase & (
  | {
      readonly duration: FixedRetentionDuration;
      readonly expiryBasis:
        | "CREATED_AT" | "LAST_ACTIVITY_AT" | "SESSION_END"
        | "DELIVERY_COMPLETED_AT" | "RUN_COMPLETED_AT" | "DELETION_FAILURE_AT";
      readonly storageLocation: "LOCAL_ONLY" | "APPROVED_KNOWLEDGE_STORE" | "NO_STORAGE";
      readonly contentPersistence: "CONTENT_ALLOWED" | "METADATA_ONLY" | "TRANSIENT_ONLY" | "PROHIBITED";
    }
  | {
      readonly duration: "PROHIBITED";
      readonly expiryBasis: "NEVER_PERSIST";
      readonly storageLocation: "NO_STORAGE";
      readonly contentPersistence: "PROHIBITED";
    }
);

export type DeletionTrigger =
  | "EXPIRY"
  | "SESSION_RESET"
  | "SESSION_END"
  | "DELIVERY"
  | "RUN_COMPLETION"
  | "USER_REQUEST"
  | "VALIDATION_FAILURE"
  | "CANCELLATION"
  | "STARTUP_RECOVERY";

export interface RetentionPolicy {
  readonly schemaVersion: "retention-schema.v1";
  readonly retentionPolicyVersion: VersionIdentifier;
  readonly institutionalStatus: "GENERIC_REFERENCE_VALUES_NOT_INSTITUTIONAL_POLICY";
  readonly profiles: readonly RetentionProfile[];
}

export type GradeLayerId =
  | "DETERMINISTIC_EVIDENCE"
  | "OBJECTIVE_FORMATIVE_POINTS"
  | "AI_RECOMMENDATION"
  | "INSTRUCTOR_APPROVED_RESULT"
  | "OFFICIAL_GRADE";

export type GradeLayer =
  | {readonly id: "DETERMINISTIC_EVIDENCE"; readonly authority: "VERIFIER"; readonly aiMayCreate: false; readonly mutableByAI: false; readonly interactionStoreAllowed: true}
  | {readonly id: "OBJECTIVE_FORMATIVE_POINTS"; readonly authority: "DETERMINISTIC_RULE"; readonly aiMayCreate: false; readonly mutableByAI: false; readonly interactionStoreAllowed: true}
  | {readonly id: "AI_RECOMMENDATION"; readonly authority: "AI"; readonly aiMayCreate: true; readonly mutableByAI: false; readonly interactionStoreAllowed: true}
  | {readonly id: "INSTRUCTOR_APPROVED_RESULT"; readonly authority: "INSTRUCTOR"; readonly aiMayCreate: false; readonly mutableByAI: false; readonly interactionStoreAllowed: true}
  | {readonly id: "OFFICIAL_GRADE"; readonly authority: "SEPARATELY_GOVERNED_GRADE_SYSTEM"; readonly aiMayCreate: false; readonly mutableByAI: false; readonly interactionStoreAllowed: false};

export interface GradeBoundaryPolicy {
  readonly schemaVersion: "grade-boundary-schema.v1";
  readonly gradingBoundaryVersion: VersionIdentifier;
  readonly layers: readonly GradeLayer[];
  readonly allowedTransitions: readonly {
    readonly from: Exclude<GradeLayerId, "OFFICIAL_GRADE">;
    readonly to: Exclude<GradeLayerId, "DETERMINISTIC_EVIDENCE" | "OFFICIAL_GRADE">;
    readonly requires:
      | "DETERMINISTIC_DERIVATION"
      | "READ_ONLY_EVIDENCE_REFERENCE"
      | "INSTRUCTOR_APPROVAL";
  }[];
  readonly prohibitions: readonly GradeProhibition[];
}

export type GradeProhibition =
  | "AI_MUTATES_DETERMINISTIC_EVIDENCE"
  | "AI_MUTATES_OBJECTIVE_POINTS"
  | "AI_SELF_APPROVES_RESULT"
  | "OFFICIAL_GRADE_IN_SESSION_DATA"
  | "PERSISTENT_STUDENT_IDENTITY_IN_INTERACTION_STORE"
  | "AUTONOMOUS_OFFICIAL_GRADE_WRITE";

export interface PolicyBundle {
  readonly schemaVersion: "policy-bundle-schema.v1";
  readonly policyVersion: VersionIdentifier;
  readonly classificationVersion: VersionIdentifier;
  readonly providerPolicyVersion: VersionIdentifier;
  readonly retentionPolicyVersion: VersionIdentifier;
  readonly gradingBoundaryVersion: VersionIdentifier;
  readonly documents: {
    readonly classification: "data-classification.policy.json";
    readonly providerEligibility: "provider-eligibility.policy.json";
    readonly retention: "retention.policy.json";
    readonly gradingBoundary: "grade-boundary.policy.json";
  };
}
