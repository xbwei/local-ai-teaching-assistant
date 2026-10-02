import type {
  LocalModelResidency,
  LocalResourceMetadata,
  ModelIdentity,
  ProviderAdapter,
  ProviderErrorCode,
  ProviderExecutionContext,
  ProviderFailure,
  ProviderIdentity,
  ProviderOutcome,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderSuccess,
  ProviderUsage,
} from "@laita/contracts";

const ADAPTER_VERSION = "ollama-local.v1";
const MAX_CONTROL_RESPONSE_BYTES = 1024 * 1024;
const MAX_STREAM_EVENT_BYTES = 256 * 1024;
const TEXT_ENCODER = new TextEncoder();

export interface OllamaModelCandidate {
  readonly model: string;
  readonly contextTokens: number;
  readonly maxInputBytes: number;
  readonly maxOutputTokens: number;
  readonly maxOutputBytes: number;
  readonly keepAliveSeconds: number;
}

export interface OllamaAdapterOptions {
  readonly endpoint: string;
  readonly configuration: ProviderRequest["configuration"];
  readonly candidates: readonly OllamaModelCandidate[];
  readonly selectedModel: string;
  readonly maxMessages?: number;
  readonly maxMessageBytes?: number;
  readonly maxResidentModels?: 1;
  readonly maxConcurrentRequests?: 1;
  readonly measureResources?: (
    signal: AbortSignal,
  ) => LocalResourceMetadata | Promise<LocalResourceMetadata>;
}

export interface OllamaModelStatus {
  readonly model: string;
  readonly installed: boolean;
  readonly digest?: `sha256:${string}`;
  readonly residency: LocalModelResidency;
  readonly sizeBytes?: number;
  readonly sizeVramBytes?: number;
  readonly contextLength?: number;
}

export interface OllamaAvailabilitySnapshot {
  readonly provider: "LOCAL";
  readonly runtime: "OLLAMA";
  readonly selectedModel: string;
  readonly state: LocalModelResidency;
  readonly models: readonly OllamaModelStatus[];
  readonly residentModels: number;
  readonly residentApprovedModels: number;
  readonly onePrimaryResidencySafe: boolean;
  readonly error?: {
    readonly code: ProviderErrorCode;
    readonly message: string;
  };
}

export interface OllamaModelSwitchResult {
  readonly status: "SWITCHED" | "FAILED" | "CANCELLED";
  readonly previousModel: string;
  readonly selectedModel: string;
  readonly transitions: readonly LocalModelResidency[];
  readonly digest?: `sha256:${string}`;
  readonly error?: {
    readonly code: ProviderErrorCode;
    readonly message: string;
  };
}

export interface OllamaRuntimeSnapshot {
  readonly provider: "LOCAL";
  readonly runtime: "OLLAMA";
  readonly status: "AVAILABLE" | "UNAVAILABLE";
  readonly version?: string;
  readonly error?: {
    readonly code: ProviderErrorCode;
    readonly message: string;
  };
}

export interface OllamaUnloadResult {
  readonly status: "UNLOADED" | "FAILED" | "CANCELLED";
  readonly unloadedModels: readonly string[];
  readonly transitions: readonly LocalModelResidency[];
  readonly error?: {
    readonly code: ProviderErrorCode;
    readonly message: string;
  };
}

export class OllamaConfigurationError extends Error {
  override readonly name = "OllamaConfigurationError";
}

class OllamaProtocolError extends Error {
  override readonly name = "OllamaProtocolError";
}

class OllamaHttpError extends Error {
  override readonly name = "OllamaHttpError";
  constructor(
    readonly status: number,
    readonly providerMessage: string,
  ) {
    super("Ollama returned an unsuccessful response.");
  }
}

interface RequestControl {
  readonly signal: AbortSignal;
  readonly cause: () => "CALLER" | "TIMEOUT" | undefined;
  readonly abortTransport: () => void;
  readonly cleanup: () => void;
}

interface ModelRecord {
  readonly model: string;
  readonly digest?: string;
  readonly size?: number;
  readonly size_vram?: number;
  readonly context_length?: number;
}

interface Preflight {
  readonly digest?: `sha256:${string}`;
  readonly residency: "WARM" | "UNLOADED";
}

interface ChatResponse {
  readonly model: string;
  readonly message: { readonly role: string; readonly content: string };
  readonly done: true;
  readonly done_reason?: string;
  readonly total_duration?: number;
  readonly load_duration?: number;
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function safeDigest(value: unknown): `sha256:${string}` | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ? `sha256:${value}`
    : undefined;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [first, second] = parts as [number, number, number, number];
  return (
    first === 127 ||
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    isPrivateIpv4(host) ||
    /^f[cd][0-9a-f]*:/i.test(host) ||
    /^fe[89ab][0-9a-f]*:/i.test(host)
  );
}

function validatedEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new OllamaConfigurationError("Ollama endpoint must be a valid URL.");
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    !isPrivateHost(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["", "/"].includes(endpoint.pathname)
  ) {
    throw new OllamaConfigurationError(
      "Ollama endpoint must be a credential-free loopback or private base URL.",
    );
  }
  endpoint.pathname = "/";
  return endpoint;
}

function validatedCandidates(
  candidates: readonly OllamaModelCandidate[],
): Map<string, OllamaModelCandidate> {
  const approved = new Map<string, OllamaModelCandidate>();
  for (const candidate of candidates) {
    if (
      !nonEmpty(candidate.model) ||
      candidate.model.length > 200 ||
      !nonNegativeInteger(candidate.contextTokens) ||
      candidate.contextTokens < 1 ||
      candidate.contextTokens > 131_072 ||
      !nonNegativeInteger(candidate.maxInputBytes) ||
      candidate.maxInputBytes < 1 ||
      candidate.maxInputBytes > 4 * 1024 * 1024 ||
      !nonNegativeInteger(candidate.maxOutputTokens) ||
      candidate.maxOutputTokens < 1 ||
      candidate.maxOutputTokens > candidate.contextTokens ||
      !nonNegativeInteger(candidate.maxOutputBytes) ||
      candidate.maxOutputBytes < 1 ||
      candidate.maxOutputBytes > 4 * 1024 * 1024 ||
      !nonNegativeInteger(candidate.keepAliveSeconds) ||
      candidate.keepAliveSeconds > 86_400 ||
      approved.has(candidate.model)
    ) {
      throw new OllamaConfigurationError(
        "Ollama model candidates must be unique and bounded.",
      );
    }
    approved.set(candidate.model, Object.freeze({ ...candidate }));
  }
  if (approved.size === 0) {
    throw new OllamaConfigurationError(
      "At least one approved Ollama model candidate is required.",
    );
  }
  return approved;
}

function createControl(
  context: ProviderExecutionContext,
  timeoutMs: number,
): RequestControl {
  const controller = new AbortController();
  let cause: "CALLER" | "TIMEOUT" | undefined;
  const abortFromCaller = () => {
    if (!cause) cause = "CALLER";
    controller.abort();
  };
  if (context.signal.aborted) abortFromCaller();
  context.signal.addEventListener?.("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    if (!cause) cause = "TIMEOUT";
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    cause: () => cause,
    abortTransport: () => controller.abort(),
    cleanup: () => {
      clearTimeout(timer);
      context.signal.removeEventListener?.("abort", abortFromCaller);
    },
  };
}

async function readBoundedText(
  response: Response,
  limit: number,
): Promise<string> {
  if (!response.body) throw new OllamaProtocolError("Missing response body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new OllamaProtocolError("Provider response exceeded its bound.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new OllamaProtocolError("Provider returned malformed JSON.");
  }
}

function providerErrorMessage(body: unknown): string {
  if (
    body &&
    typeof body === "object" &&
    nonEmpty((body as { error?: unknown }).error)
  ) {
    return (body as { error: string }).error;
  }
  return "";
}

function mapError(
  error: unknown,
  cause?: "CALLER" | "TIMEOUT",
): {
  readonly status: "FAILED" | "CANCELLED";
  readonly code: ProviderErrorCode;
  readonly source: "CALLER" | "PROVIDER" | "CONTRACT";
  readonly retry: "SAME_PROVIDER_ONLY" | "DO_NOT_RETRY";
  readonly message: string;
} {
  if (cause === "CALLER") {
    return {
      status: "CANCELLED",
      code: "CANCELLED",
      source: "CALLER",
      retry: "DO_NOT_RETRY",
      message: "The Local AI request was cancelled.",
    };
  }
  if (cause === "TIMEOUT") {
    return {
      status: "FAILED",
      code: "TIMEOUT",
      source: "PROVIDER",
      retry: "SAME_PROVIDER_ONLY",
      message: "The Local AI request timed out.",
    };
  }
  if (error instanceof OllamaProtocolError) {
    return {
      status: "FAILED",
      code: "MALFORMED_PROVIDER_RESPONSE",
      source: "PROVIDER",
      retry: "DO_NOT_RETRY",
      message: "Ollama returned a malformed response.",
    };
  }
  if (error instanceof OllamaHttpError) {
    const detail = error.providerMessage.toLowerCase();
    if (error.status === 401 || error.status === 403) {
      return {
        status: "FAILED",
        code: "PROVIDER_AUTHENTICATION_FAILED",
        source: "PROVIDER",
        retry: "DO_NOT_RETRY",
        message: "Ollama authentication failed.",
      };
    }
    if (error.status === 429) {
      return {
        status: "FAILED",
        code: "RATE_LIMITED",
        source: "PROVIDER",
        retry: "SAME_PROVIDER_ONLY",
        message: "Ollama rate-limited the request.",
      };
    }
    if (error.status === 507) {
      return {
        status: "FAILED",
        code: "QUOTA_EXCEEDED",
        source: "PROVIDER",
        retry: "DO_NOT_RETRY",
        message: "Ollama has insufficient local capacity.",
      };
    }
    if ([502, 503, 504].includes(error.status)) {
      return {
        status: "FAILED",
        code: "PROVIDER_UNAVAILABLE",
        source: "PROVIDER",
        retry: "SAME_PROVIDER_ONLY",
        message: "The Local AI service is unavailable.",
      };
    }
    if (error.status === 404 || /model.+(not found|missing)/.test(detail)) {
      return {
        status: "FAILED",
        code: "PROVIDER_UNAVAILABLE",
        source: "PROVIDER",
        retry: "DO_NOT_RETRY",
        message: "The selected Local AI model is unavailable.",
      };
    }
    if (/load|loading|busy/.test(detail) || error.status === 409) {
      return {
        status: "FAILED",
        code: "PROVIDER_BUSY",
        source: "PROVIDER",
        retry: "SAME_PROVIDER_ONLY",
        message: "The selected Local AI model is loading or busy.",
      };
    }
    return {
      status: "FAILED",
      code:
        error.status >= 500
          ? "INTERNAL_PROVIDER_FAILURE"
          : "MALFORMED_PROVIDER_RESPONSE",
      source: "PROVIDER",
      retry: error.status >= 500 ? "SAME_PROVIDER_ONLY" : "DO_NOT_RETRY",
      message:
        error.status >= 500
          ? "Ollama reported a server error."
          : "Ollama rejected the request.",
    };
  }
  return {
    status: "FAILED",
    code: "PROVIDER_UNAVAILABLE",
    source: "PROVIDER",
    retry: "SAME_PROVIDER_ONLY",
    message: "The Local AI service is unavailable.",
  };
}

function modelRecords(value: unknown): ModelRecord[] {
  if (!value || typeof value !== "object") {
    throw new OllamaProtocolError("Model inventory was not an object.");
  }
  const models = (value as { models?: unknown }).models;
  if (!Array.isArray(models)) {
    throw new OllamaProtocolError("Model inventory was not an array.");
  }
  const records = models.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new OllamaProtocolError("Model inventory contained an entry.");
    }
    const record = entry as Record<string, unknown>;
    const model = nonEmpty(record.model)
      ? record.model
      : nonEmpty(record.name)
        ? record.name
        : undefined;
    if (!model) throw new OllamaProtocolError("Model identity was missing.");
    if (
      record.digest !== undefined &&
      safeDigest(record.digest) === undefined
    ) {
      throw new OllamaProtocolError("Model digest was malformed.");
    }
    for (const field of ["size", "size_vram", "context_length"] as const) {
      if (record[field] !== undefined && !nonNegativeInteger(record[field])) {
        throw new OllamaProtocolError("Model metadata was malformed.");
      }
    }
    return {
      model,
      ...(typeof record.digest === "string" ? { digest: record.digest } : {}),
      ...(typeof record.size === "number" ? { size: record.size } : {}),
      ...(typeof record.size_vram === "number"
        ? { size_vram: record.size_vram }
        : {}),
      ...(typeof record.context_length === "number"
        ? { context_length: record.context_length }
        : {}),
    };
  });
  if (new Set(records.map(({ model }) => model)).size !== records.length) {
    throw new OllamaProtocolError(
      "Model inventory contained duplicate models.",
    );
  }
  return records;
}

function chatResponse(value: unknown): ChatResponse {
  if (!value || typeof value !== "object") {
    throw new OllamaProtocolError("Chat response was not an object.");
  }
  const response = value as Record<string, unknown>;
  const message = response.message as Record<string, unknown> | undefined;
  if (
    !nonEmpty(response.model) ||
    response.done !== true ||
    !message ||
    message.role !== "assistant" ||
    typeof message.content !== "string"
  ) {
    throw new OllamaProtocolError("Chat response fields were malformed.");
  }
  for (const field of [
    "total_duration",
    "load_duration",
    "prompt_eval_count",
    "eval_count",
  ] as const) {
    if (response[field] !== undefined && !nonNegativeInteger(response[field])) {
      throw new OllamaProtocolError("Chat usage fields were malformed.");
    }
  }
  if (
    response.done_reason !== undefined &&
    !["stop", "length"].includes(String(response.done_reason))
  ) {
    throw new OllamaProtocolError("Chat finish reason was unknown.");
  }
  return response as unknown as ChatResponse;
}

function runtimeVersion(value: unknown): string {
  const version =
    value && typeof value === "object"
      ? (value as Record<string, unknown>).version
      : undefined;
  if (
    typeof version !== "string" ||
    version.length < 1 ||
    version.length > 64 ||
    !/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(version)
  ) {
    throw new OllamaProtocolError("Ollama runtime version was malformed.");
  }
  return version;
}

export class OllamaLocalAdapter implements ProviderAdapter {
  readonly provider = "LOCAL" as const;
  readonly configuration: ProviderRequest["configuration"];
  readonly #endpoint: URL;
  readonly #candidates: Map<string, OllamaModelCandidate>;
  readonly #maxMessages: number;
  readonly #maxMessageBytes: number;
  readonly #measureResources?: OllamaAdapterOptions["measureResources"];
  #selectedModel: string;
  #state: LocalModelResidency = "UNLOADED";
  #active = false;

  constructor(options: OllamaAdapterOptions) {
    if (
      options.maxResidentModels !== undefined &&
      options.maxResidentModels !== 1
    ) {
      throw new OllamaConfigurationError(
        "Ollama adapter supports exactly one resident primary model.",
      );
    }
    if (
      options.maxConcurrentRequests !== undefined &&
      options.maxConcurrentRequests !== 1
    ) {
      throw new OllamaConfigurationError(
        "Ollama adapter supports exactly one active generation.",
      );
    }
    this.#endpoint = validatedEndpoint(options.endpoint);
    this.#candidates = validatedCandidates(options.candidates);
    if (!this.#candidates.has(options.selectedModel)) {
      throw new OllamaConfigurationError(
        "Selected Ollama model is not in the server-approved candidate set.",
      );
    }
    this.configuration = Object.freeze({ ...options.configuration });
    this.#selectedModel = options.selectedModel;
    this.#maxMessages = options.maxMessages ?? 32;
    this.#maxMessageBytes = options.maxMessageBytes ?? 64 * 1024;
    if (
      !nonNegativeInteger(this.#maxMessages) ||
      this.#maxMessages < 1 ||
      this.#maxMessages > 128 ||
      !nonNegativeInteger(this.#maxMessageBytes) ||
      this.#maxMessageBytes < 1 ||
      this.#maxMessageBytes > 1024 * 1024
    ) {
      throw new OllamaConfigurationError(
        "Ollama message limits must be positive and bounded.",
      );
    }
    this.#measureResources = options.measureResources;
  }

  get selectedModel(): string {
    return this.#selectedModel;
  }

  get state(): LocalModelResidency {
    return this.#state;
  }

  async #request(
    path: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    const url = new URL(path, this.#endpoint);
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      let providerMessage = "";
      if (response.body) {
        try {
          const text = await readBoundedText(
            response,
            MAX_CONTROL_RESPONSE_BYTES,
          );
          providerMessage = providerErrorMessage(
            text ? JSON.parse(text) : undefined,
          );
        } catch {
          // Error details are optional; the HTTP status remains authoritative.
        }
      }
      throw new OllamaHttpError(response.status, providerMessage);
    }
    return response;
  }

  async #json(
    path: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await this.#request(path, init, signal);
    return parseJson(
      await readBoundedText(response, MAX_CONTROL_RESPONSE_BYTES),
    );
  }

  async #generateControl(
    model: string,
    keepAliveSeconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    const value = await this.#json(
      "api/generate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          keep_alive: keepAliveSeconds,
          stream: false,
        }),
      },
      signal,
    );
    const message = providerErrorMessage(value);
    if (message) throw new OllamaHttpError(500, message);
    if (
      !value ||
      typeof value !== "object" ||
      (value as Record<string, unknown>).model !== model ||
      (value as Record<string, unknown>).done !== true
    ) {
      throw new OllamaProtocolError(
        "Ollama model load state response was malformed.",
      );
    }
  }

  async #inventories(signal: AbortSignal): Promise<{
    readonly installed: ModelRecord[];
    readonly running: ModelRecord[];
  }> {
    const [installed, running] = await Promise.all([
      this.#json("api/tags", { method: "GET" }, signal),
      this.#json("api/ps", { method: "GET" }, signal),
    ]);
    return {
      installed: modelRecords(installed),
      running: modelRecords(running),
    };
  }

  async #preflight(model: string, signal: AbortSignal): Promise<Preflight> {
    const { installed, running } = await this.#inventories(signal);
    const available = installed.find((entry) => entry.model === model);
    if (!available) {
      throw new OllamaHttpError(404, "model not found");
    }
    if (running.length > 1 || running.some((entry) => entry.model !== model)) {
      throw new OllamaHttpError(409, "another model is resident or busy");
    }
    const digest = safeDigest(available.digest);
    return {
      ...(digest === undefined ? {} : { digest }),
      residency: running.some((entry) => entry.model === model)
        ? "WARM"
        : "UNLOADED",
    };
  }

  #candidateFailure(
    request: ProviderRequest,
    startedAt: number,
    now: () => number,
  ): ProviderFailure | undefined {
    if (request.selection.provider !== "LOCAL") {
      return this.#failure(
        request,
        startedAt,
        {
          status: "FAILED",
          code: "CONTRACT_VIOLATION",
          source: "CONTRACT",
          retry: "DO_NOT_RETRY",
          message: "Ollama accepts only explicit Local provider requests.",
        },
        undefined,
        undefined,
        now,
      );
    }
    const candidate = this.#candidates.get(request.selection.model);
    if (!candidate) {
      return this.#failure(
        request,
        startedAt,
        {
          status: "FAILED",
          code: "CONTRACT_VIOLATION",
          source: "CONTRACT",
          retry: "DO_NOT_RETRY",
          message: "The selected Local AI model is not server-approved.",
        },
        undefined,
        undefined,
        now,
      );
    }
    if (request.selection.model !== this.#selectedModel) {
      return this.#failure(
        request,
        startedAt,
        {
          status: "FAILED",
          code: "PROVIDER_BUSY",
          source: "PROVIDER",
          retry: "DO_NOT_RETRY",
          message: "The approved model requires an explicit model switch.",
        },
        undefined,
        undefined,
        now,
      );
    }
    if (
      request.input.messages.length > this.#maxMessages ||
      request.input.messages.some(
        ({ content }) =>
          TEXT_ENCODER.encode(content).byteLength > this.#maxMessageBytes,
      ) ||
      TEXT_ENCODER.encode(JSON.stringify(request.input.messages)).byteLength >
        candidate.maxInputBytes ||
      request.generation.maxOutputTokens > candidate.maxOutputTokens
    ) {
      return this.#failure(
        request,
        startedAt,
        {
          status: "FAILED",
          code: "CONTRACT_VIOLATION",
          source: "CONTRACT",
          retry: "DO_NOT_RETRY",
          message: "The Local AI request exceeds its configured bounds.",
        },
        undefined,
        undefined,
        now,
      );
    }
    return undefined;
  }

  #identity(
    request: ProviderRequest,
    runtimeModel = request.selection.model,
    digest?: `sha256:${string}`,
  ): ProviderIdentity {
    const model: ModelIdentity = {
      id: runtimeModel,
      ...(digest === undefined ? {} : { digest }),
    };
    return {
      selected: request.selection,
      actual: { provider: "LOCAL", model },
    };
  }

  #failure(
    request: ProviderRequest,
    startedAt: number,
    error: ReturnType<typeof mapError>,
    partialText?: string,
    actual?: ProviderIdentity["actual"],
    now = Date.now,
  ): ProviderFailure {
    return {
      contractVersion: "provider-result.v1",
      status: error.status,
      runRef: request.runRef,
      attemptRef: request.attempt.attemptRef,
      selection: request.selection,
      ...(actual === undefined ? {} : { actual }),
      error: {
        code: error.code,
        source: error.source,
        retry: error.retry,
        message: error.message,
      },
      ...(partialText === undefined || partialText.length === 0
        ? {}
        : { partialOutput: { text: partialText, trusted: false as const } }),
      latency: { totalMs: Math.max(0, now() - startedAt) },
      policy: request.policy,
      configuration: request.configuration,
    };
  }

  async #resources(
    signal: AbortSignal,
  ): Promise<LocalResourceMetadata | undefined> {
    if (!this.#measureResources) return { status: "NOT_AVAILABLE" };
    const interrupted = Symbol("resource-measurement-interrupted");
    let removeAbortListener: (() => void) | undefined;
    try {
      const aborted = new Promise<typeof interrupted>((resolve) => {
        const onAbort = () => resolve(interrupted);
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () =>
          signal.removeEventListener("abort", onAbort);
        if (signal.aborted) resolve(interrupted);
      });
      const value = await Promise.race([
        Promise.resolve().then(() => this.#measureResources?.(signal)),
        aborted,
      ]);
      if (value === interrupted || value === undefined) {
        return { status: "INTERRUPTED" };
      }
      const hasMeasurement =
        value.processMemoryBytes !== undefined ||
        value.systemMemoryPressure !== undefined ||
        value.swapDeltaBytes !== undefined;
      if (
        !["MEASURED", "NOT_AVAILABLE", "INTERRUPTED"].includes(value.status) ||
        (value.status === "MEASURED" ? !hasMeasurement : hasMeasurement) ||
        [value.processMemoryBytes, value.swapDeltaBytes].some(
          (entry) =>
            entry !== undefined &&
            (!Number.isInteger(entry) || Number(entry) < 0),
        ) ||
        (value.systemMemoryPressure !== undefined &&
          !["NORMAL", "WARNING", "CRITICAL"].includes(
            value.systemMemoryPressure,
          ))
      ) {
        return { status: "INTERRUPTED" };
      }
      return {
        status: value.status,
        ...(value.processMemoryBytes === undefined
          ? {}
          : { processMemoryBytes: value.processMemoryBytes }),
        ...(value.systemMemoryPressure === undefined
          ? {}
          : { systemMemoryPressure: value.systemMemoryPressure }),
        ...(value.swapDeltaBytes === undefined
          ? {}
          : { swapDeltaBytes: value.swapDeltaBytes }),
      };
    } catch {
      return { status: "INTERRUPTED" };
    } finally {
      removeAbortListener?.();
    }
  }

  async #success(
    request: ProviderRequest,
    response: ChatResponse,
    preflight: Preflight,
    text: string,
    startedAt: number,
    firstOutputAt: number | undefined,
    now: () => number,
    signal: AbortSignal,
  ): Promise<ProviderSuccess> {
    if (response.model !== request.selection.model) {
      throw new OllamaProtocolError("Runtime model did not match selection.");
    }
    const candidate = this.#candidates.get(request.selection.model);
    if (!candidate) throw new OllamaProtocolError("Candidate disappeared.");
    if (TEXT_ENCODER.encode(text).byteLength > candidate.maxOutputBytes) {
      throw new OllamaProtocolError("Provider output exceeded its bound.");
    }
    if (
      (response.eval_count !== undefined &&
        response.eval_count > request.generation.maxOutputTokens) ||
      (response.prompt_eval_count !== undefined &&
        response.eval_count !== undefined &&
        response.prompt_eval_count + response.eval_count >
          candidate.contextTokens)
    ) {
      throw new OllamaProtocolError("Provider token usage exceeded its bound.");
    }
    const usage: ProviderUsage = {
      ...(response.prompt_eval_count === undefined
        ? {}
        : { inputTokens: response.prompt_eval_count }),
      ...(response.eval_count === undefined
        ? {}
        : { outputTokens: response.eval_count }),
      ...(response.prompt_eval_count === undefined ||
      response.eval_count === undefined
        ? {}
        : { totalTokens: response.prompt_eval_count + response.eval_count }),
      providerReported: true,
    };
    const digest = preflight.digest;
    const identity = this.#identity(request, response.model, digest);
    const resources = await this.#resources(signal);
    return {
      contractVersion: "provider-result.v1",
      status: "COMPLETED",
      runRef: request.runRef,
      attemptRef: request.attempt.attemptRef,
      identity,
      output: { text },
      usage,
      latency: {
        totalMs: Math.max(0, now() - startedAt),
        ...(firstOutputAt === undefined
          ? {}
          : { firstOutputMs: Math.max(0, firstOutputAt - startedAt) }),
      },
      finishReason: response.done_reason === "length" ? "LENGTH" : "STOP",
      policy: request.policy,
      configuration: request.configuration,
      provenance: {
        adapter: ADAPTER_VERSION,
        runtime: "ollama",
        generation: request.generation,
        local: {
          runtime: "OLLAMA",
          configuredModel: candidate.model,
          selectedModel: request.selection.model,
          runtimeModel: response.model,
          ...(digest === undefined ? {} : { modelDigest: digest }),
          loadState: preflight.residency === "WARM" ? "WARM" : "COLD",
          residency: "WARM",
          ...(response.load_duration === undefined
            ? {}
            : { loadDurationMs: response.load_duration / 1_000_000 }),
          ...(resources === undefined ? {} : { resources }),
        },
      },
    };
  }

  #chatBody(request: ProviderRequest, stream: boolean): string {
    const candidate = this.#candidates.get(request.selection.model);
    if (!candidate) throw new OllamaProtocolError("Candidate disappeared.");
    return JSON.stringify({
      model: request.selection.model,
      messages: request.input.messages.map(({ role, content }) => ({
        role: role.toLowerCase(),
        content,
      })),
      stream,
      think: false,
      keep_alive: candidate.keepAliveSeconds,
      options: {
        num_ctx: candidate.contextTokens,
        num_predict: request.generation.maxOutputTokens,
        ...(request.generation.temperature === undefined
          ? {}
          : { temperature: request.generation.temperature }),
        ...(request.generation.topP === undefined
          ? {}
          : { top_p: request.generation.topP }),
        ...(request.generation.stop === undefined
          ? {}
          : { stop: request.generation.stop }),
      },
    });
  }

  async invoke(
    request: ProviderRequest,
    context: ProviderExecutionContext,
  ): Promise<ProviderOutcome> {
    const now = context.now ?? Date.now;
    const startedAt = now();
    const invalid = this.#candidateFailure(request, startedAt, now);
    if (invalid) return invalid;
    if (this.#active) {
      return this.#failure(
        request,
        startedAt,
        {
          status: "FAILED",
          code: "PROVIDER_BUSY",
          source: "PROVIDER",
          retry: "SAME_PROVIDER_ONLY",
          message: "The Local AI provider is busy.",
        },
        undefined,
        undefined,
        now,
      );
    }
    this.#active = true;
    this.#state = "BUSY";
    const control = createControl(context, request.timeoutMs);
    try {
      if (control.cause()) throw new Error("aborted");
      const preflight = await this.#preflight(
        request.selection.model,
        control.signal,
      );
      const response = await this.#request(
        "api/chat",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: this.#chatBody(request, false),
        },
        control.signal,
      );
      const value = chatResponse(
        parseJson(await readBoundedText(response, MAX_CONTROL_RESPONSE_BYTES)),
      );
      if (control.cause()) throw new Error("aborted");
      const result = await this.#success(
        request,
        value,
        preflight,
        value.message.content,
        startedAt,
        now(),
        now,
        control.signal,
      );
      if (control.cause()) throw new Error("aborted");
      this.#state = "WARM";
      return result;
    } catch (error) {
      const mapped = mapError(error, control.cause());
      this.#state =
        mapped.code === "PROVIDER_UNAVAILABLE"
          ? "UNAVAILABLE"
          : mapped.code === "PROVIDER_BUSY"
            ? "LOADING"
            : "UNKNOWN";
      return this.#failure(
        request,
        startedAt,
        mapped,
        undefined,
        undefined,
        now,
      );
    } finally {
      control.cleanup();
      this.#active = false;
    }
  }

  async *stream(
    request: ProviderRequest,
    context: ProviderExecutionContext,
  ): AsyncIterable<ProviderStreamEvent> {
    const now = context.now ?? Date.now;
    const startedAt = now();
    let sequence = 0;
    let partial = "";
    let partialBytes = 0;
    let preflight: Preflight = { residency: "UNLOADED" };
    const initialIdentity = this.#identity(request);
    yield this.#event(request, sequence++, "STARTED", {
      identity: initialIdentity,
    });
    const invalid = this.#candidateFailure(request, startedAt, now);
    if (invalid) {
      yield this.#terminalEvent(request, sequence, invalid);
      return;
    }
    if (this.#active) {
      const busy = this.#failure(
        request,
        startedAt,
        {
          status: "FAILED",
          code: "PROVIDER_BUSY",
          source: "PROVIDER",
          retry: "SAME_PROVIDER_ONLY",
          message: "The Local AI provider is busy.",
        },
        undefined,
        undefined,
        now,
      );
      yield this.#terminalEvent(request, sequence, busy);
      return;
    }
    this.#active = true;
    this.#state = "BUSY";
    const control = createControl(context, request.timeoutMs);
    try {
      if (control.cause()) throw new Error("aborted");
      preflight = await this.#preflight(
        request.selection.model,
        control.signal,
      );
      const identity = this.#identity(
        request,
        request.selection.model,
        preflight.digest,
      );
      yield this.#event(request, sequence++, "PROVENANCE", {
        identity,
        policy: request.policy,
        configuration: request.configuration,
      });
      const response = await this.#request(
        "api/chat",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: this.#chatBody(request, true),
        },
        control.signal,
      );
      if (!response.body) throw new OllamaProtocolError("Missing stream body.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let firstOutputAt: number | undefined;
      let terminalResponse: ChatResponse | undefined;
      let streamFinished = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (TEXT_ENCODER.encode(buffer).byteLength > MAX_STREAM_EVENT_BYTES) {
            throw new OllamaProtocolError("Stream event exceeded its bound.");
          }
          while (buffer.includes("\n")) {
            const newline = buffer.indexOf("\n");
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            if (terminalResponse) {
              throw new OllamaProtocolError(
                "Stream continued after its terminal response.",
              );
            }
            const parsed = parseJson(line);
            const providerError = providerErrorMessage(parsed);
            if (providerError) throw new OllamaHttpError(500, providerError);
            if (
              !parsed ||
              typeof parsed !== "object" ||
              Array.isArray(parsed)
            ) {
              throw new OllamaProtocolError("Stream event was not an object.");
            }
            const event = parsed as Record<string, unknown>;
            if (
              !nonEmpty(event.model) ||
              event.model !== request.selection.model
            ) {
              throw new OllamaProtocolError("Stream model was malformed.");
            }
            const message = event.message as
              Record<string, unknown> | undefined;
            if (
              !message ||
              message.role !== "assistant" ||
              typeof message.content !== "string"
            ) {
              throw new OllamaProtocolError("Stream message was malformed.");
            }
            if (message.content.length > 0) {
              firstOutputAt ??= now();
              partial += message.content;
              partialBytes += TEXT_ENCODER.encode(message.content).byteLength;
              const candidate = this.#candidates.get(request.selection.model);
              if (!candidate || partialBytes > candidate.maxOutputBytes) {
                throw new OllamaProtocolError(
                  "Stream output exceeded its bound.",
                );
              }
              yield this.#event(request, sequence++, "CONTENT_DELTA", {
                text: message.content,
              });
            }
            if (event.done === true) {
              terminalResponse = chatResponse(parsed);
            } else if (event.done !== false) {
              throw new OllamaProtocolError(
                "Stream completion state was malformed.",
              );
            }
          }
        }
        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
          if (terminalResponse) {
            throw new OllamaProtocolError(
              "Stream continued after its terminal response.",
            );
          }
          const parsed = parseJson(buffer.trim());
          const providerError = providerErrorMessage(parsed);
          if (providerError) throw new OllamaHttpError(500, providerError);
          terminalResponse = chatResponse(parsed);
        }
        streamFinished = true;
      } finally {
        if (!streamFinished) {
          control.abortTransport();
          await reader.cancel().catch(() => undefined);
        }
        reader.releaseLock();
      }
      if (control.cause()) throw new Error("aborted");
      if (!terminalResponse) {
        throw new OllamaProtocolError("Stream ended without completion.");
      }
      const result = await this.#success(
        request,
        terminalResponse,
        preflight,
        partial,
        startedAt,
        firstOutputAt,
        now,
        control.signal,
      );
      if (control.cause()) throw new Error("aborted");
      this.#state = "WARM";
      yield this.#event(request, sequence++, "USAGE_UPDATE", {
        usage: result.usage ?? { providerReported: true },
      });
      yield this.#event(request, sequence, "COMPLETED", { result });
    } catch (error) {
      const mapped = mapError(error, control.cause());
      this.#state =
        mapped.code === "PROVIDER_UNAVAILABLE"
          ? "UNAVAILABLE"
          : mapped.code === "PROVIDER_BUSY"
            ? "LOADING"
            : "UNKNOWN";
      const failure = this.#failure(
        request,
        startedAt,
        partial.length > 0 &&
          control.cause() === undefined &&
          mapped.code === "PROVIDER_UNAVAILABLE"
          ? {
              status: "FAILED",
              code: "MALFORMED_PROVIDER_RESPONSE",
              source: "PROVIDER",
              retry: "DO_NOT_RETRY",
              message: "The Ollama stream ended unexpectedly.",
            }
          : mapped,
        partial,
        this.#identity(request, request.selection.model, preflight.digest)
          .actual,
        now,
      );
      yield this.#terminalEvent(request, sequence, failure);
    } finally {
      control.cleanup();
      this.#active = false;
    }
  }

  #event(
    request: ProviderRequest,
    sequence: number,
    type: ProviderStreamEvent["type"],
    fields: Record<string, unknown>,
  ): ProviderStreamEvent {
    return {
      contractVersion: "provider-stream-event.v1",
      runRef: request.runRef,
      attemptRef: request.attempt.attemptRef,
      sequence,
      type,
      ...fields,
    } as ProviderStreamEvent;
  }

  #terminalEvent(
    request: ProviderRequest,
    sequence: number,
    result: ProviderFailure,
  ): ProviderStreamEvent {
    return this.#event(
      request,
      sequence,
      result.status === "CANCELLED" ? "CANCELLED" : "FAILED",
      { result },
    );
  }

  async inspectAvailability(
    context: ProviderExecutionContext,
    timeoutMs = 5_000,
  ): Promise<OllamaAvailabilitySnapshot> {
    const control = createControl(context, timeoutMs);
    try {
      const { installed, running } = await this.#inventories(control.signal);
      const resident = running.filter((entry) =>
        this.#candidates.has(entry.model),
      );
      const models = [...this.#candidates].map(([model]) => {
        const available = installed.find((entry) => entry.model === model);
        const loaded = resident.find((entry) => entry.model === model);
        const digest = safeDigest(available?.digest);
        return {
          model,
          installed: Boolean(available),
          ...(digest === undefined ? {} : { digest }),
          residency: !available
            ? ("UNAVAILABLE" as const)
            : loaded
              ? this.#active && model === this.#selectedModel
                ? ("BUSY" as const)
                : ("WARM" as const)
              : ("UNLOADED" as const),
          ...(available?.size === undefined
            ? {}
            : { sizeBytes: available.size }),
          ...(loaded?.size_vram === undefined
            ? {}
            : { sizeVramBytes: loaded.size_vram }),
          ...(loaded?.context_length === undefined
            ? {}
            : { contextLength: loaded.context_length }),
        };
      });
      const selected = models.find(
        (entry) => entry.model === this.#selectedModel,
      );
      if (!this.#active && selected) this.#state = selected.residency;
      return {
        provider: "LOCAL",
        runtime: "OLLAMA",
        selectedModel: this.#selectedModel,
        state: this.#state,
        models,
        residentModels: running.length,
        residentApprovedModels: resident.length,
        onePrimaryResidencySafe:
          running.length <= 1 &&
          running.every((entry) => entry.model === this.#selectedModel),
      };
    } catch (error) {
      const mapped = mapError(error, control.cause());
      this.#state = "UNAVAILABLE";
      return {
        provider: "LOCAL",
        runtime: "OLLAMA",
        selectedModel: this.#selectedModel,
        state: "UNAVAILABLE",
        models: [...this.#candidates].map(([model]) => ({
          model,
          installed: false,
          residency: "UNAVAILABLE",
        })),
        residentModels: 0,
        residentApprovedModels: 0,
        onePrimaryResidencySafe: false,
        error: { code: mapped.code, message: mapped.message },
      };
    } finally {
      control.cleanup();
    }
  }

  async inspectRuntime(
    context: ProviderExecutionContext,
    timeoutMs = 5_000,
  ): Promise<OllamaRuntimeSnapshot> {
    const control = createControl(context, timeoutMs);
    try {
      const version = runtimeVersion(
        await this.#json("api/version", { method: "GET" }, control.signal),
      );
      if (control.cause()) throw new Error("aborted");
      return {
        provider: "LOCAL",
        runtime: "OLLAMA",
        status: "AVAILABLE",
        version,
      };
    } catch (error) {
      const mapped = mapError(error, control.cause());
      return {
        provider: "LOCAL",
        runtime: "OLLAMA",
        status: "UNAVAILABLE",
        error: { code: mapped.code, message: mapped.message },
      };
    } finally {
      control.cleanup();
    }
  }

  async unloadApprovedModels(
    context: ProviderExecutionContext,
    timeoutMs = 30_000,
  ): Promise<OllamaUnloadResult> {
    if (this.#active) {
      return {
        status: "FAILED",
        unloadedModels: [],
        transitions: ["BUSY"],
        error: {
          code: "PROVIDER_BUSY",
          message: "The Local AI provider is busy.",
        },
      };
    }
    this.#active = true;
    this.#state = "SWITCHING";
    const transitions: LocalModelResidency[] = ["SWITCHING"];
    const unloadedModels: string[] = [];
    const control = createControl(context, timeoutMs);
    try {
      const { running } = await this.#inventories(control.signal);
      if (running.some((entry) => !this.#candidates.has(entry.model))) {
        throw new OllamaHttpError(
          409,
          "an unmanaged model is resident or busy",
        );
      }
      for (const resident of running) {
        await this.#generateControl(resident.model, 0, control.signal);
        unloadedModels.push(resident.model);
      }
      if (control.cause()) throw new Error("aborted");
      this.#state = "UNLOADED";
      transitions.push("UNLOADED");
      return { status: "UNLOADED", unloadedModels, transitions };
    } catch (error) {
      const mapped = mapError(error, control.cause());
      this.#state = "UNAVAILABLE";
      transitions.push("UNAVAILABLE");
      return {
        status: mapped.status === "CANCELLED" ? "CANCELLED" : "FAILED",
        unloadedModels,
        transitions,
        error: { code: mapped.code, message: mapped.message },
      };
    } finally {
      control.cleanup();
      this.#active = false;
    }
  }

  async switchModel(
    model: string,
    context: ProviderExecutionContext,
    timeoutMs = 30_000,
  ): Promise<OllamaModelSwitchResult> {
    const previousModel = this.#selectedModel;
    if (!this.#candidates.has(model)) {
      return {
        status: "FAILED",
        previousModel,
        selectedModel: previousModel,
        transitions: [],
        error: {
          code: "CONTRACT_VIOLATION",
          message: "The requested Local AI model is not server-approved.",
        },
      };
    }
    if (this.#active) {
      return {
        status: "FAILED",
        previousModel,
        selectedModel: previousModel,
        transitions: ["BUSY"],
        error: {
          code: "PROVIDER_BUSY",
          message: "The Local AI provider is busy.",
        },
      };
    }
    if (model === previousModel) {
      const snapshot = await this.inspectAvailability(context, timeoutMs);
      const current = snapshot.models.find((entry) => entry.model === model);
      return {
        status: current?.installed ? "SWITCHED" : "FAILED",
        previousModel,
        selectedModel: previousModel,
        transitions: [current?.residency ?? "UNAVAILABLE"],
        ...(current?.digest === undefined ? {} : { digest: current.digest }),
        ...(current?.installed
          ? {}
          : {
              error: {
                code: "PROVIDER_UNAVAILABLE" as const,
                message: "The selected Local AI model is unavailable.",
              },
            }),
      };
    }
    this.#active = true;
    this.#state = "SWITCHING";
    const transitions: LocalModelResidency[] = ["SWITCHING"];
    const control = createControl(context, timeoutMs);
    try {
      const inventory = await this.#inventories(control.signal);
      const available = inventory.installed.find(
        (entry) => entry.model === model,
      );
      if (!available) throw new OllamaHttpError(404, "model not found");
      const digest = safeDigest(available.digest);
      const residentApproved = inventory.running.filter((entry) =>
        this.#candidates.has(entry.model),
      );
      if (
        inventory.running.some((entry) => !this.#candidates.has(entry.model))
      ) {
        throw new OllamaHttpError(
          409,
          "an unmanaged model is resident or busy",
        );
      }
      for (const resident of residentApproved) {
        await this.#generateControl(resident.model, 0, control.signal);
      }
      transitions.push("UNLOADED");
      this.#state = "LOADING";
      transitions.push("LOADING");
      const candidate = this.#candidates.get(model);
      if (!candidate) throw new OllamaProtocolError("Candidate disappeared.");
      await this.#generateControl(
        model,
        candidate.keepAliveSeconds,
        control.signal,
      );
      if (control.cause()) throw new Error("aborted");
      this.#selectedModel = model;
      this.#state = "WARM";
      transitions.push("WARM");
      return {
        status: "SWITCHED",
        previousModel,
        selectedModel: model,
        transitions,
        ...(digest === undefined ? {} : { digest }),
      };
    } catch (error) {
      const mapped = mapError(error, control.cause());
      this.#state = "UNAVAILABLE";
      transitions.push("UNAVAILABLE");
      return {
        status: mapped.status === "CANCELLED" ? "CANCELLED" : "FAILED",
        previousModel,
        selectedModel: previousModel,
        transitions,
        error: { code: mapped.code, message: mapped.message },
      };
    } finally {
      control.cleanup();
      this.#active = false;
    }
  }
}
