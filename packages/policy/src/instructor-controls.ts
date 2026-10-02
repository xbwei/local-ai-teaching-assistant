import { createHash } from "node:crypto";
import {
  approvedInstructorLocalModels,
  approvedInstructorOpenAIModels,
  canonicalJson,
  isInstructorPolicyDocument,
  reviewedPolicyRuntimeContract,
  type CapabilityAvailability,
  type InstructorPolicyDocument,
  type InstructorPolicyHistoryEntry,
  type InstructorPolicyPreview,
  type InstructorPolicyState,
  type ProviderSelection,
} from "@laita/contracts";
import type {
  CapabilityControlState,
  CapabilityEvaluator,
  CapabilityRequestContext,
} from "./index.ts";

export type PolicyWriteResult =
  | { readonly ok: true; readonly value: InstructorPolicyState }
  | {
      readonly ok: false;
      readonly code: "CONFLICT" | "NOT_FOUND" | "SERVICE_UNAVAILABLE";
    };

export interface PolicyStateRepository {
  read(): PolicyWriteResult;
  history():
    | {
        readonly ok: true;
        readonly value: readonly InstructorPolicyHistoryEntry[];
      }
    | { readonly ok: false; readonly code: "SERVICE_UNAVAILABLE" };
  activate(
    expectedVersion: number,
    policy: InstructorPolicyDocument,
    actorRole: "ADMIN" | "INSTRUCTOR",
    change: InstructorPolicyHistoryEntry["change"],
    timestamp: string,
  ): PolicyWriteResult;
  rollback(
    expectedVersion: number,
    actorRole: "ADMIN" | "INSTRUCTOR",
    timestamp: string,
  ): PolicyWriteResult;
}

export const defaultInstructorPolicy: InstructorPolicyDocument = {
  contractVersion: "instructor-policy.v1",
  cloudEnabled: false,
  emergencyCloudDisabled: false,
  schedule: null,
  eligibility: {
    courseRefs: ["course-synthetic-demo"],
    accessClasses: ["INSTRUCTOR"],
    workflows: ["COURSE_QA", "CODING_COACH"],
    learningModes: ["DIRECT_EXPLANATION"],
    inputTypes: ["TEXT"],
    dataClasses: ["IDENTITY_FREE_USER_TEXT"],
  },
  models: {
    local: [...approvedInstructorLocalModels],
    activeLocal: "gemma4:12b-mlx",
    openai: [...approvedInstructorOpenAIModels],
  },
  comparison: {
    enabled: true,
    courseRef: "course-synthetic-demo",
    moduleRef: "module-fixed-comparison",
    workflow: "COURSE_QA",
    learningMode: "DIRECT_EXPLANATION",
    inputType: "TEXT",
    dataClass: "IDENTITY_FREE_USER_TEXT",
    maxInputCharacters: 8192,
  },
};

export const successorInstructorPolicy: InstructorPolicyDocument = {
  ...defaultInstructorPolicy,
  eligibility: {
    ...defaultInstructorPolicy.eligibility,
    dataClasses: ["IDENTITY_FREE_USER_TEXT", "IDENTITY_MINIMIZED_USER_TEXT"],
  },
};

export const instructorPolicyDigest = (
  policy: InstructorPolicyDocument,
): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(canonicalJson(policy)).digest("hex")}`;

function offsetAt(timeZone: string, instant: Date): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
      year: "numeric",
    }).formatToParts(instant);
    const name = parts.find((part) => part.type === "timeZoneName")?.value;
    if (!name) return null;
    if (name === "GMT") return "+00:00";
    const match = name.match(/^GMT([+-])(\d{2}):(\d{2})$/u);
    return match ? `${match[1]}${match[2]}:${match[3]}` : null;
  } catch {
    return null;
  }
}

function suppliedOffset(value: string): string | null {
  if (value.endsWith("Z")) return "+00:00";
  return value.match(/([+-]\d{2}:\d{2})$/u)?.[1] ?? null;
}

export function isSafeInstructorPolicy(
  value: unknown,
): value is InstructorPolicyDocument {
  try {
    if (!isInstructorPolicyDocument(value)) return false;
    const policy = value;
    if (!policy.models.local.includes(policy.models.activeLocal)) return false;
    const scope = reviewedPolicyRuntimeContract.demoEvaluationContext;
    if (
      !policy.eligibility.courseRefs.every(
        (courseRef) => courseRef === scope.courseRef,
      ) ||
      policy.comparison.courseRef !== scope.courseRef ||
      policy.comparison.moduleRef !== scope.moduleRef ||
      !policy.eligibility.courseRefs.includes(policy.comparison.courseRef) ||
      !policy.eligibility.workflows.includes(policy.comparison.workflow) ||
      !policy.eligibility.learningModes.includes(
        policy.comparison.learningMode,
      ) ||
      !policy.eligibility.inputTypes.includes(policy.comparison.inputType) ||
      !policy.eligibility.dataClasses.includes(policy.comparison.dataClass)
    )
      return false;
    if (policy.cloudEnabled && policy.models.openai.length === 0) return false;
    if (policy.schedule) {
      const start = new Date(policy.schedule.startsAt);
      const end = new Date(policy.schedule.endsAt);
      if (
        !Number.isFinite(start.valueOf()) ||
        !Number.isFinite(end.valueOf()) ||
        start >= end ||
        offsetAt(policy.schedule.timeZone, start) !==
          suppliedOffset(policy.schedule.startsAt) ||
        offsetAt(policy.schedule.timeZone, end) !==
          suppliedOffset(policy.schedule.endsAt)
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function scheduleIsOpen(
  policy: InstructorPolicyDocument,
  now: Date,
): boolean {
  if (!policy.schedule) return true;
  const current = now.valueOf();
  return (
    current >= new Date(policy.schedule.startsAt).valueOf() &&
    current < new Date(policy.schedule.endsAt).valueOf()
  );
}

function contextEligible(
  policy: InstructorPolicyDocument,
  context: CapabilityRequestContext,
): boolean {
  return (
    policy.eligibility.courseRefs.includes(context.courseRef) &&
    policy.eligibility.accessClasses.includes(context.accessClass) &&
    policy.eligibility.workflows.includes(context.workflow) &&
    policy.eligibility.learningModes.includes(context.learningMode) &&
    policy.eligibility.inputTypes.includes(context.inputType) &&
    policy.eligibility.dataClasses.includes(context.dataClass)
  );
}

function controlsFor(
  policy: InstructorPolicyDocument,
  now: Date,
  health?: Partial<CapabilityControlState>,
): CapabilityControlState {
  return {
    emergencyStop: policy.emergencyCloudDisabled,
    local: {
      featureEnabled: health?.local?.featureEnabled ?? true,
      scheduleOpen: true,
      withinBudget: health?.local?.withinBudget ?? true,
      quotaAvailable: health?.local?.quotaAvailable ?? true,
      state: health?.local?.state ?? "READY",
      ...(health?.local?.runtime ? { runtime: health.local.runtime } : {}),
    },
    openai: {
      featureEnabled:
        policy.cloudEnabled && (health?.openai?.featureEnabled ?? true),
      scheduleOpen: scheduleIsOpen(policy, now),
      withinBudget: health?.openai?.withinBudget ?? true,
      quotaAvailable: health?.openai?.quotaAvailable ?? true,
      state: health?.openai?.state ?? "READY",
      ...(health?.openai?.runtime ? { runtime: health.openai.runtime } : {}),
    },
  };
}

function restrictedAvailability(
  evaluator: CapabilityEvaluator,
  policy: InstructorPolicyDocument,
  context: CapabilityRequestContext,
  now: Date,
  health?: Partial<CapabilityControlState>,
): CapabilityAvailability {
  const controls = controlsFor(policy, now, health);
  const base = evaluator.availability(
    context,
    context.dataClass === "IDENTITY_MINIMIZED_USER_TEXT"
      ? {
          ...controls,
          local: {
            ...controls.local,
            scheduleOpen: scheduleIsOpen(policy, now),
          },
        }
      : controls,
  );
  if (!contextEligible(policy, context))
    return Object.freeze({
      ...base,
      providers: Object.freeze([]),
      modes: Object.freeze([]),
      guidance: "NO_PROVIDER_AVAILABLE" as const,
    });
  const comparisonContext =
    policy.comparison.enabled &&
    context.accessClass === "INSTRUCTOR" &&
    context.courseRef === policy.comparison.courseRef &&
    context.moduleRef === policy.comparison.moduleRef &&
    policy.eligibility.workflows.includes(context.workflow) &&
    context.learningMode === policy.comparison.learningMode &&
    context.inputType === policy.comparison.inputType &&
    policy.eligibility.dataClasses.includes(context.dataClass);
  const providers = base.providers
    .map((provider) => ({
      ...provider,
      models: provider.models.filter((model) =>
        provider.id === "LOCAL"
          ? policy.models.local.includes(model.id)
          : provider.id === "OPENAI"
            ? comparisonContext && policy.models.openai.includes(model.id)
            : false,
      ),
    }))
    .filter((provider) => provider.models.length > 0);
  const present = new Set(providers.map((provider) => provider.id));
  const modes = base.modes.filter(
    (mode) =>
      mode.providers.every((provider) => present.has(provider)) &&
      (mode.id !== "COMPARE" || comparisonContext),
  );
  return Object.freeze({
    ...base,
    providers: Object.freeze(providers),
    modes: Object.freeze(modes),
    guidance:
      modes.length > 0 ? "SELECT_AVAILABLE_MODE" : "NO_PROVIDER_AVAILABLE",
  });
}

export function createInstructorPolicyService(
  repository: PolicyStateRepository,
  evaluator: CapabilityEvaluator,
  now: () => Date = () => new Date(),
) {
  function currentState(): PolicyWriteResult {
    const state = repository.read();
    return state.ok && !isSafeInstructorPolicy(state.value.policy)
      ? { ok: false, code: "SERVICE_UNAVAILABLE" }
      : state;
  }
  if (!currentState().ok)
    throw new Error("Initial instructor policy state is unavailable or unsafe");
  return Object.freeze({
    readState: currentState,
    history: () => repository.history(),
    capability(
      context: CapabilityRequestContext,
      health?: Partial<CapabilityControlState>,
    ) {
      const state = currentState();
      if (!state.ok) return state;
      return {
        ok: true as const,
        value: restrictedAvailability(
          evaluator,
          state.value.policy,
          context,
          now(),
          health,
        ),
      };
    },
    authorizeSelection(
      context: CapabilityRequestContext,
      selection: ProviderSelection,
      presentedIdentity: unknown,
      health?: Partial<CapabilityControlState>,
    ) {
      const state = currentState();
      if (!state.ok) return state;
      const policy = state.value.policy;
      const instant = now();
      const availability = restrictedAvailability(
        evaluator,
        policy,
        context,
        instant,
        health,
      );
      const selectionIsAvailable = availability.providers.some(
        (provider) =>
          provider.id === selection.provider &&
          provider.models.some((model) => model.id === selection.model),
      );
      return {
        ok: true as const,
        value: evaluator.authorizeSelection(
          context,
          controlsFor(policy, instant, health),
          selection,
          selectionIsAvailable ? presentedIdentity : undefined,
        ),
      };
    },
    preview(
      expectedVersion: number,
      policy: unknown,
      health?: Partial<CapabilityControlState>,
    ):
      | { readonly ok: true; readonly value: InstructorPolicyPreview }
      | {
          readonly ok: false;
          readonly code: "CONFLICT" | "INVALID_POLICY" | "SERVICE_UNAVAILABLE";
        } {
      const current = currentState();
      if (!current.ok)
        return {
          ok: false,
          code:
            current.code === "CONFLICT"
              ? ("CONFLICT" as const)
              : ("SERVICE_UNAVAILABLE" as const),
        };
      if (current.value.version !== expectedVersion)
        return { ok: false, code: "CONFLICT" };
      if (!isSafeInstructorPolicy(policy))
        return { ok: false, code: "INVALID_POLICY" };
      const instant = now();
      const context: CapabilityRequestContext = {
        accessClass: "INSTRUCTOR",
        courseRef: policy.comparison.courseRef,
        moduleRef: policy.comparison.moduleRef,
        workflow: policy.comparison.workflow,
        learningMode: policy.comparison.learningMode,
        inputType: policy.comparison.inputType,
        dataClass: policy.comparison.dataClass,
        artifactState: "NONE",
        activeAssessment: false,
      };
      return {
        ok: true,
        value: Object.freeze({
          contractVersion: "instructor-policy-preview.v1",
          basedOnVersion: expectedVersion,
          policyDigest: instructorPolicyDigest(policy),
          scheduleOpen: scheduleIsOpen(policy, instant),
          capability: restrictedAvailability(
            evaluator,
            policy,
            context,
            instant,
            health,
          ),
        }),
      };
    },
    activate(
      expectedVersion: number,
      previewDigest: unknown,
      policy: unknown,
      actorRole: "ADMIN" | "INSTRUCTOR",
    ) {
      if (!isSafeInstructorPolicy(policy))
        return { ok: false as const, code: "INVALID_POLICY" as const };
      if (previewDigest !== instructorPolicyDigest(policy))
        return { ok: false as const, code: "INVALID_POLICY" as const };
      return repository.activate(
        expectedVersion,
        policy,
        actorRole,
        "ACTIVATE",
        now().toISOString(),
      );
    },
    emergencyDisable(
      expectedVersion: number,
      actorRole: "ADMIN" | "INSTRUCTOR",
    ) {
      const current = currentState();
      if (!current.ok) return current;
      if (current.value.version !== expectedVersion)
        return { ok: false as const, code: "CONFLICT" as const };
      return repository.activate(
        expectedVersion,
        { ...current.value.policy, emergencyCloudDisabled: true },
        actorRole,
        "EMERGENCY_CLOUD_DISABLE",
        now().toISOString(),
      );
    },
    rollback(expectedVersion: number, actorRole: "ADMIN" | "INSTRUCTOR") {
      return repository.rollback(
        expectedVersion,
        actorRole,
        now().toISOString(),
      );
    },
  });
}
