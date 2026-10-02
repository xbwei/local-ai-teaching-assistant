import { createHash } from "node:crypto";

import type {
  ProviderOutcome,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderSuccess,
} from "@laita/contracts";
import {
  createSecretHandleForProvider,
  MacOSKeychainSecretProvider,
  type SecretCommandRunner,
  type SecretProvider,
  type SecretReference,
} from "@laita/runtime";
import { invokeProvider, streamProvider } from "./index.ts";
import {
  OpenAIConfigurationError,
  OpenAIResponsesAdapter,
  type OpenAIModelCandidate,
} from "./openai.ts";

export const OPENAI_LIVE_EVIDENCE_VERSION = "openai-live-evidence.v1";
export const OPENAI_LIVE_MODEL = "gpt-5.6-luna";

const SYNTHETIC_PROMPT =
  "Return the integers 1 through 32 in order, separated by single spaces, and no other text.";
const CONFIGURATION_VERSION = "openai-live-config.v1" as const;
const SECRET_REFERENCE = Object.freeze({
  kind: "opaque" as const,
  id: "openai-live-primary",
});
const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_PROBE_MS = 1;

export interface OpenAILiveUsageEvidence {
  readonly inputTokens: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly providerReported: true;
}

export interface OpenAILiveProvenanceEvidence {
  readonly adapter: string;
  readonly runtime: "OPENAI_RESPONSES";
  readonly sdk: { readonly name: "openai"; readonly version: string };
  readonly configuredModel: string;
  readonly selectedModel: string;
  readonly responseModel: string;
  readonly configurationReference: string;
  readonly configurationVersion: string;
  readonly configurationDigest: `sha256:${string}`;
  readonly store: false;
  readonly automaticRetries: 0;
  readonly sdkLogging: "OFF";
  readonly usageStatus: "REPORTED" | "NOT_REPORTED";
}

export interface OpenAILiveTestEvidence {
  readonly test: string;
  readonly status: "PASS" | "FAIL";
  readonly provider: "OPENAI";
  readonly selectedModel: string;
  readonly actualModel?: string;
  readonly latencyMs?: number;
  readonly firstOutputMs?: number;
  readonly deltaCount?: number;
  readonly outcome: string;
  readonly usage?: OpenAILiveUsageEvidence;
  readonly provenance?: OpenAILiveProvenanceEvidence;
}

export interface OpenAILiveEvidence {
  readonly contractVersion: typeof OPENAI_LIVE_EVIDENCE_VERSION;
  readonly status: "PASS" | "FAIL" | "NOT_RUN";
  readonly summary: string;
  readonly model: typeof OPENAI_LIVE_MODEL;
  readonly tests: readonly OpenAILiveTestEvidence[];
  readonly cleanup: {
    readonly status: "PASS" | "FAIL" | "NOT_RUN";
    readonly temporaryStateRetained: false;
  };
}

export interface OpenAILiveHarnessOptions {
  readonly confirmed: boolean;
  readonly keychain?: {
    readonly service: string;
    readonly account: string;
  };
  readonly operationTimeoutMs?: number;
  readonly timeoutProbeMs?: number;
  /** Test-only loopback upstream; the production CLI never accepts an override. */
  readonly testBaseURL?: string;
  /** Test-only Keychain process fixture; the production CLI never injects one. */
  readonly keychainCommandRunner?: SecretCommandRunner;
}

class HarnessStop extends Error {}

function boundedInteger(
  value: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const selected = value ?? defaultValue;
  if (
    !Number.isSafeInteger(selected) ||
    selected < minimum ||
    selected > maximum
  ) {
    throw new OpenAIConfigurationError(`${label} must be a bounded integer.`);
  }
  return selected;
}

function configuration() {
  const reference = "openai-live-harness";
  const digest = createHash("sha256")
    .update(`${reference}:${CONFIGURATION_VERSION}:${OPENAI_LIVE_MODEL}`)
    .digest("hex");
  return {
    reference,
    version: CONFIGURATION_VERSION,
    digest: `sha256:${digest}` as const,
  };
}

function policy() {
  const digest = createHash("sha256")
    .update(`openai-live:${OPENAI_LIVE_MODEL}`)
    .digest("hex");
  return {
    contractVersion: "provider-policy-decision.v1" as const,
    providerPolicyVersion: "provider-eligibility.v1" as const,
    capabilityDecision: {
      contractVersion: "capability-decision.v1" as const,
      decisionRef: "decision-openai-live-synthetic",
      evaluatedContextDigest: `sha256:${digest}` as const,
      policyVersion: "teaching-policy.v1" as const,
      classificationVersion: "data-classification.v1" as const,
      retentionPolicyVersion: "retention-policy.v1" as const,
      gradingBoundaryVersion: "grading-boundary.v1" as const,
      targetProvider: "OPENAI" as const,
      targetModel: OPENAI_LIVE_MODEL,
      allowed: true as const,
      reasonCodes: ["EXPLICIT_ALLOW"] as const,
      constraints: {
        localOnly: false,
        noFallback: true,
        minimizedContentRequired: true,
      } as const,
      recheckOn: ["PROVIDER_OR_MODEL_CHANGE", "POLICY_VERSION_CHANGE"] as const,
    },
  };
}

function candidate(): OpenAIModelCandidate {
  return {
    model: OPENAI_LIVE_MODEL,
    maxInputBytes: 1_024,
    maxMessages: 1,
    maxMessageBytes: 1_024,
    maxOutputTokens: 64,
    maxOutputBytes: 4_096,
  };
}

let requestSequence = 0;
function providerRequest(timeoutMs: number): ProviderRequest {
  requestSequence += 1;
  const suffix = `${requestSequence}`;
  return {
    contractVersion: "provider-request.v1",
    runRef: `run-openai-live-${suffix}`,
    attempt: {
      kind: "INITIAL",
      attemptRef: `attempt-openai-live-${suffix}`,
      ordinal: 1,
    },
    selection: { provider: "OPENAI", model: OPENAI_LIVE_MODEL },
    input: { messages: [{ role: "USER", content: SYNTHETIC_PROMPT }] },
    generation: { maxOutputTokens: 64, temperature: 0, topP: 0.9 },
    timeoutMs,
    cancellationRef: `cancellation-openai-live-${suffix}`,
    policy: policy(),
    configuration: configuration(),
  };
}

function adapter(
  secretProvider: SecretProvider,
  secretReference: SecretReference,
  testBaseURL: string | undefined,
): OpenAIResponsesAdapter {
  return new OpenAIResponsesAdapter({
    configuration: configuration(),
    candidates: [candidate()],
    selectedModel: OPENAI_LIVE_MODEL,
    secretProvider,
    secretReference,
    ...(testBaseURL === undefined ? {} : { testBaseURL }),
  });
}

function completedEvidence(
  test: string,
  result: ProviderSuccess,
  deltaCount?: number,
): OpenAILiveTestEvidence {
  const openai = result.provenance.openai;
  const measuredUsage = result.usage;
  const usageIsComplete =
    measuredUsage?.providerReported === true &&
    typeof measuredUsage.inputTokens === "number" &&
    typeof measuredUsage.outputTokens === "number" &&
    typeof measuredUsage.totalTokens === "number";
  const passed =
    result.identity.actual.provider === "OPENAI" &&
    result.identity.actual.model.id === OPENAI_LIVE_MODEL &&
    openai?.runtime === "OPENAI_RESPONSES" &&
    openai.configuredModel === OPENAI_LIVE_MODEL &&
    openai.selectedModel === OPENAI_LIVE_MODEL &&
    openai.responseModel === OPENAI_LIVE_MODEL &&
    openai.store === false &&
    openai.automaticRetries === 0 &&
    openai.sdkLogging === "OFF" &&
    usageIsComplete &&
    (deltaCount === undefined || deltaCount > 0);
  return {
    test,
    status: passed ? "PASS" : "FAIL",
    provider: "OPENAI",
    selectedModel: OPENAI_LIVE_MODEL,
    actualModel: result.identity.actual.model.id,
    latencyMs: result.latency.totalMs,
    ...(result.latency.firstOutputMs === undefined
      ? {}
      : { firstOutputMs: result.latency.firstOutputMs }),
    ...(deltaCount === undefined ? {} : { deltaCount }),
    outcome: passed ? result.finishReason : "INVALID_SUCCESS_PROVENANCE",
    ...(!usageIsComplete
      ? {}
      : {
          usage: {
            inputTokens: measuredUsage.inputTokens,
            ...(measuredUsage.cachedInputTokens === undefined
              ? {}
              : { cachedInputTokens: measuredUsage.cachedInputTokens }),
            outputTokens: measuredUsage.outputTokens,
            totalTokens: measuredUsage.totalTokens,
            providerReported: true,
          },
        }),
    ...(openai === undefined
      ? {}
      : {
          provenance: {
            adapter: result.provenance.adapter,
            runtime: openai.runtime,
            sdk: { name: openai.sdk.name, version: openai.sdk.version },
            configuredModel: openai.configuredModel,
            selectedModel: openai.selectedModel,
            responseModel: openai.responseModel,
            configurationReference: result.configuration.reference,
            configurationVersion: result.configuration.version,
            configurationDigest: result.configuration.digest,
            store: openai.store,
            automaticRetries: openai.automaticRetries,
            sdkLogging: openai.sdkLogging,
            usageStatus: openai.usageStatus,
          },
        }),
  };
}

function failureEvidence(
  test: string,
  result: ProviderOutcome,
  expected: string,
): OpenAILiveTestEvidence {
  const outcome =
    result.status === "COMPLETED" ? "TRUSTED_COMPLETION" : result.error.code;
  return {
    test,
    status: outcome === expected ? "PASS" : "FAIL",
    provider: "OPENAI",
    selectedModel: OPENAI_LIVE_MODEL,
    latencyMs: result.latency.totalMs,
    outcome,
  };
}

function terminal(events: readonly ProviderStreamEvent[]) {
  return events.findLast((event) =>
    ["COMPLETED", "FAILED", "CANCELLED"].includes(event.type),
  );
}

function requirePass(evidence: OpenAILiveTestEvidence): void {
  if (evidence.status !== "PASS") throw new HarnessStop();
}

async function streamEvidence(
  current: OpenAIResponsesAdapter,
  timeoutMs: number,
): Promise<OpenAILiveTestEvidence> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of streamProvider(
    current,
    providerRequest(timeoutMs),
    { signal: new AbortController().signal },
  )) {
    events.push(event);
  }
  const final = terminal(events);
  const deltaCount = events.filter(
    (event) => event.type === "CONTENT_DELTA",
  ).length;
  if (final?.type === "COMPLETED") {
    return completedEvidence("stream", final.result, deltaCount);
  }
  return {
    test: "stream",
    status: "FAIL",
    provider: "OPENAI",
    selectedModel: OPENAI_LIVE_MODEL,
    deltaCount,
    outcome:
      final && (final.type === "FAILED" || final.type === "CANCELLED")
        ? final.result.error.code
        : "MISSING_TERMINAL",
  };
}

async function cancellationEvidence(
  current: OpenAIResponsesAdapter,
  timeoutMs: number,
): Promise<OpenAILiveTestEvidence> {
  const controller = new AbortController();
  const events: ProviderStreamEvent[] = [];
  for await (const event of streamProvider(
    current,
    providerRequest(timeoutMs),
    { signal: controller.signal },
  )) {
    events.push(event);
    if (event.type === "CONTENT_DELTA") controller.abort();
  }
  const final = terminal(events);
  const deltaCount = events.filter(
    (event) => event.type === "CONTENT_DELTA",
  ).length;
  const passed =
    deltaCount > 0 &&
    final?.type === "CANCELLED" &&
    final.result.status === "CANCELLED" &&
    final.result.error.code === "CANCELLED" &&
    !events.some((event) => event.type === "COMPLETED");
  return {
    test: "cancellation",
    status: passed ? "PASS" : "FAIL",
    provider: "OPENAI",
    selectedModel: OPENAI_LIVE_MODEL,
    deltaCount,
    outcome:
      final && "result" in final && final.result.status !== "COMPLETED"
        ? final.result.error.code
        : "TRUSTED_COMPLETION",
  };
}

function syntheticInvalidSecretProvider(): SecretProvider {
  const value = ["sk", "live", "invalid", "x".repeat(24)].join("-");
  return {
    async resolve(_reference, { signal }) {
      if (signal.aborted) {
        return { status: "UNAVAILABLE", code: "SECRET_CANCELLED" };
      }
      return {
        status: "RESOLVED",
        secret: createSecretHandleForProvider(value),
      };
    },
  };
}

export async function runOpenAILiveHarness(
  options: OpenAILiveHarnessOptions,
): Promise<OpenAILiveEvidence> {
  if (!options || !options.confirmed) {
    return {
      contractVersion: OPENAI_LIVE_EVIDENCE_VERSION,
      status: "NOT_RUN",
      summary: "Live OpenAI validation was not explicitly confirmed.",
      model: OPENAI_LIVE_MODEL,
      tests: [],
      cleanup: { status: "NOT_RUN", temporaryStateRetained: false },
    };
  }

  const operationTimeoutMs = boundedInteger(
    options.operationTimeoutMs,
    DEFAULT_OPERATION_TIMEOUT_MS,
    1_000,
    120_000,
    "Operation timeout",
  );
  const timeoutProbeMs = boundedInteger(
    options.timeoutProbeMs,
    DEFAULT_TIMEOUT_PROBE_MS,
    1,
    1_000,
    "Timeout probe",
  );
  if (!options.keychain) {
    throw new OpenAIConfigurationError(
      "A protected Keychain mapping is required for live validation.",
    );
  }
  const keychain = new MacOSKeychainSecretProvider({
    references: {
      [SECRET_REFERENCE.id]: {
        service: options.keychain.service,
        account: options.keychain.account,
      },
    },
    timeoutMs: Math.min(operationTimeoutMs, 30_000),
    ...(options.keychainCommandRunner === undefined
      ? {}
      : { commandRunner: options.keychainCommandRunner }),
  });
  const current = adapter(keychain, SECRET_REFERENCE, options.testBaseURL);
  const tests: OpenAILiveTestEvidence[] = [];

  try {
    const missing = adapter(
      keychain,
      { kind: "opaque", id: "openai-live-missing" },
      options.testBaseURL,
    );
    const missingEvidence = failureEvidence(
      "missing-secret-isolation",
      await invokeProvider(missing, providerRequest(operationTimeoutMs), {
        signal: new AbortController().signal,
      }),
      "PROVIDER_UNAVAILABLE",
    );
    tests.push(missingEvidence);
    requirePass(missingEvidence);

    const nonStream = await invokeProvider(
      current,
      providerRequest(operationTimeoutMs),
      { signal: new AbortController().signal },
    );
    const nonStreamEvidence =
      nonStream.status === "COMPLETED"
        ? completedEvidence("keychain-non-stream", nonStream)
        : failureEvidence("keychain-non-stream", nonStream, "COMPLETED");
    tests.push(nonStreamEvidence);
    requirePass(nonStreamEvidence);

    for (const operation of [
      () => streamEvidence(current, operationTimeoutMs),
      () => cancellationEvidence(current, operationTimeoutMs),
    ]) {
      const evidence = await operation();
      tests.push(evidence);
      requirePass(evidence);
    }

    const timeoutEvidence = failureEvidence(
      "timeout",
      await invokeProvider(current, providerRequest(timeoutProbeMs), {
        signal: new AbortController().signal,
      }),
      "TIMEOUT",
    );
    tests.push(timeoutEvidence);
    requirePass(timeoutEvidence);

    const invalidCredential = adapter(
      syntheticInvalidSecretProvider(),
      SECRET_REFERENCE,
      options.testBaseURL,
    );
    const authenticationEvidence = failureEvidence(
      "authentication-failure-isolation",
      await invokeProvider(
        invalidCredential,
        providerRequest(operationTimeoutMs),
        { signal: new AbortController().signal },
      ),
      "PROVIDER_AUTHENTICATION_FAILED",
    );
    tests.push(authenticationEvidence);
    requirePass(authenticationEvidence);
  } catch (error) {
    if (!(error instanceof HarnessStop)) {
      tests.push({
        test: "harness",
        status: "FAIL",
        provider: "OPENAI",
        selectedModel: OPENAI_LIVE_MODEL,
        outcome: "SAFE_HARNESS_FAILURE",
      });
    }
  }

  const passed =
    tests.length === 6 && tests.every((test) => test.status === "PASS");
  return {
    contractVersion: OPENAI_LIVE_EVIDENCE_VERSION,
    status: passed ? "PASS" : "FAIL",
    summary: passed
      ? "Bounded live OpenAI validation passed."
      : "Bounded live OpenAI validation failed safely.",
    model: OPENAI_LIVE_MODEL,
    tests,
    cleanup: { status: "PASS", temporaryStateRetained: false },
  };
}
