import { providerMessages, reservedProviderInput } from "@laita/contracts";
import { randomUUID } from "node:crypto";
import {
  type CapabilityDecision,
  type CapabilityIdentity,
  type ClientProviderFailureCode,
  type ClientRunLeg,
  type ProviderAdapter,
  type ProviderId,
  type ProviderOutcome,
  type ProviderRequest,
  type ProviderRunRequest,
  type ProviderRunResult,
  type ProviderSelection,
  type ProviderUsageRecord,
} from "@laita/contracts";
import type { CapabilityRequestContext } from "@laita/policy";
import { invokeProvider } from "@laita/providers";
export { createProviderHealthController } from "./health.ts";
export type { ProviderHealthController } from "./health.ts";
import type { ProviderHealthController } from "./health.ts";

type ServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string };
export interface ProviderUsagePort {
  admit(value: unknown): ServiceResult<ProviderUsageRecord>;
  finalize(value: unknown): ServiceResult<ProviderUsageRecord>;
  state?(
    provider: ProviderId,
    comparison?: boolean,
  ): ServiceResult<"AVAILABLE" | "WARNING" | "HARD_STOP">;
}
export interface ProviderAuthorizationPort {
  authorize(
    selection: ProviderSelection,
    identity: CapabilityIdentity,
    context: CapabilityRequestContext,
  ): ServiceResult<CapabilityDecision>;
}
export interface ProviderExecutionInput {
  readonly trace?: import("@laita/contracts").Trace;
  readonly request: ProviderRunRequest;
  readonly sessionRef: `session-${string}`;
  readonly context: CapabilityRequestContext;
  readonly signal: AbortSignal;
  readonly evidence?: {
    readonly systemInstruction: string;
    readonly prompt: string;
    readonly refs: readonly string[];
  };
}

const failureMap: Record<string, ClientProviderFailureCode> = {
  PROVIDER_UNAVAILABLE: "SELECTED_PROVIDER_UNAVAILABLE",
  PROVIDER_BUSY: "PROVIDER_BUSY",
  TIMEOUT: "TIMEOUT",
  CANCELLED: "CANCELLED",
  RATE_LIMITED: "OVER_QUOTA",
  QUOTA_EXCEEDED: "OVER_QUOTA",
  BUDGET_EXCEEDED: "OVER_BUDGET",
  POLICY_DENIED: "POLICY_DENIED",
  PROVIDER_AUTHENTICATION_FAILED: "AUTHENTICATION_FAILED",
  PROVIDER_PERMISSION_DENIED: "AUTHENTICATION_FAILED",
  INVALID_PROVIDER_MODEL: "SELECTED_MODEL_UNAVAILABLE",
  MALFORMED_PROVIDER_RESPONSE: "TEMPORARY_PROVIDER_FAILURE",
  INTERNAL_PROVIDER_FAILURE: "TEMPORARY_PROVIDER_FAILURE",
  CONTRACT_VIOLATION: "INTERNAL_FAILURE",
};
const uuidRef = <P extends string>(prefix: P): `${P}-${string}` =>
  `${prefix}-${randomUUID()}`;
const textEncoder = new TextEncoder();
function validEvidence(value: ProviderExecutionInput["evidence"]): boolean {
  return (
    value !== undefined &&
    textEncoder.encode(value.systemInstruction).length >= 1 &&
    textEncoder.encode(value.systemInstruction).length <= 2_048 &&
    textEncoder.encode(value.prompt).length >= 1 &&
    textEncoder.encode(value.prompt).length <= 4_096 &&
    value.refs.length >= 1 &&
    value.refs.length <= 3 &&
    new Set(value.refs).size === value.refs.length &&
    value.refs.every((reference) => /^course-source-[1-3]$/u.test(reference))
  );
}
function usageFailure(code: string): ClientProviderFailureCode {
  if (code === "REQUEST_LIMIT") return "INPUT_LIMIT";
  if (code === "CONCURRENCY_LIMIT") return "PROVIDER_BUSY";
  if (code.includes("BUDGET") || code === "COMPARISON_LIMIT")
    return "OVER_BUDGET";
  if (code.includes("LIMIT")) return "OVER_QUOTA";
  return "INTERNAL_FAILURE";
}

export function createProviderOrchestrator(options: {
  readonly adapters: Readonly<Record<ProviderId, ProviderAdapter>>;
  readonly health: ProviderHealthController;
  readonly authorization: ProviderAuthorizationPort;
  readonly usage: ProviderUsagePort;
  readonly timeoutMs: number;
  readonly maxOutputTokens?: number;
  readonly prepareLocalModel?: (
    model: string,
    signal: AbortSignal,
  ) => Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly code: ClientProviderFailureCode }
  >;
}) {
  const maxOutputTokens = options.maxOutputTokens ?? 512;
  function preflight(
    input: ProviderExecutionInput,
    selection: ProviderSelection,
  ): ClientProviderFailureCode | undefined {
    const authorization = options.authorization.authorize(
      selection,
      input.request.capabilityIdentity,
      input.context,
    );
    if (!authorization.ok) return "STALE_AUTHORIZATION";
    const health = options.health.check(selection.provider, selection.model);
    if (!health.ok) return health.code;
    if (authorization.value.allowed) return undefined;
    return authorization.value.reasonCodes.some(
      (reason) =>
        reason === "POLICY_VERSION_MISMATCH" ||
        reason === "CLIENT_POLICY_OVERRIDE",
    )
      ? "STALE_AUTHORIZATION"
      : "POLICY_DENIED";
  }
  async function leg(
    input: ProviderExecutionInput,
    selection: ProviderSelection,
    interactionRef: `interaction-${string}`,
    comparisonRef?: `comparison-${string}`,
  ): Promise<ClientRunLeg> {
    const runRef = uuidRef("run");
    const attemptRef = uuidRef("attempt");
    const authorization = options.authorization.authorize(
      selection,
      input.request.capabilityIdentity,
      input.context,
    );
    if (input.evidence && selection.provider !== "LOCAL")
      return failedLeg(runRef, selection, "POLICY_DENIED", 0);
    if (input.evidence && !validEvidence(input.evidence)) {
      input.trace?.("ADMISSION", "EVIDENCE_INVALID");
      return failedLeg(runRef, selection, "EVIDENCE_INVALID", 0);
    }
    if (!authorization.ok || !authorization.value.allowed) {
      const health = options.health.check(selection.provider, selection.model);
      const stale =
        authorization.ok &&
        authorization.value.reasonCodes.some(
          (reason) =>
            reason === "POLICY_VERSION_MISMATCH" ||
            reason === "CLIENT_POLICY_OVERRIDE",
        );
      return failedLeg(
        runRef,
        selection,
        !health.ok
          ? health.code
          : stale || !authorization.ok
            ? "STALE_AUTHORIZATION"
            : "POLICY_DENIED",
        0,
      );
    }
    const adapter = options.adapters[selection.provider];
    if (!adapter || adapter.provider !== selection.provider)
      return failedLeg(runRef, selection, "SELECTED_PROVIDER_UNAVAILABLE", 0);
    const messages = providerMessages(
      input.request.input,
      selection.provider,
      input.evidence,
    );
    const reservedInput = reservedProviderInput(messages);
    const admitted = options.usage.admit({
      contractVersion: "provider-usage-admission.v1",
      runRef,
      interactionRef,
      attemptRef,
      sessionRef: input.sessionRef,
      provider: selection.provider,
      model: selection.model,
      inputTokens: reservedInput,
      maxOutputTokens,
      policyVersion: authorization.value.policyVersion,
      configurationVersion: adapter.configuration.version,
      context: {
        courseRef: input.context.courseRef,
        workflow: input.context.workflow,
        comparison: comparisonRef !== undefined,
        ...(comparisonRef ? { comparisonRef } : {}),
      },
    });
    if (!admitted.ok) {
      input.trace?.("ADMISSION", usageFailure(admitted.code));
      return failedLeg(runRef, selection, usageFailure(admitted.code), 0);
    }
    input.trace?.("ADMISSION", "PROVIDER_RESERVED");
    const permitted = options.health.begin(selection.provider, selection.model);
    if (!permitted.ok) {
      const finalized = options.usage.finalize({
        contractVersion: "provider-usage-terminal.v1",
        attemptRef,
        outcome: permitted.code === "CANCELLED" ? "CANCELLED" : "FAILED",
        providerContact: "NOT_STARTED",
        latencyMs: 0,
      });
      return failedLeg(
        runRef,
        selection,
        finalized.ok ? permitted.code : "INTERNAL_FAILURE",
        0,
      );
    }
    if (selection.provider === "LOCAL" && options.prepareLocalModel) {
      const prepared = await options.prepareLocalModel(
        selection.model,
        input.signal,
      );
      if (!prepared.ok) {
        options.health.failed(
          selection.provider,
          selection.model,
          prepared.code,
        );
        const finalized = options.usage.finalize({
          contractVersion: "provider-usage-terminal.v1",
          attemptRef,
          outcome:
            prepared.code === "CANCELLED"
              ? "CANCELLED"
              : prepared.code === "TIMEOUT"
                ? "TIMEOUT"
                : "FAILED",
          providerContact: "MAY_HAVE_OCCURRED",
          latencyMs: 0,
        });
        return failedLeg(
          runRef,
          selection,
          finalized.ok ? prepared.code : "INTERNAL_FAILURE",
          0,
        );
      }
    }
    const providerRequest: ProviderRequest = {
      contractVersion: "provider-request.v1",
      runRef,
      attempt: { kind: "INITIAL", attemptRef, ordinal: 1 },
      selection,
      input: {
        messages,
        ...(input.evidence ? { evidenceRefs: input.evidence.refs } : {}),
      },
      generation: { maxOutputTokens },
      timeoutMs: options.timeoutMs,
      cancellationRef: uuidRef("cancellation"),
      policy: {
        contractVersion: "provider-policy-decision.v1",
        providerPolicyVersion:
          input.request.capabilityIdentity.policy.providerPolicyVersion,
        capabilityDecision: authorization.value as Extract<
          CapabilityDecision,
          { allowed: true }
        >,
      },
      configuration: adapter.configuration,
      context: {
        workflowRef: input.context.workflow,
        modeRef: input.request.mode,
        ...(comparisonRef ? { evidencePackRef: comparisonRef } : {}),
      },
    };
    let outcome: ProviderOutcome;
    try {
      input.trace?.("PROVIDER", "STARTED");
      outcome = await invokeProvider(adapter, providerRequest, {
        signal: input.signal,
      });
    } catch {
      const cancelled = input.signal.aborted;
      outcome = {
        contractVersion: "provider-result.v1",
        status: cancelled ? "CANCELLED" : "FAILED",
        runRef,
        attemptRef,
        selection,
        error: {
          code: cancelled ? "CANCELLED" : "CONTRACT_VIOLATION",
          source: cancelled ? "CALLER" : "CONTRACT",
          retry: "DO_NOT_RETRY",
          message: cancelled
            ? "Provider call was cancelled."
            : "Provider contract failed.",
        },
        latency: { totalMs: 0 },
        policy: providerRequest.policy,
        configuration: adapter.configuration,
      };
    }
    const code =
      outcome.status === "COMPLETED"
        ? undefined
        : (failureMap[outcome.error.code] ?? "INTERNAL_FAILURE");
    if (outcome.status === "COMPLETED")
      options.health.succeeded(selection.provider, selection.model);
    else options.health.failed(selection.provider, selection.model, code!);
    const finalized = options.usage.finalize({
      contractVersion: "provider-usage-terminal.v1",
      attemptRef,
      outcome:
        outcome.status === "COMPLETED"
          ? "COMPLETED"
          : outcome.status === "CANCELLED"
            ? "CANCELLED"
            : outcome.error.code === "TIMEOUT"
              ? "TIMEOUT"
              : "FAILED",
      providerContact: "MAY_HAVE_OCCURRED",
      ...(outcome.status === "COMPLETED" && outcome.usage
        ? { usage: outcome.usage }
        : {}),
      latencyMs: outcome.latency.totalMs,
      ...(outcome.status === "COMPLETED" && outcome.provenance.local?.resources
        ? { localResources: outcome.provenance.local.resources }
        : {}),
    });
    return finalized.ok
      ? clientLeg(outcome, finalized.value, code)
      : failedLeg(
          runRef,
          selection,
          "INTERNAL_FAILURE",
          outcome.latency.totalMs,
        );
  }
  async function execute(
    input: ProviderExecutionInput,
  ): Promise<ProviderRunResult> {
    const interactionRef = uuidRef("interaction");
    const comparisonRef =
      input.request.mode === "COMPARE" ? uuidRef("comparison") : undefined;
    const selections: ProviderSelection[] =
      input.request.mode === "LOCAL"
        ? [{ provider: "LOCAL", model: input.request.localModel! }]
        : input.request.mode === "OPENAI"
          ? [{ provider: "OPENAI", model: input.request.openaiModel! }]
          : [
              { provider: "LOCAL", model: input.request.localModel! },
              { provider: "OPENAI", model: input.request.openaiModel! },
            ];
    if (input.request.mode === "COMPARE") {
      const comparisonBudget = options.usage.state?.("OPENAI", true);
      if (
        comparisonBudget &&
        (!comparisonBudget.ok || comparisonBudget.value === "HARD_STOP")
      ) {
        return {
          contractVersion: "provider-run-result.v1",
          interactionRef,
          mode: input.request.mode,
          comparisonRef: comparisonRef!,
          legs: selections.map((selection) =>
            failedLeg(uuidRef("run"), selection, "OVER_BUDGET", 0),
          ),
        };
      }
      const denials = selections.map((selection) =>
        preflight(input, selection),
      );
      if (denials.some(Boolean)) {
        return {
          contractVersion: "provider-run-result.v1",
          interactionRef,
          mode: input.request.mode,
          comparisonRef: comparisonRef!,
          legs: selections.map((selection, index) =>
            failedLeg(
              uuidRef("run"),
              selection,
              denials[index] ?? "POLICY_DENIED",
              0,
            ),
          ),
        };
      }
    }
    const legs: ClientRunLeg[] = [];
    for (const selection of selections)
      legs.push(await leg(input, selection, interactionRef, comparisonRef));
    return {
      contractVersion: "provider-run-result.v1",
      interactionRef,
      mode: input.request.mode,
      ...(comparisonRef ? { comparisonRef } : {}),
      legs,
    };
  }
  return Object.freeze({ execute, health: options.health.snapshot });
}

function failedLeg(
  runRef: `run-${string}`,
  selection: ProviderSelection,
  code: ClientProviderFailureCode,
  latencyMs: number,
): ClientRunLeg {
  return {
    runRef,
    provider: selection.provider,
    model: selection.model,
    status: code === "CANCELLED" ? "CANCELLED" : "FAILED",
    failure: {
      code,
      retryable: [
        "PROVIDER_BUSY",
        "TIMEOUT",
        "TEMPORARY_PROVIDER_FAILURE",
      ].includes(code),
    },
    metrics: { latencyMs },
  };
}
function clientLeg(
  outcome: ProviderOutcome,
  usage: ProviderUsageRecord,
  code?: ClientProviderFailureCode,
): ClientRunLeg {
  const selection =
    outcome.status === "COMPLETED"
      ? outcome.identity.selected
      : outcome.selection;
  if (outcome.status !== "COMPLETED")
    return failedLeg(
      outcome.runRef,
      selection,
      code ?? "INTERNAL_FAILURE",
      outcome.latency.totalMs,
    );
  return {
    runRef: outcome.runRef,
    provider: selection.provider,
    model: selection.model,
    status: "COMPLETED",
    output: outcome.output,
    provenance: {
      actualProvider: outcome.identity.actual.provider,
      actualModel: outcome.identity.actual.model.id,
      adapter: outcome.provenance.adapter,
      ...(outcome.provenance.runtime
        ? { runtime: outcome.provenance.runtime }
        : {}),
    },
    metrics: {
      latencyMs: outcome.latency.totalMs,
      ...(outcome.usage ? { usage: outcome.usage } : {}),
      ...(usage.estimatedCostNanoUsd !== null &&
      usage.costBasis &&
      usage.costRepresentation
        ? {
            estimatedCost: {
              nanoUsd: usage.estimatedCostNanoUsd,
              basis: usage.costBasis,
              representation: usage.costRepresentation,
            },
          }
        : {}),
      ...(outcome.provenance.local
        ? {
            local: {
              loadState: outcome.provenance.local.loadState,
              ...(outcome.provenance.local.resources
                ? { resources: outcome.provenance.local.resources }
                : {}),
            },
          }
        : {}),
    },
  };
}
