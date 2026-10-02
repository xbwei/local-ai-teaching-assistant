import {
  isProviderOutcome,
  isProviderRequest,
  isProviderStreamEvent,
  type ProviderAdapter,
  type ProviderExecutionContext,
  type ProviderFailure,
  type ProviderOutcome,
  type ProviderPolicyDecision,
  type ProviderRequest,
  type ProviderSelection,
  type ProviderStreamEvent,
} from "@laita/contracts";
import { isDeepStrictEqual } from "node:util";

export class ProviderContractError extends Error {
  override readonly name = "ProviderContractError";
}

function sameValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function assertOutcomeMatchesRequest(
  request: ProviderRequest,
  outcome: ProviderOutcome,
) {
  if (!isProviderOutcome(outcome)) {
    throw new ProviderContractError(
      "adapter returned an invalid provider outcome",
    );
  }
  if (
    outcome.runRef !== request.runRef ||
    outcome.attemptRef !== request.attempt.attemptRef ||
    !sameValue(outcome.policy, request.policy) ||
    !sameValue(outcome.configuration, request.configuration)
  ) {
    throw new ProviderContractError(
      "adapter outcome changed the run, policy, or configuration identity",
    );
  }
  const selection =
    outcome.status === "COMPLETED"
      ? outcome.identity.selected
      : outcome.selection;
  if (!sameValue(selection, request.selection)) {
    throw new ProviderContractError(
      "adapter outcome changed provider selection",
    );
  }
  if (
    outcome.status === "COMPLETED" &&
    !sameValue(outcome.provenance.generation, request.generation)
  ) {
    throw new ProviderContractError(
      "adapter outcome changed the generation configuration",
    );
  }
  const actual =
    outcome.status === "COMPLETED" ? outcome.identity.actual : outcome.actual;
  if (actual && actual.provider !== request.selection.provider) {
    throw new ProviderContractError("adapter substituted a different provider");
  }
}

function assertInvocation(adapter: ProviderAdapter, request: ProviderRequest) {
  if (!isProviderRequest(request)) {
    throw new ProviderContractError(
      "provider request is invalid or its reviewed policy decision is stale",
    );
  }
  if (adapter.provider !== request.selection.provider) {
    throw new ProviderContractError(
      "explicitly selected provider does not match the supplied adapter",
    );
  }
  if (!sameValue(adapter.configuration, request.configuration)) {
    throw new ProviderContractError(
      "provider configuration identity is unknown or stale",
    );
  }
}

export async function invokeProvider(
  adapter: ProviderAdapter,
  request: ProviderRequest,
  context: ProviderExecutionContext,
): Promise<ProviderOutcome> {
  assertInvocation(adapter, request);
  const outcome = await adapter.invoke(request, context);
  assertOutcomeMatchesRequest(request, outcome);
  return outcome;
}

export async function* streamProvider(
  adapter: ProviderAdapter,
  request: ProviderRequest,
  context: ProviderExecutionContext,
): AsyncIterable<ProviderStreamEvent> {
  assertInvocation(adapter, request);
  let expectedSequence = 0;
  let started = false;
  let terminal = false;
  let accumulatedText = "";
  for await (const event of adapter.stream(request, context)) {
    if (!isProviderStreamEvent(event)) {
      throw new ProviderContractError(
        "adapter returned an invalid stream event",
      );
    }
    if (
      terminal ||
      event.sequence !== expectedSequence ||
      event.runRef !== request.runRef ||
      event.attemptRef !== request.attempt.attemptRef
    ) {
      throw new ProviderContractError(
        "stream event order or request identity is invalid",
      );
    }
    if (expectedSequence === 0 && event.type !== "STARTED") {
      throw new ProviderContractError("stream must begin with STARTED");
    }
    if (event.type === "STARTED") {
      if (started || !sameValue(event.identity.selected, request.selection)) {
        throw new ProviderContractError(
          "stream start changed provider selection",
        );
      }
      if (event.identity.actual.provider !== request.selection.provider) {
        throw new ProviderContractError(
          "stream substituted a different provider",
        );
      }
      started = true;
    } else if (event.type === "CONTENT_DELTA") {
      accumulatedText += event.text;
    } else if (
      event.type === "COMPLETED" ||
      event.type === "FAILED" ||
      event.type === "CANCELLED"
    ) {
      assertOutcomeMatchesRequest(request, event.result);
      if (
        event.type === "COMPLETED" &&
        event.result.output.text !== accumulatedText
      ) {
        throw new ProviderContractError(
          "stream deltas differ from the completed final result",
        );
      }
      if (
        event.type !== "COMPLETED" &&
        accumulatedText.length > 0 &&
        event.result.partialOutput?.text !== accumulatedText
      ) {
        throw new ProviderContractError(
          "partial stream output is missing or differs from terminal state",
        );
      }
      terminal = true;
    }
    expectedSequence += 1;
    yield event;
  }
  if (!started || !terminal) {
    throw new ProviderContractError(
      "stream ended without start and exactly one terminal result",
    );
  }
}

export function createPolicyDeniedOutcome(input: {
  readonly runRef: ProviderRequest["runRef"];
  readonly attemptRef: `attempt-${string}`;
  readonly selection: ProviderSelection;
  readonly policy: ProviderPolicyDecision;
  readonly configuration: ProviderRequest["configuration"];
  readonly message?: string;
}): ProviderFailure {
  const capabilityDecision = input?.policy?.capabilityDecision;
  const selection = input?.selection;
  if (
    !capabilityDecision ||
    !selection ||
    capabilityDecision.allowed ||
    capabilityDecision.targetProvider !== selection.provider ||
    capabilityDecision.targetModel !== selection.model
  ) {
    throw new ProviderContractError(
      "policy denial must match the explicit provider and model selection",
    );
  }
  const reasons = Array.isArray(capabilityDecision.reasonCodes)
    ? capabilityDecision.reasonCodes
    : [];
  const code = reasons.includes("OVER_BUDGET")
    ? "BUDGET_EXCEEDED"
    : reasons.includes("QUOTA_UNAVAILABLE")
      ? "QUOTA_EXCEEDED"
      : "POLICY_DENIED";
  const outcome: ProviderFailure = {
    contractVersion: "provider-result.v1",
    status: "FAILED",
    runRef: input.runRef,
    attemptRef: input.attemptRef,
    selection,
    error: {
      code,
      source: "POLICY",
      retry: "DO_NOT_RETRY",
      message: input.message ?? "The selected provider is not eligible.",
    },
    latency: { totalMs: 0 },
    policy: input.policy,
    configuration: input.configuration,
  };
  if (!isProviderOutcome(outcome)) {
    throw new ProviderContractError(
      "policy denial is stale or violates the reviewed result contract",
    );
  }
  return outcome;
}

export type {
  ProviderAdapter,
  ProviderExecutionContext,
  ProviderOutcome,
  ProviderRequest,
  ProviderStreamEvent,
};

export { OllamaConfigurationError, OllamaLocalAdapter } from "./ollama.ts";
export type {
  OllamaAdapterOptions,
  OllamaAvailabilitySnapshot,
  OllamaModelCandidate,
  OllamaModelStatus,
  OllamaModelSwitchResult,
  OllamaRuntimeSnapshot,
  OllamaUnloadResult,
} from "./ollama.ts";

export { OpenAIConfigurationError, OpenAIResponsesAdapter } from "./openai.ts";
export type { OpenAIAdapterOptions, OpenAIModelCandidate } from "./openai.ts";
