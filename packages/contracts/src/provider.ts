import { Ajv2020 } from "ajv/dist/2020.js";

import {
  reviewedPolicyRuntimeContract,
  type CapabilityDecision,
  type VersionIdentifier,
} from "./policy-contract.generated.ts";

export { reviewedPolicyRuntimeContract };

export type ProviderId = "LOCAL" | "OPENAI";

export interface ProviderSelection {
  readonly provider: ProviderId;
  readonly model: string;
}

export interface ModelIdentity {
  readonly id: string;
  readonly version?: string;
  readonly digest?: `sha256:${string}`;
}

export interface ProviderIdentity {
  readonly selected: ProviderSelection;
  readonly actual: {
    readonly provider: ProviderId;
    readonly model: ModelIdentity;
  };
}

type AllowedCapabilityDecision = Extract<CapabilityDecision, { allowed: true }>;

export interface ProviderPolicyDecision<
  Decision extends CapabilityDecision = CapabilityDecision,
> {
  readonly contractVersion: "provider-policy-decision.v1";
  readonly providerPolicyVersion: VersionIdentifier;
  readonly capabilityDecision: Decision;
}

export type AllowedProviderPolicyDecision =
  ProviderPolicyDecision<AllowedCapabilityDecision>;

export interface GenerationConfiguration {
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stop?: readonly string[];
}

export interface ProviderRequest {
  readonly contractVersion: "provider-request.v1";
  readonly runRef: `run-${string}`;
  readonly attempt:
    | {
        readonly kind: "INITIAL";
        readonly attemptRef: `attempt-${string}`;
        readonly ordinal: 1;
      }
    | {
        readonly kind: "EXPLICIT_PROVIDER_RERUN";
        readonly attemptRef: `attempt-${string}`;
        readonly ordinal: 1;
        readonly parentRun: {
          readonly runRef: `run-${string}`;
          readonly selection: ProviderSelection;
        };
      }
    | {
        readonly kind: "SAME_PROVIDER_RETRY";
        readonly attemptRef: `attempt-${string}`;
        readonly ordinal: number;
        readonly previousAttemptRef: `attempt-${string}`;
        readonly previousSelection: ProviderSelection;
      };
  readonly selection: ProviderSelection;
  readonly input: {
    readonly messages: readonly {
      readonly role: "SYSTEM" | "USER" | "ASSISTANT";
      readonly content: string;
    }[];
    readonly evidenceRefs?: readonly string[];
  };
  readonly generation: GenerationConfiguration;
  readonly timeoutMs: number;
  readonly cancellationRef: `cancellation-${string}`;
  readonly policy: AllowedProviderPolicyDecision;
  readonly configuration: {
    readonly reference: string;
    readonly version: VersionIdentifier;
    readonly digest: `sha256:${string}`;
  };
  readonly context?: {
    readonly workflowRef?: string;
    readonly modeRef?: string;
    readonly evidencePackRef?: string;
  };
}

export interface ProviderUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly providerReported: boolean;
}

export type LocalModelResidency =
  | "UNLOADED"
  | "LOADING"
  | "WARM"
  | "BUSY"
  | "UNAVAILABLE"
  | "SWITCHING"
  | "UNKNOWN";

export interface LocalResourceMetadata {
  readonly status: "MEASURED" | "NOT_AVAILABLE" | "INTERRUPTED";
  readonly processMemoryBytes?: number;
  readonly systemMemoryPressure?: "NORMAL" | "WARNING" | "CRITICAL";
  readonly swapDeltaBytes?: number;
}

export interface LocalProviderProvenance {
  readonly runtime: "OLLAMA";
  readonly configuredModel: string;
  readonly selectedModel: string;
  readonly runtimeModel: string;
  readonly modelDigest?: `sha256:${string}`;
  readonly loadState: "COLD" | "WARM" | "UNKNOWN";
  readonly residency: LocalModelResidency;
  readonly loadDurationMs?: number;
  readonly resources?: LocalResourceMetadata;
}

export interface OpenAIProviderProvenance {
  readonly runtime: "OPENAI_RESPONSES";
  readonly configuredModel: string;
  readonly selectedModel: string;
  readonly responseModel: string;
  readonly sdk: { readonly name: "openai"; readonly version: string };
  readonly store: false;
  readonly automaticRetries: 0;
  readonly sdkLogging: "OFF";
  readonly usageStatus: "REPORTED" | "NOT_REPORTED";
}

export interface ProviderSuccess {
  readonly contractVersion: "provider-result.v1";
  readonly status: "COMPLETED";
  readonly runRef: ProviderRequest["runRef"];
  readonly attemptRef: `attempt-${string}`;
  readonly identity: ProviderIdentity;
  readonly output: { readonly text: string };
  readonly usage?: ProviderUsage;
  readonly latency: {
    readonly totalMs: number;
    readonly firstOutputMs?: number;
  };
  readonly finishReason: "STOP" | "LENGTH";
  readonly policy: AllowedProviderPolicyDecision;
  readonly configuration: ProviderRequest["configuration"];
  readonly provenance: {
    readonly adapter: string;
    readonly runtime?: string;
    readonly generation: Readonly<GenerationConfiguration>;
    readonly local?: LocalProviderProvenance;
    readonly openai?: OpenAIProviderProvenance;
  };
}

export type ProviderErrorCode =
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_BUSY"
  | "TIMEOUT"
  | "CANCELLED"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "BUDGET_EXCEEDED"
  | "POLICY_DENIED"
  | "MALFORMED_PROVIDER_RESPONSE"
  | "PROVIDER_AUTHENTICATION_FAILED"
  | "PROVIDER_PERMISSION_DENIED"
  | "INVALID_PROVIDER_MODEL"
  | "INTERNAL_PROVIDER_FAILURE"
  | "CONTRACT_VIOLATION";

export interface ProviderFailure {
  readonly contractVersion: "provider-result.v1";
  readonly status: "FAILED" | "CANCELLED";
  readonly runRef: ProviderRequest["runRef"];
  readonly attemptRef: `attempt-${string}`;
  readonly selection: ProviderSelection;
  readonly actual?: ProviderIdentity["actual"];
  readonly error: {
    readonly code: ProviderErrorCode;
    readonly source: "POLICY" | "PROVIDER" | "CALLER" | "CONTRACT";
    readonly retry: "SAME_PROVIDER_ONLY" | "DO_NOT_RETRY";
    readonly message: string;
  };
  readonly partialOutput?: {
    readonly text: string;
    readonly trusted: false;
  };
  readonly latency: { readonly totalMs: number };
  readonly policy: ProviderPolicyDecision;
  readonly configuration: ProviderRequest["configuration"];
}

export type ProviderOutcome = ProviderSuccess | ProviderFailure;

interface EventBase {
  readonly contractVersion: "provider-stream-event.v1";
  readonly runRef: ProviderRequest["runRef"];
  readonly attemptRef: `attempt-${string}`;
  readonly sequence: number;
}

export type ProviderStreamEvent = EventBase &
  (
    | { readonly type: "STARTED"; readonly identity: ProviderIdentity }
    | { readonly type: "CONTENT_DELTA"; readonly text: string }
    | {
        readonly type: "PROVENANCE";
        readonly identity: ProviderIdentity;
        readonly policy: AllowedProviderPolicyDecision;
        readonly configuration: ProviderRequest["configuration"];
      }
    | { readonly type: "USAGE_UPDATE"; readonly usage: ProviderUsage }
    | { readonly type: "COMPLETED"; readonly result: ProviderSuccess }
    | {
        readonly type: "FAILED";
        readonly result: ProviderFailure & { readonly status: "FAILED" };
      }
    | {
        readonly type: "CANCELLED";
        readonly result: ProviderFailure & { readonly status: "CANCELLED" };
      }
  );

export interface ProviderExecutionContext {
  readonly signal: {
    readonly aborted: boolean;
    addEventListener?(
      type: "abort",
      listener: () => void,
      options?: { readonly once?: boolean },
    ): void;
    removeEventListener?(type: "abort", listener: () => void): void;
  };
  readonly now?: () => number;
}

export interface ProviderAdapter {
  readonly provider: ProviderId;
  readonly configuration: ProviderRequest["configuration"];
  invoke(
    request: ProviderRequest,
    context: ProviderExecutionContext,
  ): Promise<ProviderOutcome>;
  stream(
    request: ProviderRequest,
    context: ProviderExecutionContext,
  ): AsyncIterable<ProviderStreamEvent>;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(reviewedPolicyRuntimeContract.commonSchema);
const validateCapabilityDecision = ajv.compile(
  reviewedPolicyRuntimeContract.capabilityDecisionSchema,
);
const validateCapabilityEvaluation = ajv.compile(
  reviewedPolicyRuntimeContract.capabilityEvaluationSchema,
);

export function isCapabilityEvaluationContext(
  value: unknown,
): value is import("./policy-contract.generated.ts").CapabilityEvaluationContext {
  return validateCapabilityEvaluation(value);
}

export function isCapabilityDecision(
  value: unknown,
): value is CapabilityDecision {
  return validateCapabilityDecision(value);
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const finiteInteger = (value: unknown, minimum = 0) =>
  Number.isInteger(value) && Number(value) >= minimum;
const digest = (value: unknown) =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const hasOnlyKeys = (value: object, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const providerErrorCodes = new Set<ProviderErrorCode>([
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_BUSY",
  "TIMEOUT",
  "CANCELLED",
  "RATE_LIMITED",
  "QUOTA_EXCEEDED",
  "BUDGET_EXCEEDED",
  "POLICY_DENIED",
  "MALFORMED_PROVIDER_RESPONSE",
  "PROVIDER_AUTHENTICATION_FAILED",
  "PROVIDER_PERMISSION_DENIED",
  "INVALID_PROVIDER_MODEL",
  "INTERNAL_PROVIDER_FAILURE",
  "CONTRACT_VIOLATION",
]);

function validPolicyDecision(value: unknown): value is ProviderPolicyDecision {
  if (!value || typeof value !== "object") return false;
  const decision = value as Partial<ProviderPolicyDecision>;
  const capability = decision.capabilityDecision;
  if (!capability || !validateCapabilityDecision(capability)) return false;
  const reviewed = [
    reviewedPolicyRuntimeContract.identity,
    reviewedPolicyRuntimeContract.demoIdentity,
    reviewedPolicyRuntimeContract.successor.identity,
  ].find(
    (identity) =>
      identity.providerPolicyVersion === decision.providerPolicyVersion,
  );
  if (!reviewed) return false;
  return (
    decision.contractVersion === "provider-policy-decision.v1" &&
    capability.policyVersion === reviewed.policyVersion &&
    capability.classificationVersion === reviewed.classificationVersion &&
    capability.retentionPolicyVersion === reviewed.retentionPolicyVersion &&
    capability.gradingBoundaryVersion === reviewed.gradingBoundaryVersion &&
    capability.constraints.noFallback === true
  );
}

function validAllowedPolicyDecision(
  value: unknown,
): value is AllowedProviderPolicyDecision {
  return (
    validPolicyDecision(value) && value.capabilityDecision.allowed === true
  );
}

function validSelection(value: unknown): value is ProviderSelection {
  if (!value || typeof value !== "object") return false;
  const selection = value as Partial<ProviderSelection>;
  return (
    (selection.provider === "LOCAL" || selection.provider === "OPENAI") &&
    nonEmpty(selection.model)
  );
}

function validConfiguration(
  value: unknown,
): value is ProviderRequest["configuration"] {
  if (!value || typeof value !== "object") return false;
  const configuration = value as Partial<ProviderRequest["configuration"]>;
  return (
    nonEmpty(configuration.reference) &&
    typeof configuration.version === "string" &&
    /^[a-z][a-z0-9-]*\.v[1-9][0-9]*$/.test(configuration.version) &&
    digest(configuration.digest)
  );
}

function validGeneration(value: unknown): value is GenerationConfiguration {
  if (!value || typeof value !== "object") return false;
  const generation = value as Partial<GenerationConfiguration>;
  return (
    finiteInteger(generation.maxOutputTokens, 1) &&
    Number(generation.maxOutputTokens) <= 16_384 &&
    (generation.temperature === undefined ||
      (Number.isFinite(generation.temperature) &&
        generation.temperature >= 0 &&
        generation.temperature <= 2)) &&
    (generation.topP === undefined ||
      (Number.isFinite(generation.topP) &&
        generation.topP > 0 &&
        generation.topP <= 1)) &&
    (generation.stop === undefined ||
      (Array.isArray(generation.stop) &&
        generation.stop.length <= 8 &&
        generation.stop.every(
          (entry) => nonEmpty(entry) && entry.length <= 128,
        )))
  );
}

function containsRoutingDirective(value: unknown): boolean {
  const pending = [value];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const [key, nested] of Object.entries(current)) {
      if (
        key !== "noFallback" &&
        /fallback|backupProvider|alternateProvider|preferredProvider/i.test(key)
      ) {
        return true;
      }
      if (nested && typeof nested === "object") pending.push(nested);
    }
  }
  return false;
}

export function isProviderRequest(value: unknown): value is ProviderRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<ProviderRequest>;
  const attempt = request.attempt;
  const generation = request.generation;
  const messages = request.input?.messages;
  const evidenceRefs = request.input?.evidenceRefs;
  const decision = request.policy?.capabilityDecision;
  const initialAttempt =
    attempt?.kind === "INITIAL" &&
    attempt.ordinal === 1 &&
    nonEmpty(attempt.attemptRef);
  const explicitRerun =
    attempt?.kind === "EXPLICIT_PROVIDER_RERUN" &&
    attempt.ordinal === 1 &&
    nonEmpty(attempt.attemptRef) &&
    nonEmpty(attempt.parentRun?.runRef) &&
    attempt.parentRun.runRef !== request.runRef &&
    validSelection(attempt.parentRun.selection);
  const retryAttempt =
    attempt?.kind === "SAME_PROVIDER_RETRY" &&
    finiteInteger(attempt.ordinal, 2) &&
    nonEmpty(attempt.attemptRef) &&
    nonEmpty(attempt.previousAttemptRef) &&
    validSelection(attempt.previousSelection) &&
    validSelection(request.selection) &&
    attempt.previousSelection.provider === request.selection.provider &&
    attempt.previousSelection.model === request.selection.model;
  return (
    request.contractVersion === "provider-request.v1" &&
    typeof request.runRef === "string" &&
    /^run-.+/.test(request.runRef) &&
    !containsRoutingDirective(request) &&
    (initialAttempt || explicitRerun || retryAttempt) &&
    validSelection(request.selection) &&
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.every(
      (message) =>
        message &&
        ["SYSTEM", "USER", "ASSISTANT"].includes(message.role) &&
        nonEmpty(message.content),
    ) &&
    (evidenceRefs === undefined ||
      (request.selection?.provider === "LOCAL" &&
        Array.isArray(evidenceRefs) &&
        evidenceRefs.length >= 1 &&
        evidenceRefs.length <= 3 &&
        new Set(evidenceRefs).size === evidenceRefs.length &&
        evidenceRefs.every(
          (reference) =>
            typeof reference === "string" &&
            /^course-source-[1-3]$/u.test(reference),
        ))) &&
    validGeneration(generation) &&
    finiteInteger(request.timeoutMs, 1) &&
    Number(request.timeoutMs) <= 120_000 &&
    typeof request.cancellationRef === "string" &&
    /^cancellation-.+/.test(request.cancellationRef) &&
    validAllowedPolicyDecision(request.policy) &&
    decision?.targetProvider === request.selection.provider &&
    decision.targetModel === request.selection.model &&
    validConfiguration(request.configuration)
  );
}

function validUsage(value: unknown): value is ProviderUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Partial<ProviderUsage>;
  return (
    typeof usage.providerReported === "boolean" &&
    [
      usage.inputTokens,
      usage.cachedInputTokens,
      usage.outputTokens,
      usage.totalTokens,
    ].every((count) => count === undefined || finiteInteger(count)) &&
    (usage.cachedInputTokens === undefined ||
      (usage.inputTokens !== undefined &&
        usage.cachedInputTokens <= usage.inputTokens)) &&
    (usage.totalTokens === undefined ||
      usage.inputTokens === undefined ||
      usage.outputTokens === undefined ||
      usage.totalTokens === usage.inputTokens + usage.outputTokens)
  );
}

function validOpenAIProvenance(
  value: unknown,
): value is OpenAIProviderProvenance {
  if (!value || typeof value !== "object") return false;
  const openai = value as Partial<OpenAIProviderProvenance>;
  return (
    hasOnlyKeys(openai, [
      "runtime",
      "configuredModel",
      "selectedModel",
      "responseModel",
      "sdk",
      "store",
      "automaticRetries",
      "sdkLogging",
      "usageStatus",
    ]) &&
    openai.runtime === "OPENAI_RESPONSES" &&
    nonEmpty(openai.configuredModel) &&
    nonEmpty(openai.selectedModel) &&
    nonEmpty(openai.responseModel) &&
    openai.sdk?.name === "openai" &&
    typeof openai.sdk.version === "string" &&
    /^[1-9][0-9]*\.[0-9]+\.[0-9]+$/u.test(openai.sdk.version) &&
    openai.store === false &&
    openai.automaticRetries === 0 &&
    openai.sdkLogging === "OFF" &&
    (openai.usageStatus === "REPORTED" || openai.usageStatus === "NOT_REPORTED")
  );
}

function validLocalResourceMetadata(
  value: unknown,
): value is LocalResourceMetadata {
  if (!value || typeof value !== "object") return false;
  const resources = value as Partial<LocalResourceMetadata>;
  const hasMeasurement =
    resources.processMemoryBytes !== undefined ||
    resources.systemMemoryPressure !== undefined ||
    resources.swapDeltaBytes !== undefined;
  return (
    hasOnlyKeys(resources, [
      "status",
      "processMemoryBytes",
      "systemMemoryPressure",
      "swapDeltaBytes",
    ]) &&
    ["MEASURED", "NOT_AVAILABLE", "INTERRUPTED"].includes(
      resources.status ?? "",
    ) &&
    [resources.processMemoryBytes, resources.swapDeltaBytes].every(
      (entry) => entry === undefined || finiteInteger(entry),
    ) &&
    (resources.systemMemoryPressure === undefined ||
      ["NORMAL", "WARNING", "CRITICAL"].includes(
        resources.systemMemoryPressure,
      )) &&
    (resources.status === "MEASURED" ? hasMeasurement : !hasMeasurement)
  );
}

function validLocalProvenance(
  value: unknown,
): value is LocalProviderProvenance {
  if (!value || typeof value !== "object") return false;
  const local = value as Partial<LocalProviderProvenance>;
  return (
    hasOnlyKeys(local, [
      "runtime",
      "configuredModel",
      "selectedModel",
      "runtimeModel",
      "modelDigest",
      "loadState",
      "residency",
      "loadDurationMs",
      "resources",
    ]) &&
    local.runtime === "OLLAMA" &&
    nonEmpty(local.configuredModel) &&
    nonEmpty(local.selectedModel) &&
    nonEmpty(local.runtimeModel) &&
    (local.modelDigest === undefined || digest(local.modelDigest)) &&
    ["COLD", "WARM", "UNKNOWN"].includes(local.loadState ?? "") &&
    [
      "UNLOADED",
      "LOADING",
      "WARM",
      "BUSY",
      "UNAVAILABLE",
      "SWITCHING",
      "UNKNOWN",
    ].includes(local.residency ?? "") &&
    (local.loadDurationMs === undefined ||
      (Number.isFinite(local.loadDurationMs) && local.loadDurationMs >= 0)) &&
    (local.resources === undefined ||
      validLocalResourceMetadata(local.resources))
  );
}

export function isProviderOutcome(value: unknown): value is ProviderOutcome {
  if (!value || typeof value !== "object") return false;
  const outcome = value as Partial<ProviderOutcome>;
  if (
    outcome.contractVersion !== "provider-result.v1" ||
    !nonEmpty(outcome.runRef) ||
    !nonEmpty(outcome.attemptRef) ||
    !validPolicyDecision(outcome.policy) ||
    !validConfiguration(outcome.configuration) ||
    !outcome.latency ||
    !Number.isFinite(outcome.latency.totalMs) ||
    outcome.latency.totalMs < 0
  ) {
    return false;
  }
  if (outcome.status === "COMPLETED") {
    const success = outcome as Partial<ProviderSuccess>;
    return (
      Boolean(success.identity) &&
      validAllowedPolicyDecision(success.policy) &&
      validSelection(success.identity?.selected) &&
      validSelection({
        provider: success.identity?.actual?.provider,
        model: success.identity?.actual?.model?.id,
      }) &&
      success.identity?.selected?.provider ===
        success.identity?.actual?.provider &&
      typeof success.output?.text === "string" &&
      (success.usage === undefined || validUsage(success.usage)) &&
      (success.finishReason === "STOP" || success.finishReason === "LENGTH") &&
      nonEmpty(success.provenance?.adapter) &&
      (success.provenance.runtime === undefined ||
        nonEmpty(success.provenance.runtime)) &&
      (success.provenance.local === undefined ||
        (success.identity?.actual?.provider === "LOCAL" &&
          validLocalProvenance(success.provenance.local) &&
          success.provenance.local.selectedModel ===
            success.identity.selected.model &&
          success.provenance.local.runtimeModel ===
            success.identity.actual.model.id &&
          success.provenance.local.modelDigest ===
            success.identity.actual.model.digest)) &&
      (success.provenance.openai === undefined ||
        (success.identity?.actual?.provider === "OPENAI" &&
          validOpenAIProvenance(success.provenance.openai) &&
          success.provenance.openai.selectedModel ===
            success.identity.selected.model &&
          success.provenance.openai.responseModel ===
            success.identity.actual.model.id &&
          success.provenance.openai.usageStatus ===
            (success.usage?.providerReported ? "REPORTED" : "NOT_REPORTED"))) &&
      (success.identity?.actual?.provider !== "OPENAI" ||
        success.provenance.openai !== undefined) &&
      validGeneration(success.provenance.generation)
    );
  }
  if (outcome.status === "FAILED" || outcome.status === "CANCELLED") {
    const failure = outcome as Partial<ProviderFailure>;
    const error = failure.error;
    const actualMatches =
      failure.actual === undefined ||
      (failure.actual !== null &&
        failure.actual.provider === failure.selection?.provider &&
        nonEmpty(failure.actual.model?.id));
    const errorSemantics =
      Boolean(error) &&
      providerErrorCodes.has(error?.code as ProviderErrorCode) &&
      ((outcome.status === "CANCELLED" &&
        error?.code === "CANCELLED" &&
        error.source === "CALLER") ||
        (outcome.status === "FAILED" && error?.code !== "CANCELLED")) &&
      (error?.code !== "POLICY_DENIED" || error.source === "POLICY") &&
      (error?.code !== "BUDGET_EXCEEDED" ||
        error.source === "POLICY" ||
        error.source === "PROVIDER") &&
      (error?.code !== "CONTRACT_VIOLATION" || error.source === "CONTRACT");
    return (
      validSelection(failure.selection) &&
      actualMatches &&
      errorSemantics &&
      nonEmpty(error?.message) &&
      (error?.retry === "SAME_PROVIDER_ONLY" ||
        error?.retry === "DO_NOT_RETRY") &&
      failure.policy?.capabilityDecision.targetProvider ===
        failure.selection?.provider &&
      failure.policy.capabilityDecision.targetModel ===
        failure.selection.model &&
      (failure.partialOutput === undefined ||
        (failure.partialOutput !== null &&
          typeof failure.partialOutput.text === "string" &&
          failure.partialOutput.trusted === false)) &&
      (error?.source !== "POLICY" || error.retry === "DO_NOT_RETRY")
    );
  }
  return false;
}

export function isProviderStreamEvent(
  value: unknown,
): value is ProviderStreamEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<ProviderStreamEvent>;
  if (
    event.contractVersion !== "provider-stream-event.v1" ||
    !nonEmpty(event.runRef) ||
    !nonEmpty(event.attemptRef) ||
    !finiteInteger(event.sequence)
  ) {
    return false;
  }
  if (event.type === "CONTENT_DELTA") return nonEmpty(event.text);
  if (event.type === "USAGE_UPDATE") return validUsage(event.usage);
  if (event.type === "COMPLETED")
    return (
      event.result?.status === "COMPLETED" && isProviderOutcome(event.result)
    );
  if (event.type === "FAILED")
    return event.result?.status === "FAILED" && isProviderOutcome(event.result);
  if (event.type === "CANCELLED")
    return (
      event.result?.status === "CANCELLED" && isProviderOutcome(event.result)
    );
  if (event.type === "STARTED") {
    return (
      validSelection(event.identity?.selected) &&
      validSelection({
        provider: event.identity?.actual?.provider,
        model: event.identity?.actual?.model?.id,
      }) &&
      event.identity?.selected.provider === event.identity?.actual?.provider
    );
  }
  if (event.type === "PROVENANCE") {
    const identityValid =
      validSelection(event.identity?.selected) &&
      validSelection({
        provider: event.identity?.actual?.provider,
        model: event.identity?.actual?.model?.id,
      }) &&
      event.identity?.selected.provider === event.identity?.actual?.provider;
    return (
      identityValid &&
      validAllowedPolicyDecision(event.policy) &&
      validConfiguration(event.configuration)
    );
  }
  return false;
}
