import { createHash } from "node:crypto";
import {
  canonicalJson,
  isCapabilityDecision,
  isCapabilityEvaluationContext,
  reviewedPolicyRuntimeContract,
  type AccessClass,
  type ArtifactState,
  type CapabilityAvailability,
  type CapabilityDecision,
  type CapabilityEvaluationContext,
  type CapabilityIdentity,
  type ClientLocalState,
  type DataClassId,
  type DenyReason,
  type InputType,
  type LearningMode,
  type ProviderId,
  type ProviderSelection,
  type Workflow,
} from "@laita/contracts";
import {
  isApplicationConfiguration,
  type ApplicationConfiguration,
} from "@laita/contracts/server";

export interface CapabilityRequestContext {
  readonly accessClass: AccessClass;
  readonly courseRef: string;
  readonly moduleRef: string;
  readonly workflow: Workflow;
  readonly learningMode: LearningMode;
  readonly inputType: InputType;
  readonly dataClass: DataClassId;
  readonly artifactState: ArtifactState;
  readonly activeAssessment: boolean;
}

export interface ProviderControlState {
  readonly featureEnabled: boolean;
  readonly scheduleOpen: boolean;
  readonly withinBudget: boolean;
  readonly quotaAvailable: boolean;
  readonly runtime?: {
    readonly selectedModel: string;
    readonly models: readonly {
      readonly model: string;
      readonly state: ClientLocalState;
    }[];
  };
}

export interface CapabilityControlState {
  readonly emergencyStop: boolean;
  readonly local: ProviderControlState & { readonly state: ClientLocalState };
  readonly openai: ProviderControlState & {
    readonly state: "READY" | "UNAVAILABLE";
  };
}

export interface CapabilityEvaluator {
  readonly identity: CapabilityIdentity;
  availability(
    context: CapabilityRequestContext,
    controls: CapabilityControlState,
  ): CapabilityAvailability;
  authorizeSelection(
    context: CapabilityRequestContext,
    controls: CapabilityControlState,
    selection: ProviderSelection,
    presentedIdentity?: unknown,
  ): CapabilityDecision;
}

export function createDemoCapabilityContext(
  accessClass: AccessClass,
): CapabilityRequestContext {
  const source = reviewedPolicyRuntimeContract.demoEvaluationContext;
  return {
    accessClass,
    courseRef: source.courseRef,
    moduleRef: source.moduleRef,
    workflow: source.workflow,
    learningMode: source.learningMode,
    inputType: source.inputType,
    dataClass: source.dataClass,
    artifactState: source.artifactState,
    activeAssessment: source.activeAssessment,
  };
}

const recheckOn = [
  "INPUT_CHANGE",
  "ARTIFACT_CHANGE",
  "COURSE_OR_MODULE_CHANGE",
  "WORKFLOW_OR_MODE_CHANGE",
  "PROVIDER_OR_MODEL_CHANGE",
  "SCHEDULE_OR_FEATURE_CHANGE",
  "BUDGET_OR_QUOTA_CHANGE",
  "ASSESSMENT_STATE_CHANGE",
  "POLICY_VERSION_CHANGE",
  "DECISION_EXPIRY",
] as const;
const availabilityRecheckOn = [
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
] as const;

const sha256 = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

function exactObject(value: unknown, keys: readonly string[]): value is object {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      Object.keys(value).every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          keys.includes(key) &&
          descriptor !== undefined &&
          Object.hasOwn(descriptor, "value")
        );
      })
    );
  } catch {
    return false;
  }
}

function validContextShape(value: unknown): value is CapabilityRequestContext {
  return exactObject(value, [
    "accessClass",
    "courseRef",
    "moduleRef",
    "workflow",
    "learningMode",
    "inputType",
    "dataClass",
    "artifactState",
    "activeAssessment",
  ]);
}

function validControlShape(value: unknown): value is CapabilityControlState {
  try {
    if (!exactObject(value, ["emergencyStop", "local", "openai"])) return false;
    const candidate = value as CapabilityControlState;
    const providerKeys = [
      "featureEnabled",
      "scheduleOpen",
      "withinBudget",
      "quotaAvailable",
      "state",
    ];
    const validProvider = (
      provider: ProviderControlState & { readonly state: string },
    ) => {
      if (
        !provider ||
        typeof provider !== "object" ||
        !providerKeys.every((key) => Object.hasOwn(provider, key)) ||
        !Object.keys(provider).every((key) =>
          [...providerKeys, "runtime"].includes(key),
        )
      )
        return false;
      if (provider.runtime === undefined) return true;
      return (
        exactObject(provider.runtime, ["selectedModel", "models"]) &&
        typeof provider.runtime.selectedModel === "string" &&
        provider.runtime.selectedModel.length > 0 &&
        Array.isArray(provider.runtime.models) &&
        provider.runtime.models.length > 0 &&
        provider.runtime.models.length <= 8 &&
        provider.runtime.models.every(
          (entry) =>
            entry !== null &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            Object.keys(entry).length === 2 &&
            Object.keys(entry).every((key) =>
              ["model", "state"].includes(key),
            ) &&
            typeof entry.model === "string" &&
            entry.model.length > 0 &&
            ["READY", "LOADING", "SWITCHING", "BUSY", "UNAVAILABLE"].includes(
              entry.state,
            ),
        ) &&
        new Set(provider.runtime.models.map(({ model }) => model)).size ===
          provider.runtime.models.length &&
        provider.runtime.models.some(
          ({ model }) => model === provider.runtime!.selectedModel,
        )
      );
    };
    return (
      typeof candidate.emergencyStop === "boolean" &&
      validProvider(candidate.local) &&
      validProvider(candidate.openai) &&
      [
        candidate.local.featureEnabled,
        candidate.local.scheduleOpen,
        candidate.local.withinBudget,
        candidate.local.quotaAvailable,
        candidate.openai.featureEnabled,
        candidate.openai.scheduleOpen,
        candidate.openai.withinBudget,
        candidate.openai.quotaAvailable,
      ].every((entry) => typeof entry === "boolean") &&
      ["READY", "LOADING", "SWITCHING", "BUSY", "UNAVAILABLE"].includes(
        candidate.local.state,
      ) &&
      ["READY", "UNAVAILABLE"].includes(candidate.openai.state)
    );
  } catch {
    return false;
  }
}

function validSelectionShape(value: unknown): value is ProviderSelection {
  try {
    if (!exactObject(value, ["provider", "model"])) return false;
    const candidate = value as ProviderSelection;
    return (
      ["LOCAL", "OPENAI"].includes(candidate.provider) &&
      typeof candidate.model === "string" &&
      candidate.model.length > 0
    );
  } catch {
    return false;
  }
}

function equalIdentity(
  actual: CapabilityIdentity,
  presented: unknown,
): boolean {
  try {
    return canonicalJson(actual) === canonicalJson(presented);
  } catch {
    return false;
  }
}

function denial(
  context: CapabilityEvaluationContext | undefined,
  provider: ProviderId,
  model: string,
  reason: DenyReason,
): CapabilityDecision {
  const identity =
    context?.policyVersion === "demo-policy.v4"
      ? reviewedPolicyRuntimeContract.successor.identity
      : reviewedPolicyRuntimeContract.demoIdentity;
  const digest = sha256(context ?? "invalid-context");
  const classification = context
    ? reviewedPolicyRuntimeContract.dataClassificationPolicy.classes.find(
        (candidate) => candidate.id === context.dataClass,
      )
    : undefined;
  return {
    contractVersion: "capability-decision.v1",
    decisionRef: `decision-${digest.slice(7, 31)}`,
    evaluatedContextDigest: digest,
    policyVersion: identity.policyVersion,
    classificationVersion: identity.classificationVersion,
    retentionPolicyVersion: identity.retentionPolicyVersion,
    gradingBoundaryVersion: identity.gradingBoundaryVersion,
    targetProvider: provider,
    targetModel: model,
    allowed: false,
    reasonCodes: [reason],
    constraints: {
      localOnly: classification?.providerProcessing === "LOCAL_ONLY",
      noFallback: true,
      minimizedContentRequired: provider === "OPENAI",
    },
    recheckOn,
  };
}

function evaluate(input: unknown, successor = false): CapabilityDecision {
  if (!isCapabilityEvaluationContext(input))
    return denial(undefined, "LOCAL", "invalid-model", "CONTEXT_NOT_ALLOWED");
  const context = input;

  const identity = successor
    ? reviewedPolicyRuntimeContract.successor.identity
    : reviewedPolicyRuntimeContract.demoIdentity;
  const policy = successor
    ? reviewedPolicyRuntimeContract.successor.providerPolicy
    : reviewedPolicyRuntimeContract.demoProviderEligibilityPolicy;
  const classification =
    reviewedPolicyRuntimeContract.dataClassificationPolicy.classes.find(
      (candidate) => candidate.id === context.dataClass,
    );
  const cloud = context.targetProvider === "OPENAI";
  const classRules = policy.allowRules.filter(
    (rule) =>
      rule.provider === context.targetProvider &&
      (rule.dataClasses as readonly string[]).includes(context.dataClass),
  );
  const modelRules = classRules.filter((rule) =>
    (rule.models as readonly string[]).includes(context.targetModel),
  );
  const contextRules = modelRules.filter(
    (rule) =>
      (rule.accessClasses as readonly string[]).includes(context.accessClass) &&
      (rule.workflows as readonly string[]).includes(context.workflow) &&
      (rule.learningModes as readonly string[]).includes(
        context.learningMode,
      ) &&
      (rule.inputTypes as readonly string[]).includes(context.inputType) &&
      (rule.artifactStates as readonly string[]).includes(
        context.artifactState,
      ),
  );
  const matchingRule = contextRules.find(
    (rule) =>
      (rule.activeAssessment as string) === "ALLOW" ||
      !context.activeAssessment,
  );
  const demoScope = reviewedPolicyRuntimeContract.demoEvaluationContext;
  const scopeMismatch =
    context.courseRef !== demoScope.courseRef ||
    context.moduleRef !== demoScope.moduleRef;
  const contextNotAllowed =
    scopeMismatch ||
    classRules.length === 0 ||
    (modelRules.length > 0 && contextRules.length === 0);
  const denials: Readonly<Record<DenyReason, boolean>> = {
    POLICY_VERSION_MISMATCH:
      context.policyVersion !== identity.policyVersion ||
      context.classificationVersion !== identity.classificationVersion ||
      context.retentionPolicyVersion !== identity.retentionPolicyVersion ||
      context.gradingBoundaryVersion !== identity.gradingBoundaryVersion,
    CLIENT_POLICY_OVERRIDE: context.clientPolicyOverrideRequested,
    UNKNOWN_DATA_CLASS: classification === undefined,
    PROVIDER_PROCESSING_PROHIBITED:
      classification?.providerProcessing === "PROHIBITED",
    CLOUD_NOT_EXPLICITLY_ALLOWED: cloud && contextNotAllowed,
    LOCAL_ONLY_DATA:
      cloud &&
      classification?.providerProcessing === "LOCAL_ONLY" &&
      !(
        successor &&
        context.accessClass === "INSTRUCTOR" &&
        context.dataClass === "IDENTITY_MINIMIZED_USER_TEXT" &&
        matchingRule &&
        !scopeMismatch
      ),
    PROVIDER_DISABLED: !context.providerFeatureEnabled,
    SCHEDULE_CLOSED: !context.scheduleOpen,
    ACTIVE_ASSESSMENT:
      context.activeAssessment && contextRules.length > 0 && !matchingRule,
    OVER_BUDGET: !context.withinBudget,
    QUOTA_UNAVAILABLE: !context.quotaAvailable,
    MODEL_NOT_ALLOWED: classRules.length > 0 && modelRules.length === 0,
    CONTEXT_NOT_ALLOWED: !cloud && contextNotAllowed,
  };
  const precedence = policy.denyReasonPrecedence;
  const keys = Object.keys(denials);
  if (
    precedence.length !== keys.length ||
    new Set(precedence).size !== precedence.length ||
    !precedence.every((reason) => Object.hasOwn(denials, reason))
  )
    return denial(
      context,
      context.targetProvider,
      context.targetModel,
      "CONTEXT_NOT_ALLOWED",
    );
  const reason = precedence.find((candidate) => denials[candidate]);
  const digest = sha256(context);
  const decision: CapabilityDecision =
    reason || !matchingRule
      ? denial(
          context,
          context.targetProvider,
          context.targetModel,
          reason ?? "CONTEXT_NOT_ALLOWED",
        )
      : {
          contractVersion: "capability-decision.v1",
          decisionRef: `decision-${digest.slice(7, 31)}`,
          evaluatedContextDigest: digest,
          policyVersion: identity.policyVersion,
          classificationVersion: identity.classificationVersion,
          retentionPolicyVersion: identity.retentionPolicyVersion,
          gradingBoundaryVersion: identity.gradingBoundaryVersion,
          targetProvider: context.targetProvider,
          targetModel: context.targetModel,
          allowed: true,
          reasonCodes: ["EXPLICIT_ALLOW"],
          constraints: {
            localOnly: classification?.providerProcessing === "LOCAL_ONLY",
            noFallback: true,
            minimizedContentRequired: cloud,
          },
          recheckOn,
        };
  return isCapabilityDecision(decision)
    ? decision
    : denial(
        context,
        context.targetProvider,
        context.targetModel,
        "CONTEXT_NOT_ALLOWED",
      );
}

function configurationProjection(configuration: ApplicationConfiguration) {
  return {
    contractVersion: configuration.contractVersion,
    provenance: configuration.provenance,
    mode: configuration.mode,
    providers: {
      local: configuration.providers.local,
      openai: {
        provider: configuration.providers.openai.provider,
        model: configuration.providers.openai.model,
      },
    },
    features: configuration.features,
  };
}

export function createCapabilityEvaluator(
  configurationInput: unknown,
): CapabilityEvaluator | null {
  try {
    if (!isApplicationConfiguration(configurationInput)) return null;
    const configuration = structuredClone(configurationInput);
    const successor =
      configuration.provenance.demoProfileVersion === "demo-profile.v4";
    const policyIdentity = successor
      ? reviewedPolicyRuntimeContract.successor.identity
      : reviewedPolicyRuntimeContract.demoIdentity;
    if (
      configuration.provenance.demoProfileVersion !==
        policyIdentity.profileVersion ||
      configuration.provenance.policyVersion !== policyIdentity.policyVersion ||
      policyIdentity.fallback !== "PROHIBITED"
    )
      return null;
    const identity: CapabilityIdentity = Object.freeze({
      policy: Object.freeze({
        runtimeDigest: reviewedPolicyRuntimeContract.provenance.sourceDigest,
        profileVersion: policyIdentity.profileVersion,
        policyVersion: policyIdentity.policyVersion,
        providerPolicyVersion: policyIdentity.providerPolicyVersion,
        classificationVersion: policyIdentity.classificationVersion,
        retentionPolicyVersion: policyIdentity.retentionPolicyVersion,
        gradingBoundaryVersion: policyIdentity.gradingBoundaryVersion,
      }),
      configuration: Object.freeze({
        version: configuration.contractVersion,
        digest: sha256(configurationProjection(configuration)),
      }),
    });

    function evaluationContext(
      context: CapabilityRequestContext,
      controls: CapabilityControlState,
      selection: ProviderSelection,
      clientPolicyOverrideRequested = false,
    ): CapabilityEvaluationContext | undefined {
      try {
        const state =
          selection.provider === "LOCAL" ? controls.local : controls.openai;
        const value: CapabilityEvaluationContext = {
          contractVersion: "capability-evaluation.v1",
          policyVersion: policyIdentity.policyVersion,
          classificationVersion: policyIdentity.classificationVersion,
          retentionPolicyVersion: policyIdentity.retentionPolicyVersion,
          gradingBoundaryVersion: policyIdentity.gradingBoundaryVersion,
          accessClass: context.accessClass,
          courseRef: context.courseRef,
          moduleRef: context.moduleRef,
          workflow: context.workflow,
          learningMode: context.learningMode,
          inputType: context.inputType,
          dataClass: context.dataClass,
          artifactState: context.artifactState,
          targetProvider: selection.provider,
          targetModel: selection.model,
          scheduleOpen: state.scheduleOpen,
          providerFeatureEnabled:
            (selection.provider !== "OPENAI" || !controls.emergencyStop) &&
            state.featureEnabled &&
            configuration.features[
              selection.provider === "LOCAL" ? "local" : "openai"
            ],
          withinBudget: state.withinBudget,
          quotaAvailable: state.quotaAvailable,
          activeAssessment: context.activeAssessment,
          clientPolicyOverrideRequested,
        };
        return isCapabilityEvaluationContext(value) ? value : undefined;
      } catch {
        return undefined;
      }
    }

    function authorizeSelection(
      context: CapabilityRequestContext,
      controls: CapabilityControlState,
      selection: ProviderSelection,
      presentedIdentity?: unknown,
    ): CapabilityDecision {
      if (
        !validContextShape(context) ||
        !validControlShape(controls) ||
        !validSelectionShape(selection)
      )
        return denial(
          undefined,
          "LOCAL",
          "invalid-model",
          "CLIENT_POLICY_OVERRIDE",
        );
      const provider = selection.provider;
      const model = selection.model;
      if (presentedIdentity === undefined)
        return denial(undefined, provider, model, "POLICY_VERSION_MISMATCH");
      if (!equalIdentity(identity, presentedIdentity)) {
        let policyMismatch = true;
        try {
          const policy = (presentedIdentity as { policy?: unknown } | null)
            ?.policy;
          policyMismatch =
            !policy || canonicalJson(policy) !== canonicalJson(identity.policy);
        } catch {
          policyMismatch = true;
        }
        return denial(
          undefined,
          provider,
          model,
          policyMismatch ? "POLICY_VERSION_MISMATCH" : "CLIENT_POLICY_OVERRIDE",
        );
      }
      const built = evaluationContext(context, controls, { provider, model });
      if (!built)
        return denial(undefined, provider, model, "CONTEXT_NOT_ALLOWED");
      const decision = evaluate(built, successor);
      const state = provider === "LOCAL" ? controls.local : controls.openai;
      const healthReady =
        state.runtime?.models.find((entry) => entry.model === model)?.state ===
          "READY" ||
        (state.runtime === undefined && state.state === "READY");
      return decision.allowed && !healthReady
        ? denial(built, provider, model, "PROVIDER_DISABLED")
        : decision;
    }

    function availability(
      context: CapabilityRequestContext,
      controls: CapabilityControlState,
    ): CapabilityAvailability {
      if (!validContextShape(context) || !validControlShape(controls)) {
        return {
          contractVersion: "capability-availability.v1",
          decisionRef: `decision-${sha256("invalid-context").slice(7, 31)}`,
          identity,
          providers: [],
          modes: [],
          guidance: "NO_PROVIDER_AVAILABLE",
          recheckOn: availabilityRecheckOn,
        };
      }
      try {
        const localModels = configuration.providers.local.candidates
          .filter((model) => {
            const runtime = controls.local.runtime;
            if (!runtime) return true;
            const state = runtime.models.find(
              (entry) => entry.model === model,
            )?.state;
            return (
              state === "READY" ||
              (model === runtime.selectedModel &&
                ["LOADING", "SWITCHING", "BUSY"].includes(state ?? ""))
            );
          })
          .filter((model) =>
            reviewedPolicyRuntimeContract.demoModels.local.includes(model),
          )
          .filter((model) =>
            (() => {
              const built = evaluationContext(context, controls, {
                provider: "LOCAL",
                model,
              });
              return built ? evaluate(built, successor).allowed : false;
            })(),
          );
        const openaiModels = [configuration.providers.openai.model]
          .filter((model) =>
            reviewedPolicyRuntimeContract.demoModels.openai.includes(model),
          )
          .filter(
            (model) =>
              controls.openai.runtime?.models.find(
                (entry) => entry.model === model,
              )?.state === "READY" || controls.openai.runtime === undefined,
          )
          .filter(
            (model) =>
              controls.openai.state === "READY" &&
              (() => {
                const built = evaluationContext(context, controls, {
                  provider: "OPENAI",
                  model,
                });
                return built ? evaluate(built, successor).allowed : false;
              })(),
          );
        const providers: CapabilityAvailability["providers"] = [
          ...(localModels.length
            ? [
                {
                  id: "LOCAL" as const,
                  label: "Local" as const,
                  state: controls.local.state,
                  models: localModels.map((model) => ({
                    id: model,
                    label: model,
                  })),
                },
              ]
            : []),
          ...(openaiModels.length
            ? [
                {
                  id: "OPENAI" as const,
                  label: "OpenAI" as const,
                  state: "READY" as const,
                  models: openaiModels.map((model) => ({
                    id: model,
                    label: model,
                  })),
                },
              ]
            : []),
        ];
        const localReady =
          localModels.length > 0 && controls.local.state === "READY";
        const openaiReady = openaiModels.length > 0;
        const modes: CapabilityAvailability["modes"] = [
          ...(localReady
            ? [
                {
                  id: "LOCAL" as const,
                  label: "Local" as const,
                  providers: ["LOCAL" as const],
                },
              ]
            : []),
          ...(openaiReady
            ? [
                {
                  id: "OPENAI" as const,
                  label: "OpenAI" as const,
                  providers: ["OPENAI" as const],
                },
              ]
            : []),
          ...(localReady && openaiReady && configuration.features.compare
            ? [
                {
                  id: "COMPARE" as const,
                  label: "Compare" as const,
                  providers: ["LOCAL" as const, "OPENAI" as const],
                },
              ]
            : []),
        ];
        const snapshot = { identity, providers, modes, context };
        return {
          contractVersion: "capability-availability.v1",
          decisionRef: `decision-${sha256(snapshot).slice(7, 31)}`,
          identity,
          providers,
          modes,
          guidance:
            modes.length > 0
              ? "SELECT_AVAILABLE_MODE"
              : localModels.length > 0
                ? "LOCAL_PROGRESS"
                : "NO_PROVIDER_AVAILABLE",
          recheckOn: availabilityRecheckOn,
        };
      } catch {
        return {
          contractVersion: "capability-availability.v1",
          decisionRef: `decision-${sha256("invalid-context").slice(7, 31)}`,
          identity,
          providers: [],
          modes: [],
          guidance: "NO_PROVIDER_AVAILABLE",
          recheckOn: availabilityRecheckOn,
        };
      }
    }

    return Object.freeze({ identity, availability, authorizeSelection });
  } catch {
    return null;
  }
}

export {
  createInstructorPolicyService,
  defaultInstructorPolicy,
  successorInstructorPolicy,
  instructorPolicyDigest,
  isSafeInstructorPolicy,
  scheduleIsOpen,
} from "./instructor-controls.ts";
export type {
  PolicyStateRepository,
  PolicyWriteResult,
} from "./instructor-controls.ts";

export {
  applyUsageControls,
  createProviderUsageService,
  defaultProviderUsagePolicy,
  isSafeProviderUsagePolicy,
} from "./usage-controls.ts";
export type {
  UsageCapabilityReader,
  UsageCapabilitySnapshot,
  UsageServiceResult,
} from "./usage-controls.ts";
