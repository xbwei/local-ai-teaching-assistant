import type {
  GenerationConfiguration,
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
import type {
  SecretProvider,
  SecretReference,
  SecretUnavailableCode,
} from "@laita/runtime";
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "openai";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

const ADAPTER_VERSION = "openai-responses.v1";
const SDK_VERSION = "7.9.0";
const TEXT_ENCODER = new TextEncoder();

export interface OpenAIModelCandidate {
  readonly model: string;
  readonly maxInputBytes: number;
  readonly maxMessages: number;
  readonly maxMessageBytes: number;
  readonly maxOutputTokens: number;
  readonly maxOutputBytes: number;
}

export interface OpenAIAdapterOptions {
  readonly configuration: ProviderRequest["configuration"];
  readonly candidates: readonly OpenAIModelCandidate[];
  readonly selectedModel: string;
  readonly secretProvider: SecretProvider;
  readonly secretReference: SecretReference;
  readonly testBaseURL?: string;
}

interface RequestControl {
  readonly signal: AbortSignal;
  readonly cause: () => "CALLER" | "TIMEOUT" | undefined;
  readonly abortTransport: () => void;
  readonly cleanup: () => void;
}

interface MappedError {
  readonly status: "FAILED" | "CANCELLED";
  readonly code: ProviderErrorCode;
  readonly source: "CALLER" | "PROVIDER" | "CONTRACT";
  readonly retry: "SAME_PROVIDER_ONLY" | "DO_NOT_RETRY";
  readonly message: string;
}

class OpenAIProtocolError extends Error {
  override readonly name = "OpenAIProtocolError";
}

class OpenAIResponseError extends Error {
  override readonly name = "OpenAIResponseError";
  constructor(readonly providerCode: string | null | undefined) {
    super("OpenAI reported a failed response.");
  }
}

class OpenAICredentialError extends Error {
  override readonly name = "OpenAICredentialError";
}

export class OpenAIConfigurationError extends Error {
  override readonly name = "OpenAIConfigurationError";
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validOpenAIApiKey(value: string): boolean {
  return /^sk-[A-Za-z0-9_-]{16,500}$/u.test(value);
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
  );
}

function validatedCandidates(
  candidates: readonly OpenAIModelCandidate[],
): ReadonlyMap<string, OpenAIModelCandidate> {
  if (candidates.length !== 1) {
    throw new OpenAIConfigurationError(
      "Exactly one approved OpenAI model candidate is required.",
    );
  }
  const candidate = candidates[0];
  if (
    !candidate ||
    !nonEmpty(candidate.model) ||
    candidate.model.length > 200 ||
    !boundedInteger(candidate.maxInputBytes, 1, 4 * 1024 * 1024) ||
    !boundedInteger(candidate.maxMessages, 1, 64) ||
    !boundedInteger(candidate.maxMessageBytes, 1, 1024 * 1024) ||
    candidate.maxMessageBytes > candidate.maxInputBytes ||
    !boundedInteger(candidate.maxOutputTokens, 1, 16_384) ||
    !boundedInteger(candidate.maxOutputBytes, 1, 4 * 1024 * 1024)
  ) {
    throw new OpenAIConfigurationError(
      "The approved OpenAI model candidate must be bounded.",
    );
  }
  return new Map([[candidate.model, Object.freeze({ ...candidate })]]);
}

function validatedTestBaseURL(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpenAIConfigurationError("Test base URL must be loopback-only.");
  }
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (
    url.protocol !== "http:" ||
    !(
      host === "localhost" ||
      host === "::1" ||
      /^127(?:\.[0-9]{1,3}){3}$/u.test(host)
    ) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/", "/v1", "/v1/"].includes(url.pathname)
  ) {
    throw new OpenAIConfigurationError("Test base URL must be loopback-only.");
  }
  url.pathname = url.pathname.replace(/\/$/u, "") || "/v1";
  return url.toString().replace(/\/$/u, "");
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

function safeIdentity(model: string): ProviderIdentity {
  return {
    selected: { provider: "OPENAI", model },
    actual: { provider: "OPENAI", model: { id: model } },
  };
}

function requestInput(request: ProviderRequest) {
  return request.input.messages.map((message) => ({
    role: message.role.toLowerCase() as "system" | "user" | "assistant",
    content: message.content,
  }));
}

function requestParameters(
  request: ProviderRequest,
): Omit<ResponseCreateParamsNonStreaming, "stream"> {
  return {
    model: request.selection.model,
    input: requestInput(request),
    max_output_tokens: request.generation.maxOutputTokens,
    store: false,
    tools: [],
    parallel_tool_calls: false,
    truncation: "disabled",
    reasoning: { effort: "none" },
    prompt_cache_options: { mode: "explicit" },
    ...(request.generation.temperature === undefined
      ? {}
      : { temperature: request.generation.temperature }),
    ...(request.generation.topP === undefined
      ? {}
      : { top_p: request.generation.topP }),
  };
}

function validateRequest(
  request: ProviderRequest,
  candidates: ReadonlyMap<string, OpenAIModelCandidate>,
): OpenAIModelCandidate {
  const candidate = candidates.get(request.selection.model);
  if (!candidate) {
    throw new OpenAIConfigurationError(
      "The requested OpenAI model is not server-approved.",
    );
  }
  if (request.selection.provider !== "OPENAI") {
    throw new OpenAIConfigurationError("OpenAI selection is required.");
  }
  if (request.generation.stop !== undefined) {
    throw new OpenAIConfigurationError(
      "Stop sequences are not supported by this Responses configuration.",
    );
  }
  if (
    request.input.messages.length > candidate.maxMessages ||
    request.generation.maxOutputTokens > candidate.maxOutputTokens
  ) {
    throw new OpenAIConfigurationError("OpenAI request exceeds its bound.");
  }
  let totalBytes = 0;
  for (const message of request.input.messages) {
    const bytes = TEXT_ENCODER.encode(message.content).byteLength;
    if (bytes > candidate.maxMessageBytes) {
      throw new OpenAIConfigurationError("OpenAI message exceeds its bound.");
    }
    totalBytes += bytes;
  }
  if (totalBytes > candidate.maxInputBytes) {
    throw new OpenAIConfigurationError("OpenAI input exceeds its bound.");
  }
  return candidate;
}

function usage(response: Response): ProviderUsage {
  const value = response.usage;
  const cachedInputTokens = value?.input_tokens_details?.cached_tokens;
  if (
    !value ||
    !boundedInteger(value.input_tokens, 0, Number.MAX_SAFE_INTEGER) ||
    !boundedInteger(value.output_tokens, 0, Number.MAX_SAFE_INTEGER) ||
    !boundedInteger(value.total_tokens, 0, Number.MAX_SAFE_INTEGER) ||
    value.total_tokens !== value.input_tokens + value.output_tokens ||
    (cachedInputTokens !== undefined &&
      !boundedInteger(cachedInputTokens, 0, value.input_tokens))
  ) {
    throw new OpenAIProtocolError("OpenAI usage metadata is malformed.");
  }
  return {
    inputTokens: value.input_tokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    outputTokens: value.output_tokens,
    totalTokens: value.total_tokens,
    providerReported: true,
  };
}

function responseText(response: Response): string {
  if (
    typeof response.output_text === "string" &&
    response.output_text.length > 0
  ) {
    return response.output_text;
  }
  if (!Array.isArray(response.output)) {
    throw new OpenAIProtocolError("OpenAI response output is malformed.");
  }

  const textParts: string[] = [];
  for (const rawItem of response.output as unknown[]) {
    if (!rawItem || typeof rawItem !== "object") {
      throw new OpenAIProtocolError("OpenAI response output is malformed.");
    }
    const item = rawItem as {
      readonly type?: unknown;
      readonly content?: unknown;
    };
    if (typeof item.type !== "string") {
      throw new OpenAIProtocolError("OpenAI response output is malformed.");
    }
    if (item.type !== "message") continue;
    if (!Array.isArray(item.content)) {
      throw new OpenAIProtocolError("OpenAI response output is malformed.");
    }
    for (const rawContent of item.content) {
      if (!rawContent || typeof rawContent !== "object") {
        throw new OpenAIProtocolError("OpenAI response output is malformed.");
      }
      const content = rawContent as {
        readonly type?: unknown;
        readonly text?: unknown;
      };
      if (typeof content.type !== "string") {
        throw new OpenAIProtocolError("OpenAI response output is malformed.");
      }
      if (content.type === "output_text") {
        if (typeof content.text !== "string") {
          throw new OpenAIProtocolError("OpenAI response output is malformed.");
        }
        textParts.push(content.text);
      }
    }
  }
  const text = textParts.join("");
  if (!nonEmpty(text)) {
    throw new OpenAIProtocolError("OpenAI response text is malformed.");
  }
  return text;
}

async function sdkOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      throw new OpenAIProtocolError("OpenAI SDK response parsing failed.");
    }
    throw error;
  }
}

async function* sdkEvents(
  stream: AsyncIterable<ResponseStreamEvent>,
): AsyncIterable<ResponseStreamEvent> {
  try {
    for await (const event of stream) yield event;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      throw new OpenAIProtocolError("OpenAI SDK stream parsing failed.");
    }
    throw error;
  }
}

function finishReason(response: Response): "STOP" | "LENGTH" {
  if (response.status === "completed") return "STOP";
  if (
    response.status === "incomplete" &&
    response.incomplete_details?.reason === "max_output_tokens"
  ) {
    return "LENGTH";
  }
  if (response.status === "failed") {
    throw new OpenAIResponseError(response.error?.code);
  }
  throw new OpenAIProtocolError("OpenAI response did not complete safely.");
}

function success(
  request: ProviderRequest,
  response: Response,
  startedAt: number,
  completedAt: number,
  firstOutputMs?: number,
): ProviderSuccess {
  if (response.model !== request.selection.model) {
    throw new OpenAIProtocolError(
      "OpenAI response identity or text is malformed.",
    );
  }
  const text = responseText(response);
  const measuredUsage = usage(response);
  return {
    contractVersion: "provider-result.v1",
    status: "COMPLETED",
    runRef: request.runRef,
    attemptRef: request.attempt.attemptRef,
    identity: safeIdentity(response.model),
    output: { text },
    usage: measuredUsage,
    latency: {
      totalMs: Math.max(0, completedAt - startedAt),
      ...(firstOutputMs === undefined ? {} : { firstOutputMs }),
    },
    finishReason: finishReason(response),
    policy: request.policy,
    configuration: request.configuration,
    provenance: {
      adapter: ADAPTER_VERSION,
      runtime: "OPENAI_RESPONSES",
      generation: request.generation,
      openai: {
        runtime: "OPENAI_RESPONSES",
        configuredModel: request.selection.model,
        selectedModel: request.selection.model,
        responseModel: response.model,
        sdk: { name: "openai", version: SDK_VERSION },
        store: false,
        automaticRetries: 0,
        sdkLogging: "OFF",
        usageStatus: "REPORTED",
      },
    },
  };
}

function secretError(
  code: SecretUnavailableCode,
  cause?: "CALLER" | "TIMEOUT",
): MappedError {
  if (cause === "TIMEOUT" || code === "SECRET_TIMEOUT") {
    return {
      status: "FAILED",
      code: "TIMEOUT",
      source: "PROVIDER",
      retry: "SAME_PROVIDER_ONLY",
      message: "The OpenAI request timed out.",
    };
  }
  if (cause === "CALLER" || code === "SECRET_CANCELLED") {
    return {
      status: "CANCELLED",
      code: "CANCELLED",
      source: "CALLER",
      retry: "DO_NOT_RETRY",
      message: "The OpenAI request was cancelled.",
    };
  }
  return {
    status: "FAILED",
    code: "PROVIDER_UNAVAILABLE",
    source: "PROVIDER",
    retry: "DO_NOT_RETRY",
    message:
      "OpenAI is unavailable because its server credential could not be resolved.",
  };
}

function mapError(error: unknown, cause?: "CALLER" | "TIMEOUT"): MappedError {
  if (cause === "TIMEOUT" || error instanceof APIConnectionTimeoutError) {
    return {
      status: "FAILED",
      code: "TIMEOUT",
      source: "PROVIDER",
      retry: "SAME_PROVIDER_ONLY",
      message: "The OpenAI request timed out.",
    };
  }
  if (cause === "CALLER" || error instanceof APIUserAbortError) {
    return {
      status: "CANCELLED",
      code: "CANCELLED",
      source: "CALLER",
      retry: "DO_NOT_RETRY",
      message: "The OpenAI request was cancelled.",
    };
  }
  if (error instanceof OpenAIConfigurationError) {
    return {
      status: "FAILED",
      code: "CONTRACT_VIOLATION",
      source: "CONTRACT",
      retry: "DO_NOT_RETRY",
      message: "The OpenAI request violates the configured provider contract.",
    };
  }
  if (error instanceof OpenAICredentialError) {
    return {
      status: "FAILED",
      code: "PROVIDER_AUTHENTICATION_FAILED",
      source: "PROVIDER",
      retry: "DO_NOT_RETRY",
      message: "OpenAI authentication failed.",
    };
  }
  if (error instanceof OpenAIProtocolError) {
    return {
      status: "FAILED",
      code: "MALFORMED_PROVIDER_RESPONSE",
      source: "PROVIDER",
      retry: "DO_NOT_RETRY",
      message: "OpenAI returned a malformed response.",
    };
  }
  const providerCode =
    error instanceof OpenAIResponseError
      ? error.providerCode?.toLowerCase()
      : error instanceof APIError
        ? error.code?.toLowerCase()
        : undefined;
  if (
    error instanceof AuthenticationError ||
    providerCode?.includes("api_key") ||
    providerCode?.includes("authentication")
  ) {
    return {
      status: "FAILED",
      code: "PROVIDER_AUTHENTICATION_FAILED",
      source: "PROVIDER",
      retry: "DO_NOT_RETRY",
      message: "OpenAI authentication failed.",
    };
  }
  if (
    error instanceof PermissionDeniedError ||
    providerCode?.includes("permission")
  ) {
    return {
      status: "FAILED",
      code: "PROVIDER_PERMISSION_DENIED",
      source: "PROVIDER",
      retry: "DO_NOT_RETRY",
      message: "OpenAI access was denied.",
    };
  }
  if (
    error instanceof NotFoundError ||
    providerCode?.includes("model") ||
    (error instanceof BadRequestError && providerCode?.includes("model"))
  ) {
    return {
      status: "FAILED",
      code: "INVALID_PROVIDER_MODEL",
      source: "PROVIDER",
      retry: "DO_NOT_RETRY",
      message: "The approved OpenAI model is unavailable or invalid.",
    };
  }
  if (
    error instanceof RateLimitError ||
    providerCode?.includes("rate_limit") ||
    providerCode?.includes("quota") ||
    providerCode?.includes("billing") ||
    providerCode?.includes("budget") ||
    providerCode?.includes("hard_limit")
  ) {
    const quota =
      providerCode?.includes("quota") || providerCode?.includes("billing");
    const budget =
      providerCode?.includes("budget") || providerCode?.includes("hard_limit");
    return {
      status: "FAILED",
      code: budget
        ? "BUDGET_EXCEEDED"
        : quota
          ? "QUOTA_EXCEEDED"
          : "RATE_LIMITED",
      source: "PROVIDER",
      retry: budget || quota ? "DO_NOT_RETRY" : "SAME_PROVIDER_ONLY",
      message: budget
        ? "The OpenAI budget is unavailable."
        : quota
          ? "The OpenAI quota is unavailable."
          : "OpenAI rate limited the request.",
    };
  }
  if (
    error instanceof InternalServerError ||
    error instanceof APIConnectionError ||
    providerCode === "server_error"
  ) {
    return {
      status: "FAILED",
      code: "PROVIDER_UNAVAILABLE",
      source: "PROVIDER",
      retry: "SAME_PROVIDER_ONLY",
      message: "OpenAI is unavailable.",
    };
  }
  return {
    status: "FAILED",
    code: "INTERNAL_PROVIDER_FAILURE",
    source: "PROVIDER",
    retry: "DO_NOT_RETRY",
    message: "The OpenAI request failed safely.",
  };
}

function failure(
  request: ProviderRequest,
  error: MappedError,
  startedAt: number,
  completedAt: number,
  partialOutput?: string,
): ProviderFailure {
  return {
    contractVersion: "provider-result.v1",
    status: error.status,
    runRef: request.runRef,
    attemptRef: request.attempt.attemptRef,
    selection: request.selection,
    error: {
      code: error.code,
      source: error.source,
      retry: error.retry,
      message: error.message,
    },
    ...(partialOutput === undefined || partialOutput.length === 0
      ? {}
      : { partialOutput: { text: partialOutput, trusted: false } }),
    latency: { totalMs: Math.max(0, completedAt - startedAt) },
    policy: request.policy,
    configuration: request.configuration,
  };
}

export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly provider = "OPENAI" as const;
  readonly configuration: ProviderRequest["configuration"];
  readonly #candidates: ReadonlyMap<string, OpenAIModelCandidate>;
  readonly #selectedModel: string;
  readonly #secretProvider: SecretProvider;
  readonly #secretReference: SecretReference;
  readonly #testBaseURL: string | undefined;
  #active = false;

  constructor(options: OpenAIAdapterOptions) {
    this.configuration = Object.freeze({ ...options.configuration });
    this.#candidates = validatedCandidates(options.candidates);
    if (!this.#candidates.has(options.selectedModel)) {
      throw new OpenAIConfigurationError(
        "The selected OpenAI model must be server-approved.",
      );
    }
    this.#selectedModel = options.selectedModel;
    this.#secretProvider = options.secretProvider;
    this.#secretReference = Object.freeze({ ...options.secretReference });
    this.#testBaseURL = validatedTestBaseURL(options.testBaseURL);
  }

  #client(apiKey: string, timeoutMs: number): OpenAI {
    if (!validOpenAIApiKey(apiKey)) {
      throw new OpenAICredentialError("OpenAI credential is malformed.");
    }
    return new OpenAI({
      apiKey,
      maxRetries: 0,
      timeout: timeoutMs,
      logLevel: "off",
      ...(this.#testBaseURL === undefined
        ? {}
        : { baseURL: this.#testBaseURL }),
    });
  }

  async invoke(
    request: ProviderRequest,
    context: ProviderExecutionContext,
  ): Promise<ProviderOutcome> {
    const now = context.now ?? Date.now;
    const startedAt = now();
    let control: RequestControl | undefined;
    let acquired = false;
    try {
      const candidate = validateRequest(request, this.#candidates);
      if (request.selection.model !== this.#selectedModel || this.#active) {
        const mapped: MappedError = this.#active
          ? {
              status: "FAILED",
              code: "PROVIDER_BUSY",
              source: "PROVIDER",
              retry: "SAME_PROVIDER_ONLY",
              message: "OpenAI is busy.",
            }
          : mapError(new OpenAIConfigurationError("Selection mismatch."));
        return failure(request, mapped, startedAt, now());
      }
      this.#active = true;
      acquired = true;
      control = createControl(context, request.timeoutMs);
      const resolved = await this.#secretProvider.resolve(
        this.#secretReference,
        {
          signal: control.signal,
        },
      );
      if (resolved.status === "UNAVAILABLE") {
        return failure(
          request,
          secretError(resolved.code, control.cause()),
          startedAt,
          now(),
        );
      }
      const response = await resolved.secret.consume((apiKey) =>
        sdkOperation(() =>
          this.#client(apiKey, request.timeoutMs).responses.create(
            { ...requestParameters(request), stream: false },
            {
              signal: control?.signal,
              timeout: request.timeoutMs,
              maxRetries: 0,
            },
          ),
        ),
      );
      if (
        TEXT_ENCODER.encode(responseText(response)).byteLength >
        candidate.maxOutputBytes
      ) {
        throw new OpenAIProtocolError("OpenAI output exceeded its bound.");
      }
      return success(request, response, startedAt, now());
    } catch (error) {
      return failure(
        request,
        mapError(error, control?.cause()),
        startedAt,
        now(),
      );
    } finally {
      control?.cleanup();
      if (acquired) this.#active = false;
    }
  }

  async *stream(
    request: ProviderRequest,
    context: ProviderExecutionContext,
  ): AsyncIterable<ProviderStreamEvent> {
    const now = context.now ?? Date.now;
    const startedAt = now();
    let sequence = 0;
    let control: RequestControl | undefined;
    let partial = "";
    let partialBytes = 0;
    let firstOutputMs: number | undefined;
    let acquired = false;
    yield {
      contractVersion: "provider-stream-event.v1",
      runRef: request.runRef,
      attemptRef: request.attempt.attemptRef,
      sequence: sequence++,
      type: "STARTED",
      identity: safeIdentity(request.selection.model),
    };
    try {
      const candidate = validateRequest(request, this.#candidates);
      if (request.selection.model !== this.#selectedModel || this.#active) {
        const mapped: MappedError = this.#active
          ? {
              status: "FAILED",
              code: "PROVIDER_BUSY",
              source: "PROVIDER",
              retry: "SAME_PROVIDER_ONLY",
              message: "OpenAI is busy.",
            }
          : mapError(new OpenAIConfigurationError("Selection mismatch."));
        const result = failure(request, mapped, startedAt, now());
        yield {
          contractVersion: "provider-stream-event.v1",
          runRef: request.runRef,
          attemptRef: request.attempt.attemptRef,
          sequence,
          type: "FAILED",
          result: result as ProviderFailure & { readonly status: "FAILED" },
        };
        return;
      }
      this.#active = true;
      acquired = true;
      control = createControl(context, request.timeoutMs);
      const resolved = await this.#secretProvider.resolve(
        this.#secretReference,
        {
          signal: control.signal,
        },
      );
      if (resolved.status === "UNAVAILABLE") {
        const result = failure(
          request,
          secretError(resolved.code, control.cause()),
          startedAt,
          now(),
        );
        yield {
          contractVersion: "provider-stream-event.v1",
          runRef: request.runRef,
          attemptRef: request.attempt.attemptRef,
          sequence,
          type: result.status === "CANCELLED" ? "CANCELLED" : "FAILED",
          result: result as never,
        };
        return;
      }
      yield {
        contractVersion: "provider-stream-event.v1",
        runRef: request.runRef,
        attemptRef: request.attempt.attemptRef,
        sequence: sequence++,
        type: "PROVENANCE",
        identity: safeIdentity(request.selection.model),
        policy: request.policy,
        configuration: request.configuration,
      };
      const stream = await resolved.secret.consume((apiKey) =>
        sdkOperation(() =>
          this.#client(apiKey, request.timeoutMs).responses.create(
            {
              ...requestParameters(request),
              stream: true,
              stream_options: { include_obfuscation: true },
            } as ResponseCreateParamsStreaming,
            {
              signal: control?.signal,
              timeout: request.timeoutMs,
              maxRetries: 0,
            },
          ),
        ),
      );
      let terminal: Response | undefined;
      for await (const event of sdkEvents(
        stream as AsyncIterable<ResponseStreamEvent>,
      )) {
        if (event.type === "response.output_text.delta") {
          if (!nonEmpty(event.delta)) {
            throw new OpenAIProtocolError("OpenAI stream delta is malformed.");
          }
          const joinsSurrogatePair =
            partial.length > 0 &&
            event.delta.length > 0 &&
            partial.charCodeAt(partial.length - 1) >= 0xd800 &&
            partial.charCodeAt(partial.length - 1) <= 0xdbff &&
            event.delta.charCodeAt(0) >= 0xdc00 &&
            event.delta.charCodeAt(0) <= 0xdfff;
          const nextPartialBytes =
            partialBytes +
            TEXT_ENCODER.encode(event.delta).byteLength -
            (joinsSurrogatePair ? 2 : 0);
          if (nextPartialBytes > candidate.maxOutputBytes) {
            control.abortTransport();
            throw new OpenAIProtocolError("OpenAI stream exceeded its bound.");
          }
          partial += event.delta;
          partialBytes = nextPartialBytes;
          if (firstOutputMs === undefined)
            firstOutputMs = Math.max(0, now() - startedAt);
          yield {
            contractVersion: "provider-stream-event.v1",
            runRef: request.runRef,
            attemptRef: request.attempt.attemptRef,
            sequence: sequence++,
            type: "CONTENT_DELTA",
            text: event.delta,
          };
        } else if (
          event.type === "response.completed" ||
          event.type === "response.incomplete"
        ) {
          if (terminal)
            throw new OpenAIProtocolError(
              "OpenAI stream repeated its terminal event.",
            );
          terminal = event.response;
        } else if (event.type === "response.failed") {
          throw new OpenAIResponseError(event.response.error?.code);
        } else if (event.type === "error") {
          throw new OpenAIResponseError(event.code);
        }
      }
      if (!terminal || responseText(terminal) !== partial) {
        throw new OpenAIProtocolError(
          "OpenAI stream ended without a valid terminal response.",
        );
      }
      const result = success(
        request,
        terminal,
        startedAt,
        now(),
        firstOutputMs,
      );
      yield {
        contractVersion: "provider-stream-event.v1",
        runRef: request.runRef,
        attemptRef: request.attempt.attemptRef,
        sequence: sequence++,
        type: "USAGE_UPDATE",
        usage: result.usage as ProviderUsage,
      };
      yield {
        contractVersion: "provider-stream-event.v1",
        runRef: request.runRef,
        attemptRef: request.attempt.attemptRef,
        sequence,
        type: "COMPLETED",
        result,
      };
    } catch (error) {
      const result = failure(
        request,
        mapError(error, control?.cause()),
        startedAt,
        now(),
        partial,
      );
      yield {
        contractVersion: "provider-stream-event.v1",
        runRef: request.runRef,
        attemptRef: request.attempt.attemptRef,
        sequence,
        type: result.status === "CANCELLED" ? "CANCELLED" : "FAILED",
        result: result as never,
      };
    } finally {
      control?.cleanup();
      if (acquired) this.#active = false;
    }
  }
}
