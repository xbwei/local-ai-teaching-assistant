import { createHash } from "node:crypto";

import type {
  LocalResourceMetadata,
  ProviderOutcome,
  ProviderRequest,
  ProviderStreamEvent,
} from "@laita/contracts";
import { invokeProvider, streamProvider } from "./index.ts";
import {
  OllamaConfigurationError,
  OllamaLocalAdapter,
  type OllamaAvailabilitySnapshot,
  type OllamaModelCandidate,
  type OllamaRuntimeSnapshot,
} from "./ollama.ts";

export const OLLAMA_LIVE_EVIDENCE_VERSION = "ollama-live-evidence.v2";
export const OLLAMA_LIVE_PRIMARY_MODEL = "gemma4:12b-mlx";
export const OLLAMA_LIVE_COMPARISON_MODEL = "llama3.1:8b";
export const OLLAMA_LIVE_APPROVED_MODELS = Object.freeze([
  OLLAMA_LIVE_PRIMARY_MODEL,
  OLLAMA_LIVE_COMPARISON_MODEL,
] as const);

const SYNTHETIC_PROMPT = "Reply with the single word READY.";
const CONFIGURATION_VERSION = "ollama-live-config.v2" as const;
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_PROBE_MS = 10;

export interface OllamaLiveResourceSample {
  readonly status: "MEASURED" | "NOT_AVAILABLE" | "INTERRUPTED";
  readonly memoryAvailablePercent?: number;
  readonly swapUsedBytes?: number;
  readonly ollamaProcessMemoryBytes?: number;
}

export type OllamaLiveResourceSampler = (
  signal: AbortSignal,
) => OllamaLiveResourceSample | Promise<OllamaLiveResourceSample>;

export interface OllamaLiveTestEvidence {
  readonly test: string;
  readonly status: "PASS" | "FAIL";
  readonly provider: "LOCAL";
  readonly selectedModel?: string;
  readonly actualModel?: string;
  readonly digest?: `sha256:${string}`;
  readonly latencyMs?: number;
  readonly firstOutputMs?: number;
  readonly loadState?: "COLD" | "WARM" | "UNKNOWN";
  readonly residency?: string;
  readonly deltaCount?: number;
  readonly outcome?: string;
  readonly transitions?: readonly string[];
  readonly resources?: OllamaLiveResourceSample;
}

export interface OllamaLiveEvidence {
  readonly contractVersion: typeof OLLAMA_LIVE_EVIDENCE_VERSION;
  readonly status: "PASS" | "FAIL" | "NOT_RUN";
  readonly summary: string;
  readonly runtime?: OllamaRuntimeSnapshot;
  readonly preflight?: OllamaAvailabilitySnapshot;
  readonly tests: readonly OllamaLiveTestEvidence[];
  readonly cleanup: {
    readonly status: "PASS" | "FAIL" | "NOT_RUN";
    readonly unloadedModelCount: number;
    readonly residentModelCount?: number;
    readonly outcome?: string;
  };
}

export interface OllamaLiveHarnessOptions {
  readonly confirmed: boolean;
  readonly endpoint?: string;
  readonly operationTimeoutMs?: number;
  readonly controlTimeoutMs?: number;
  readonly timeoutProbeMs?: number;
  readonly sampleResources?: OllamaLiveResourceSampler;
}

class HarnessStop extends Error {}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (
    !Number.isSafeInteger(selected) ||
    selected < minimum ||
    selected > maximum
  ) {
    throw new OllamaConfigurationError(`${label} must be a bounded integer.`);
  }
  return selected;
}

function loopbackEndpoint(value: string | undefined): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value ?? "http://127.0.0.1:11434");
  } catch {
    throw new OllamaConfigurationError(
      "The live harness endpoint must be a valid loopback URL.",
    );
  }
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isIpv4Loopback = /^127(?:\.[0-9]{1,3}){3}$/.test(hostname);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    !(hostname === "localhost" || hostname === "::1" || isIpv4Loopback) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["", "/"].includes(endpoint.pathname)
  ) {
    throw new OllamaConfigurationError(
      "The live harness endpoint must be credential-free and loopback-only.",
    );
  }
  endpoint.pathname = "/";
  return endpoint.toString();
}

function candidates(): readonly OllamaModelCandidate[] {
  return OLLAMA_LIVE_APPROVED_MODELS.map((model) => ({
    model,
    contextTokens: 4_096,
    maxInputBytes: 4_096,
    maxOutputTokens: 128,
    maxOutputBytes: 8_192,
    keepAliveSeconds: 60,
  }));
}

function safeResourceSample(value: unknown): OllamaLiveResourceSample {
  if (!value || typeof value !== "object") return { status: "INTERRUPTED" };
  const sample = value as Partial<OllamaLiveResourceSample>;
  if (
    sample.status !== "MEASURED" &&
    sample.status !== "NOT_AVAILABLE" &&
    sample.status !== "INTERRUPTED"
  ) {
    return { status: "INTERRUPTED" };
  }
  if (sample.status !== "MEASURED") return { status: sample.status };
  const integer = (entry: unknown) =>
    Number.isSafeInteger(entry) && Number(entry) >= 0
      ? Number(entry)
      : undefined;
  const percent = integer(sample.memoryAvailablePercent);
  const swap = integer(sample.swapUsedBytes);
  const processMemory = integer(sample.ollamaProcessMemoryBytes);
  if (
    (percent !== undefined && percent > 100) ||
    (percent === undefined && swap === undefined && processMemory === undefined)
  ) {
    return { status: "INTERRUPTED" };
  }
  return {
    status: "MEASURED",
    ...(percent === undefined ? {} : { memoryAvailablePercent: percent }),
    ...(swap === undefined ? {} : { swapUsedBytes: swap }),
    ...(processMemory === undefined
      ? {}
      : { ollamaProcessMemoryBytes: processMemory }),
  };
}

async function sample(
  sampler: OllamaLiveResourceSampler | undefined,
  signal: AbortSignal,
): Promise<OllamaLiveResourceSample> {
  if (!sampler) return { status: "NOT_AVAILABLE" };
  try {
    if (signal.aborted) return { status: "INTERRUPTED" };
    return safeResourceSample(await sampler(signal));
  } catch {
    return { status: "INTERRUPTED" };
  }
}

function configuration() {
  const reference = "ollama-live-harness";
  const digest = createHash("sha256")
    .update(`${reference}:${CONFIGURATION_VERSION}`)
    .digest("hex");
  return {
    reference,
    version: CONFIGURATION_VERSION,
    digest: `sha256:${digest}` as const,
  };
}

function policy(model: string) {
  const digest = createHash("sha256")
    .update(`ollama-live:${model}`)
    .digest("hex");
  return {
    contractVersion: "provider-policy-decision.v1" as const,
    providerPolicyVersion: "provider-eligibility.v1" as const,
    capabilityDecision: {
      contractVersion: "capability-decision.v1" as const,
      decisionRef: `decision-live-${model.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      evaluatedContextDigest: `sha256:${digest}` as const,
      policyVersion: "teaching-policy.v1" as const,
      classificationVersion: "data-classification.v1" as const,
      retentionPolicyVersion: "retention-policy.v1" as const,
      gradingBoundaryVersion: "grading-boundary.v1" as const,
      targetProvider: "LOCAL" as const,
      targetModel: model,
      allowed: true as const,
      reasonCodes: ["EXPLICIT_ALLOW"] as const,
      constraints: {
        localOnly: true,
        noFallback: true,
        minimizedContentRequired: false,
      } as const,
      recheckOn: ["PROVIDER_OR_MODEL_CHANGE", "POLICY_VERSION_CHANGE"] as const,
    },
  };
}

let requestSequence = 0;
function providerRequest(model: string, timeoutMs: number): ProviderRequest {
  requestSequence += 1;
  const suffix = `${model.replaceAll(":", "-")}-${requestSequence}`;
  return {
    contractVersion: "provider-request.v1",
    runRef: `run-live-${suffix}`,
    attempt: {
      kind: "INITIAL",
      attemptRef: `attempt-live-${suffix}`,
      ordinal: 1,
    },
    selection: { provider: "LOCAL", model },
    input: { messages: [{ role: "USER", content: SYNTHETIC_PROMPT }] },
    generation: { maxOutputTokens: 32, temperature: 0, topP: 0.9 },
    timeoutMs,
    cancellationRef: `cancellation-live-${suffix}`,
    policy: policy(model),
    configuration: configuration(),
  };
}

function outcomeEvidence(
  test: string,
  selectedModel: string,
  result: ProviderOutcome,
  resources: OllamaLiveResourceSample,
): OllamaLiveTestEvidence {
  if (result.status !== "COMPLETED") {
    return {
      test,
      status: "FAIL",
      provider: "LOCAL",
      selectedModel,
      latencyMs: result.latency.totalMs,
      outcome: result.error.code,
      resources,
    };
  }
  const local = result.provenance.local;
  return {
    test,
    status: "PASS",
    provider: "LOCAL",
    selectedModel,
    actualModel: result.identity.actual.model.id,
    ...(result.identity.actual.model.digest === undefined
      ? {}
      : { digest: result.identity.actual.model.digest }),
    latencyMs: result.latency.totalMs,
    ...(result.latency.firstOutputMs === undefined
      ? {}
      : { firstOutputMs: result.latency.firstOutputMs }),
    ...(local?.loadState === undefined ? {} : { loadState: local.loadState }),
    ...(local?.residency === undefined ? {} : { residency: local.residency }),
    outcome: result.finishReason,
    resources,
  };
}

function terminal(events: readonly ProviderStreamEvent[]) {
  return events.findLast((event) =>
    ["COMPLETED", "FAILED", "CANCELLED"].includes(event.type),
  );
}

function requirePass(evidence: OllamaLiveTestEvidence): void {
  if (evidence.status !== "PASS") throw new HarnessStop();
}

async function invokeEvidence(
  adapter: OllamaLocalAdapter,
  model: string,
  test: string,
  timeoutMs: number,
  sampler: OllamaLiveResourceSampler | undefined,
): Promise<OllamaLiveTestEvidence> {
  const controller = new AbortController();
  const result = await invokeProvider(
    adapter,
    providerRequest(model, timeoutMs),
    { signal: controller.signal },
  );
  return outcomeEvidence(
    test,
    model,
    result,
    await sample(sampler, controller.signal),
  );
}

async function streamEvidence(
  adapter: OllamaLocalAdapter,
  model: string,
  test: string,
  timeoutMs: number,
  sampler: OllamaLiveResourceSampler | undefined,
): Promise<OllamaLiveTestEvidence> {
  const controller = new AbortController();
  const events: ProviderStreamEvent[] = [];
  for await (const event of streamProvider(
    adapter,
    providerRequest(model, timeoutMs),
    { signal: controller.signal },
  )) {
    events.push(event);
  }
  const final = terminal(events);
  const deltaCount = events.filter(
    (event) => event.type === "CONTENT_DELTA",
  ).length;
  const resources = await sample(sampler, controller.signal);
  if (!final || final.type !== "COMPLETED" || deltaCount < 1) {
    return {
      test,
      status: "FAIL",
      provider: "LOCAL",
      selectedModel: model,
      deltaCount,
      outcome:
        final && "result" in final
          ? final.result.status === "COMPLETED"
            ? final.result.finishReason
            : final.result.error.code
          : "MISSING_TERMINAL",
      resources,
    };
  }
  return {
    ...outcomeEvidence(test, model, final.result, resources),
    deltaCount,
  };
}

async function cancellationEvidence(
  adapter: OllamaLocalAdapter,
  model: string,
  test: string,
  timeoutMs: number,
  sampler: OllamaLiveResourceSampler | undefined,
): Promise<OllamaLiveTestEvidence> {
  const controller = new AbortController();
  const events: ProviderStreamEvent[] = [];
  for await (const event of streamProvider(
    adapter,
    providerRequest(model, timeoutMs),
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
    final?.type === "CANCELLED" &&
    final.result.status === "CANCELLED" &&
    final.result.error.code === "CANCELLED" &&
    !events.some((event) => event.type === "COMPLETED");
  return {
    test,
    status: passed ? "PASS" : "FAIL",
    provider: "LOCAL",
    selectedModel: model,
    deltaCount,
    outcome:
      final && "result" in final && final.result.status !== "COMPLETED"
        ? final.result.error.code
        : "TRUSTED_COMPLETION",
    resources: await sample(sampler, new AbortController().signal),
  };
}

export async function runOllamaLiveHarness(
  options: OllamaLiveHarnessOptions,
): Promise<OllamaLiveEvidence> {
  if (!options.confirmed) {
    return {
      contractVersion: OLLAMA_LIVE_EVIDENCE_VERSION,
      status: "NOT_RUN",
      summary: "Live Ollama validation was not explicitly confirmed.",
      tests: [],
      cleanup: { status: "NOT_RUN", unloadedModelCount: 0 },
    };
  }

  const endpoint = loopbackEndpoint(options.endpoint);
  const operationTimeoutMs = boundedInteger(
    options.operationTimeoutMs,
    DEFAULT_OPERATION_TIMEOUT_MS,
    1_000,
    120_000,
    "Operation timeout",
  );
  const controlTimeoutMs = boundedInteger(
    options.controlTimeoutMs,
    DEFAULT_CONTROL_TIMEOUT_MS,
    1_000,
    120_000,
    "Control timeout",
  );
  const timeoutProbeMs = boundedInteger(
    options.timeoutProbeMs,
    DEFAULT_TIMEOUT_PROBE_MS,
    1,
    1_000,
    "Timeout probe",
  );
  const initialController = new AbortController();
  const baseline = await sample(
    options.sampleResources,
    initialController.signal,
  );
  const baselineSwap = baseline.swapUsedBytes;
  const adapter = new OllamaLocalAdapter({
    endpoint,
    configuration: configuration(),
    candidates: candidates(),
    selectedModel: OLLAMA_LIVE_PRIMARY_MODEL,
    maxResidentModels: 1,
    maxConcurrentRequests: 1,
    measureResources: async (signal): Promise<LocalResourceMetadata> => {
      const measured = await sample(options.sampleResources, signal);
      if (measured.status !== "MEASURED") return { status: measured.status };
      const processMemoryBytes = measured.ollamaProcessMemoryBytes;
      const swapDeltaBytes =
        measured.swapUsedBytes === undefined || baselineSwap === undefined
          ? undefined
          : Math.max(0, measured.swapUsedBytes - baselineSwap);
      if (processMemoryBytes === undefined && swapDeltaBytes === undefined) {
        return { status: "NOT_AVAILABLE" };
      }
      return {
        status: "MEASURED",
        ...(processMemoryBytes === undefined ? {} : { processMemoryBytes }),
        ...(swapDeltaBytes === undefined ? {} : { swapDeltaBytes }),
      };
    },
  });
  const tests: OllamaLiveTestEvidence[] = [];
  let runtime: OllamaRuntimeSnapshot | undefined;
  let preflight: OllamaAvailabilitySnapshot | undefined;
  let stopped = false;
  let cleanup: OllamaLiveEvidence["cleanup"] = {
    status: "NOT_RUN",
    unloadedModelCount: 0,
  };

  try {
    runtime = await adapter.inspectRuntime(
      { signal: initialController.signal },
      controlTimeoutMs,
    );
    preflight = await adapter.inspectAvailability(
      { signal: initialController.signal },
      controlTimeoutMs,
    );
    const installed = preflight.models.filter((model) => model.installed);
    const preflightPassed =
      runtime.status === "AVAILABLE" &&
      installed.length === OLLAMA_LIVE_APPROVED_MODELS.length &&
      preflight.onePrimaryResidencySafe;
    const preflightEvidence: OllamaLiveTestEvidence = {
      test: "preflight",
      status: preflightPassed ? "PASS" : "FAIL",
      provider: "LOCAL",
      selectedModel: preflight.selectedModel,
      residency: preflight.state,
      outcome: preflightPassed
        ? "APPROVED_MODELS_AVAILABLE"
        : runtime.status !== "AVAILABLE"
          ? (runtime.error?.code ?? "RUNTIME_UNAVAILABLE")
          : "MODEL_OR_RESIDENCY_UNAVAILABLE",
      resources: baseline,
    };
    tests.push(preflightEvidence);
    requirePass(preflightEvidence);

    const initialUnload = await adapter.unloadApprovedModels(
      { signal: initialController.signal },
      controlTimeoutMs,
    );
    const initialUnloadEvidence: OllamaLiveTestEvidence = {
      test: "initial-clean-state",
      status: initialUnload.status === "UNLOADED" ? "PASS" : "FAIL",
      provider: "LOCAL",
      selectedModel: adapter.selectedModel,
      transitions: initialUnload.transitions,
      outcome: initialUnload.error?.code ?? initialUnload.status,
      resources: await sample(
        options.sampleResources,
        initialController.signal,
      ),
    };
    tests.push(initialUnloadEvidence);
    requirePass(initialUnloadEvidence);

    for (const [test, model] of [
      ["primary-cold-non-stream", OLLAMA_LIVE_PRIMARY_MODEL],
      ["primary-warm-non-stream", OLLAMA_LIVE_PRIMARY_MODEL],
    ] as const) {
      const evidence = await invokeEvidence(
        adapter,
        model,
        test,
        operationTimeoutMs,
        options.sampleResources,
      );
      tests.push(evidence);
      requirePass(evidence);
    }

    for (const operation of [
      () =>
        streamEvidence(
          adapter,
          OLLAMA_LIVE_PRIMARY_MODEL,
          "primary-stream",
          operationTimeoutMs,
          options.sampleResources,
        ),
      () =>
        cancellationEvidence(
          adapter,
          OLLAMA_LIVE_PRIMARY_MODEL,
          "primary-cancellation",
          operationTimeoutMs,
          options.sampleResources,
        ),
    ]) {
      const evidence = await operation();
      tests.push(evidence);
      requirePass(evidence);
    }

    const timeoutResult = await invokeProvider(
      adapter,
      providerRequest(OLLAMA_LIVE_PRIMARY_MODEL, timeoutProbeMs),
      { signal: new AbortController().signal },
    );
    const timeoutEvidence: OllamaLiveTestEvidence = {
      test: "primary-timeout",
      status:
        timeoutResult.status === "FAILED" &&
        timeoutResult.error.code === "TIMEOUT"
          ? "PASS"
          : "FAIL",
      provider: "LOCAL",
      selectedModel: OLLAMA_LIVE_PRIMARY_MODEL,
      latencyMs: timeoutResult.latency.totalMs,
      outcome:
        timeoutResult.status === "COMPLETED"
          ? "TRUSTED_COMPLETION"
          : timeoutResult.error.code,
      resources: await sample(
        options.sampleResources,
        new AbortController().signal,
      ),
    };
    tests.push(timeoutEvidence);
    requirePass(timeoutEvidence);

    const toComparison = await adapter.switchModel(
      OLLAMA_LIVE_COMPARISON_MODEL,
      { signal: new AbortController().signal },
      controlTimeoutMs,
    );
    const comparisonSwitchEvidence: OllamaLiveTestEvidence = {
      test: "switch-primary-to-comparison",
      status: toComparison.status === "SWITCHED" ? "PASS" : "FAIL",
      provider: "LOCAL",
      selectedModel: toComparison.selectedModel,
      ...(toComparison.digest === undefined
        ? {}
        : { digest: toComparison.digest }),
      transitions: toComparison.transitions,
      outcome: toComparison.error?.code ?? toComparison.status,
      resources: await sample(
        options.sampleResources,
        new AbortController().signal,
      ),
    };
    tests.push(comparisonSwitchEvidence);
    requirePass(comparisonSwitchEvidence);

    for (const operation of [
      () =>
        invokeEvidence(
          adapter,
          OLLAMA_LIVE_COMPARISON_MODEL,
          "comparison-non-stream",
          operationTimeoutMs,
          options.sampleResources,
        ),
      () =>
        streamEvidence(
          adapter,
          OLLAMA_LIVE_COMPARISON_MODEL,
          "comparison-stream",
          operationTimeoutMs,
          options.sampleResources,
        ),
      () =>
        cancellationEvidence(
          adapter,
          OLLAMA_LIVE_COMPARISON_MODEL,
          "comparison-cancellation",
          operationTimeoutMs,
          options.sampleResources,
        ),
    ]) {
      const evidence = await operation();
      tests.push(evidence);
      requirePass(evidence);
    }

    const toPrimary = await adapter.switchModel(
      OLLAMA_LIVE_PRIMARY_MODEL,
      { signal: new AbortController().signal },
      controlTimeoutMs,
    );
    const primarySwitchEvidence: OllamaLiveTestEvidence = {
      test: "switch-comparison-to-primary",
      status: toPrimary.status === "SWITCHED" ? "PASS" : "FAIL",
      provider: "LOCAL",
      selectedModel: toPrimary.selectedModel,
      ...(toPrimary.digest === undefined ? {} : { digest: toPrimary.digest }),
      transitions: toPrimary.transitions,
      outcome: toPrimary.error?.code ?? toPrimary.status,
      resources: await sample(
        options.sampleResources,
        new AbortController().signal,
      ),
    };
    tests.push(primarySwitchEvidence);
    requirePass(primarySwitchEvidence);
  } catch (error) {
    stopped = true;
    if (!(error instanceof HarnessStop)) {
      tests.push({
        test: "harness-internal",
        status: "FAIL",
        provider: "LOCAL",
        outcome:
          error instanceof Error && /^[A-Za-z]+Error$/.test(error.name)
            ? error.name
            : "BOUNDED_INTERNAL_FAILURE",
      });
    }
  } finally {
    const unload = await adapter.unloadApprovedModels(
      { signal: new AbortController().signal },
      controlTimeoutMs,
    );
    const after = await adapter.inspectAvailability(
      { signal: new AbortController().signal },
      controlTimeoutMs,
    );
    cleanup = {
      status:
        unload.status === "UNLOADED" &&
        after.error === undefined &&
        after.onePrimaryResidencySafe &&
        after.residentModels === 0
          ? "PASS"
          : "FAIL",
      unloadedModelCount: unload.unloadedModels.length,
      residentModelCount: after.residentModels,
      outcome: unload.error?.code ?? unload.status,
    };
  }

  const failed =
    stopped ||
    tests.some((entry) => entry.status === "FAIL") ||
    cleanup.status !== "PASS";
  const passedCount = tests.filter((entry) => entry.status === "PASS").length;
  return {
    contractVersion: OLLAMA_LIVE_EVIDENCE_VERSION,
    status: failed ? "FAIL" : "PASS",
    summary: `${passedCount}/${tests.length} bounded live checks passed; cleanup ${cleanup.status}.`,
    ...(runtime === undefined ? {} : { runtime }),
    ...(preflight === undefined ? {} : { preflight }),
    tests,
    cleanup,
  };
}
