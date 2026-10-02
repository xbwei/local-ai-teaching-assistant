import type {
  ProviderAdapter,
  ProviderErrorCode,
  ProviderExecutionContext,
  ProviderFailure,
  ProviderIdentity,
  ProviderOutcome,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderSuccess,
} from "@laita/contracts";

import {
  invokeProvider,
  ProviderContractError,
  streamProvider,
} from "./index.ts";

export type FakeProviderScenario =
  | "SUCCESS"
  | "UNAVAILABLE"
  | "BUSY"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "AUTHENTICATION_FAILED"
  | "MALFORMED_RESPONSE"
  | "INTERNAL_FAILURE"
  | "CANCEL_AFTER_PARTIAL";

export const fakeProviderConfiguration = {
  reference: "provider-config-fixture",
  version: "provider-config.v1",
  digest: `sha256:${"a".repeat(64)}`,
} as const;

const errors: Record<
  Exclude<FakeProviderScenario, "SUCCESS" | "CANCEL_AFTER_PARTIAL">,
  ProviderErrorCode
> = {
  UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  BUSY: "PROVIDER_BUSY",
  TIMEOUT: "TIMEOUT",
  RATE_LIMITED: "RATE_LIMITED",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  AUTHENTICATION_FAILED: "PROVIDER_AUTHENTICATION_FAILED",
  MALFORMED_RESPONSE: "MALFORMED_PROVIDER_RESPONSE",
  INTERNAL_FAILURE: "INTERNAL_PROVIDER_FAILURE",
};

export const providerFailureScenarios = Object.entries(errors).map(
  ([scenario, code]) => ({
    scenario: scenario as Exclude<
      FakeProviderScenario,
      "SUCCESS" | "CANCEL_AFTER_PARTIAL"
    >,
    code,
  }),
);

function identity(request: ProviderRequest): ProviderIdentity {
  return {
    selected: request.selection,
    actual: {
      provider: request.selection.provider,
      model: { id: request.selection.model, version: "fake-runtime.v1" },
    },
  };
}

function success(request: ProviderRequest, text: string): ProviderSuccess {
  const openai =
    request.selection.provider === "OPENAI"
      ? {
          runtime: "OPENAI_RESPONSES" as const,
          configuredModel: request.selection.model,
          selectedModel: request.selection.model,
          responseModel: request.selection.model,
          sdk: { name: "openai" as const, version: "1.0.0" },
          store: false as const,
          automaticRetries: 0 as const,
          sdkLogging: "OFF" as const,
          usageStatus: "NOT_REPORTED" as const,
        }
      : undefined;
  return {
    contractVersion: "provider-result.v1",
    status: "COMPLETED",
    runRef: request.runRef,
    attemptRef: request.attempt.attemptRef,
    identity: identity(request),
    output: { text },
    usage: {
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      providerReported: false,
    },
    latency: { totalMs: 12, firstOutputMs: 4 },
    finishReason: "STOP",
    policy: request.policy,
    configuration: request.configuration,
    provenance: {
      adapter: "deterministic-fake.v1",
      runtime: "synthetic",
      generation: request.generation,
      ...(openai === undefined ? {} : { openai }),
    },
  };
}

function failure(
  request: ProviderRequest,
  scenario: Exclude<FakeProviderScenario, "SUCCESS">,
  partialText?: string,
): ProviderFailure {
  const cancelled = scenario === "CANCEL_AFTER_PARTIAL";
  return {
    contractVersion: "provider-result.v1",
    status: cancelled ? "CANCELLED" : "FAILED",
    runRef: request.runRef,
    attemptRef: request.attempt.attemptRef,
    selection: request.selection,
    actual: identity(request).actual,
    error: {
      code: cancelled ? "CANCELLED" : errors[scenario],
      source: cancelled ? "CALLER" : "PROVIDER",
      retry:
        scenario === "UNAVAILABLE" ||
        scenario === "BUSY" ||
        scenario === "TIMEOUT" ||
        scenario === "RATE_LIMITED"
          ? "SAME_PROVIDER_ONLY"
          : "DO_NOT_RETRY",
      message: `Synthetic ${scenario.toLowerCase()} result.`,
    },
    ...(partialText === undefined
      ? {}
      : { partialOutput: { text: partialText, trusted: false as const } }),
    latency: { totalMs: 8 },
    policy: request.policy,
    configuration: request.configuration,
  };
}

export function createFakeProviderAdapter(options: {
  readonly provider: "LOCAL" | "OPENAI";
  readonly scenario?: FakeProviderScenario;
  readonly output?: string;
  readonly configuration?: ProviderRequest["configuration"];
  readonly onInvoke?: (request: ProviderRequest) => void;
}): ProviderAdapter {
  const scenario = options.scenario ?? "SUCCESS";
  const output = options.output ?? "synthetic response";
  return {
    provider: options.provider,
    configuration: options.configuration ?? fakeProviderConfiguration,
    async invoke(
      request: ProviderRequest,
      context: ProviderExecutionContext,
    ): Promise<ProviderOutcome> {
      options.onInvoke?.(request);
      if (context.signal.aborted || scenario === "CANCEL_AFTER_PARTIAL") {
        return failure(request, "CANCEL_AFTER_PARTIAL");
      }
      return scenario === "SUCCESS"
        ? success(request, output)
        : failure(request, scenario);
    },
    async *stream(
      request: ProviderRequest,
      context: ProviderExecutionContext,
    ): AsyncIterable<ProviderStreamEvent> {
      options.onInvoke?.(request);
      let sequence = 0;
      yield {
        contractVersion: "provider-stream-event.v1",
        runRef: request.runRef,
        attemptRef: request.attempt.attemptRef,
        sequence: sequence++,
        type: "STARTED",
        identity: identity(request),
      };
      if (scenario === "SUCCESS") {
        yield {
          contractVersion: "provider-stream-event.v1",
          runRef: request.runRef,
          attemptRef: request.attempt.attemptRef,
          sequence: sequence++,
          type: "PROVENANCE",
          identity: identity(request),
          policy: request.policy,
          configuration: request.configuration,
        };
        const split = Math.max(1, Math.floor(output.length / 2));
        for (const text of [output.slice(0, split), output.slice(split)].filter(
          Boolean,
        )) {
          yield {
            contractVersion: "provider-stream-event.v1",
            runRef: request.runRef,
            attemptRef: request.attempt.attemptRef,
            sequence: sequence++,
            type: "CONTENT_DELTA",
            text,
          };
        }
        yield {
          contractVersion: "provider-stream-event.v1",
          runRef: request.runRef,
          attemptRef: request.attempt.attemptRef,
          sequence: sequence++,
          type: "USAGE_UPDATE",
          usage: {
            inputTokens: 3,
            outputTokens: 2,
            totalTokens: 5,
            providerReported: false,
          },
        };
        yield {
          contractVersion: "provider-stream-event.v1",
          runRef: request.runRef,
          attemptRef: request.attempt.attemptRef,
          sequence: sequence++,
          type: "COMPLETED",
          result: success(request, output),
        };
        return;
      }
      if (scenario === "CANCEL_AFTER_PARTIAL" || context.signal.aborted) {
        const partial = "partial";
        yield {
          contractVersion: "provider-stream-event.v1",
          runRef: request.runRef,
          attemptRef: request.attempt.attemptRef,
          sequence: sequence++,
          type: "CONTENT_DELTA",
          text: partial,
        };
        yield {
          contractVersion: "provider-stream-event.v1",
          runRef: request.runRef,
          attemptRef: request.attempt.attemptRef,
          sequence: sequence++,
          type: "CANCELLED",
          result: failure(
            request,
            "CANCEL_AFTER_PARTIAL",
            partial,
          ) as ProviderFailure & {
            readonly status: "CANCELLED";
          },
        };
        return;
      }
      yield {
        contractVersion: "provider-stream-event.v1",
        runRef: request.runRef,
        attemptRef: request.attempt.attemptRef,
        sequence: sequence++,
        type: "FAILED",
        result: failure(request, scenario) as ProviderFailure & {
          readonly status: "FAILED";
        },
      };
    },
  };
}

export async function runProviderAdapterContractSuite(options: {
  readonly request: ProviderRequest;
  readonly context: () => ProviderExecutionContext;
  readonly expectedOutput: string;
  readonly createAdapter: (scenario: FakeProviderScenario) => ProviderAdapter;
}): Promise<void> {
  const successResult = await invokeProvider(
    options.createAdapter("SUCCESS"),
    options.request,
    options.context(),
  );
  if (
    successResult.status !== "COMPLETED" ||
    successResult.output.text !== options.expectedOutput ||
    successResult.identity.selected.provider !==
      successResult.identity.actual.provider
  ) {
    throw new ProviderContractError(
      "adapter contract suite expected a provenance-complete success",
    );
  }

  const events: ProviderStreamEvent[] = [];
  for await (const event of streamProvider(
    options.createAdapter("SUCCESS"),
    options.request,
    options.context(),
  )) {
    events.push(event);
  }
  const terminal = events.at(-1);
  if (
    terminal?.type !== "COMPLETED" ||
    terminal.result.output.text !== successResult.output.text ||
    !events.some(({ type }) => type === "PROVENANCE") ||
    !events.some(({ type }) => type === "USAGE_UPDATE")
  ) {
    throw new ProviderContractError(
      "adapter contract suite expected equivalent stream/final semantics",
    );
  }

  for (const { scenario, code } of providerFailureScenarios) {
    const result = await invokeProvider(
      options.createAdapter(scenario),
      options.request,
      options.context(),
    );
    if (result.status !== "FAILED" || result.error.code !== code) {
      throw new ProviderContractError(
        `adapter contract suite expected normalized ${code}`,
      );
    }
  }

  const cancellationEvents: ProviderStreamEvent[] = [];
  for await (const event of streamProvider(
    options.createAdapter("CANCEL_AFTER_PARTIAL"),
    options.request,
    options.context(),
  )) {
    cancellationEvents.push(event);
  }
  const cancellation = cancellationEvents.at(-1);
  if (
    cancellation?.type !== "CANCELLED" ||
    cancellation.result.partialOutput?.trusted !== false
  ) {
    throw new ProviderContractError(
      "adapter contract suite expected explicit untrusted partial cancellation",
    );
  }
}
