import type {
  ClientProviderFailureCode,
  ProviderHealthSnapshot,
  ProviderHealthStatus,
  ProviderId,
} from "@laita/contracts";
import type { CapabilityControlState } from "@laita/policy";

interface ModelState {
  status: ProviderHealthStatus;
  failures: number;
  opens: number;
  openUntil: number;
  halfOpenActive: boolean;
  lastFailure?: ClientProviderFailureCode;
}

export interface ProviderHealthController {
  snapshot(): ProviderHealthSnapshot;
  capabilityControls(): Partial<CapabilityControlState>;
  setStatus(
    provider: ProviderId,
    model: string,
    status: ProviderHealthStatus,
  ): boolean;
  selectModel(provider: ProviderId, model: string): boolean;
  check(
    provider: ProviderId,
    model: string,
  ): { ok: true } | { ok: false; code: ClientProviderFailureCode };
  begin(
    provider: ProviderId,
    model: string,
  ): { ok: true } | { ok: false; code: ClientProviderFailureCode };
  succeeded(provider: ProviderId, model: string): void;
  failed(
    provider: ProviderId,
    model: string,
    code: ClientProviderFailureCode,
  ): void;
}

const retryableFailures = new Set<ClientProviderFailureCode>([
  "SELECTED_PROVIDER_UNAVAILABLE",
  "PROVIDER_BUSY",
  "TIMEOUT",
  "TEMPORARY_PROVIDER_FAILURE",
]);

function deniedFor(
  status: ProviderHealthStatus,
): ClientProviderFailureCode | undefined {
  if (status === "READY") return undefined;
  return (
    {
      LOADING: "MODEL_LOADING",
      SWITCHING: "MODEL_SWITCHING",
      BUSY: "PROVIDER_BUSY",
      UNAVAILABLE: "SELECTED_PROVIDER_UNAVAILABLE",
      RECOVERING: "TEMPORARY_PROVIDER_FAILURE",
      DISABLED: "PROVIDER_DISABLED",
      OVER_BUDGET: "OVER_BUDGET",
      OVER_QUOTA: "OVER_QUOTA",
      AUTHENTICATION_FAILED: "AUTHENTICATION_FAILED",
      PROVIDER_FAILURE: "TEMPORARY_PROVIDER_FAILURE",
    } as const
  )[status];
}

export function createProviderHealthController(options: {
  readonly localModels: readonly string[];
  readonly openaiModels: readonly string[];
  readonly selectedLocalModel: string;
  readonly selectedOpenAIModel: string;
  readonly failureThreshold?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly now?: () => number;
}): ProviderHealthController {
  const threshold = options.failureThreshold ?? 3;
  const base = options.baseBackoffMs ?? 1_000;
  const maximum = options.maxBackoffMs ?? 30_000;
  if (
    !Number.isSafeInteger(threshold) ||
    threshold < 1 ||
    threshold > 10 ||
    !Number.isSafeInteger(base) ||
    base < 1 ||
    !Number.isSafeInteger(maximum) ||
    maximum < base ||
    maximum > 30_000
  )
    throw new Error("Invalid bounded circuit configuration");
  const now = options.now ?? Date.now;
  const selected: Record<ProviderId, string> = {
    LOCAL: options.selectedLocalModel,
    OPENAI: options.selectedOpenAIModel,
  };
  const candidates = {
    LOCAL: [...options.localModels],
    OPENAI: [...options.openaiModels],
  } as const;
  const states = new Map<string, ModelState>();
  let revision = 1;
  for (const provider of ["LOCAL", "OPENAI"] as const) {
    if (!candidates[provider].includes(selected[provider]))
      throw new Error("Selected model is not approved");
    for (const model of candidates[provider])
      states.set(`${provider}:${model}`, {
        status: "UNAVAILABLE",
        failures: 0,
        opens: 0,
        openUntil: 0,
        halfOpenActive: false,
      });
  }
  const state = (provider: ProviderId, model: string) =>
    states.get(`${provider}:${model}`);
  function breaker(value: ModelState) {
    if (value.openUntil === 0) return "CLOSED" as const;
    return now() < value.openUntil ? ("OPEN" as const) : ("HALF_OPEN" as const);
  }
  function setStatus(
    provider: ProviderId,
    model: string,
    status: ProviderHealthStatus,
  ) {
    const value = state(provider, model);
    if (!value) return false;
    if (value.status === status) return true;
    value.status = status;
    revision += 1;
    return true;
  }
  function selectModel(provider: ProviderId, model: string) {
    if (!state(provider, model)) return false;
    if (selected[provider] === model) return true;
    selected[provider] = model;
    revision += 1;
    return true;
  }
  function begin(provider: ProviderId, model: string) {
    const checked = check(provider, model);
    if (!checked.ok) return checked;
    const value = state(provider, model);
    if (!value) return checked;
    const phase = breaker(value);
    if (phase === "HALF_OPEN") {
      if (value.halfOpenActive)
        return { ok: false as const, code: "PROVIDER_BUSY" as const };
      value.halfOpenActive = true;
      value.status = "RECOVERING";
    } else value.status = "BUSY";
    revision += 1;
    return { ok: true as const };
  }
  function check(provider: ProviderId, model: string) {
    const value = state(provider, model);
    if (!value)
      return {
        ok: false as const,
        code: "SELECTED_MODEL_UNAVAILABLE" as const,
      };
    const phase = breaker(value);
    if (phase === "OPEN")
      return {
        ok: false as const,
        code: "TEMPORARY_PROVIDER_FAILURE" as const,
      };
    const denied = deniedFor(value.status);
    return phase !== "HALF_OPEN" && denied
      ? { ok: false as const, code: denied }
      : { ok: true as const };
  }
  function succeeded(provider: ProviderId, model: string) {
    const value = state(provider, model);
    if (!value) return;
    Object.assign(value, {
      status: "READY",
      failures: 0,
      opens: 0,
      openUntil: 0,
      halfOpenActive: false,
    });
    delete value.lastFailure;
    revision += 1;
  }
  function failed(
    provider: ProviderId,
    model: string,
    code: ClientProviderFailureCode,
  ) {
    const value = state(provider, model);
    if (!value) return;
    value.halfOpenActive = false;
    value.lastFailure = code;
    if (retryableFailures.has(code)) {
      value.failures += 1;
      if (value.failures >= threshold) {
        value.opens += 1;
        value.openUntil =
          now() + Math.min(maximum, base * 2 ** Math.min(value.opens - 1, 10));
      }
      value.status = value.openUntil > now() ? "PROVIDER_FAILURE" : "READY";
    } else if (code === "CANCELLED") {
      value.status = "READY";
    } else {
      value.failures = 0;
      value.opens = 0;
      value.openUntil = 0;
      value.status =
        code === "POLICY_DENIED" ||
        code === "STALE_AUTHORIZATION" ||
        code === "INVALID_REQUEST"
          ? "READY"
          : code === "AUTHENTICATION_FAILED"
            ? "AUTHENTICATION_FAILED"
            : code === "SELECTED_MODEL_UNAVAILABLE" ||
                code === "SELECTED_PROVIDER_UNAVAILABLE" ||
                code === "INTERNAL_FAILURE"
              ? "UNAVAILABLE"
              : code === "PROVIDER_DISABLED"
                ? "DISABLED"
                : code === "OVER_BUDGET"
                  ? "OVER_BUDGET"
                  : code === "OVER_QUOTA"
                    ? "OVER_QUOTA"
                    : value.status;
    }
    revision += 1;
  }
  function snapshot(): ProviderHealthSnapshot {
    return Object.freeze({
      contractVersion: "provider-health.v1",
      revision,
      providers: (["LOCAL", "OPENAI"] as const).map((provider) => {
        const chosen = state(provider, selected[provider])!;
        const phase = breaker(chosen);
        return {
          provider,
          status:
            phase === "OPEN" ? ("PROVIDER_FAILURE" as const) : chosen.status,
          selectedModel: selected[provider],
          models: candidates[provider].map((model) => ({
            model,
            status: state(provider, model)!.status,
          })),
          breaker: {
            state: phase,
            consecutiveFailures: chosen.failures,
            retryAfterMs:
              phase === "OPEN" ? Math.max(0, chosen.openUntil - now()) : 0,
          },
          ...(chosen.lastFailure ? { lastFailure: chosen.lastFailure } : {}),
        };
      }),
    });
  }
  function capabilityControls(): Partial<CapabilityControlState> {
    const local = state("LOCAL", selected.LOCAL)!;
    const openai = state("OPENAI", selected.OPENAI)!;
    const localBreaker = breaker(local);
    const openaiBreaker = breaker(openai);
    const localState =
      localBreaker === "OPEN"
        ? "UNAVAILABLE"
        : localBreaker === "HALF_OPEN"
          ? "READY"
          : local.status === "READY"
            ? "READY"
            : local.status === "LOADING"
              ? "LOADING"
              : local.status === "SWITCHING"
                ? "SWITCHING"
                : local.status === "BUSY" || local.status === "RECOVERING"
                  ? "BUSY"
                  : "UNAVAILABLE";
    return {
      local: {
        featureEnabled: local.status !== "DISABLED",
        scheduleOpen: true,
        withinBudget: local.status !== "OVER_BUDGET",
        quotaAvailable: local.status !== "OVER_QUOTA",
        state: localState,
        runtime: {
          selectedModel: selected.LOCAL,
          models: candidates.LOCAL.map((model) => ({
            model,
            state:
              breaker(state("LOCAL", model)!) === "OPEN"
                ? ("UNAVAILABLE" as const)
                : breaker(state("LOCAL", model)!) === "HALF_OPEN"
                  ? ("READY" as const)
                  : state("LOCAL", model)!.status === "READY"
                    ? ("READY" as const)
                    : state("LOCAL", model)!.status === "LOADING"
                      ? ("LOADING" as const)
                      : state("LOCAL", model)!.status === "SWITCHING"
                        ? ("SWITCHING" as const)
                        : state("LOCAL", model)!.status === "BUSY" ||
                            state("LOCAL", model)!.status === "RECOVERING"
                          ? ("BUSY" as const)
                          : ("UNAVAILABLE" as const),
          })),
        },
      },
      openai: {
        featureEnabled: openai.status !== "DISABLED",
        scheduleOpen: true,
        withinBudget: openai.status !== "OVER_BUDGET",
        quotaAvailable: openai.status !== "OVER_QUOTA",
        state:
          openaiBreaker === "HALF_OPEN" ||
          (openaiBreaker === "CLOSED" && openai.status === "READY")
            ? "READY"
            : "UNAVAILABLE",
        runtime: {
          selectedModel: selected.OPENAI,
          models: candidates.OPENAI.map((model) => ({
            model,
            state:
              breaker(state("OPENAI", model)!) === "HALF_OPEN" ||
              (breaker(state("OPENAI", model)!) === "CLOSED" &&
                state("OPENAI", model)!.status === "READY")
                ? ("READY" as const)
                : ("UNAVAILABLE" as const),
          })),
        },
      },
    };
  }
  return Object.freeze({
    snapshot,
    capabilityControls,
    setStatus,
    selectModel,
    check,
    begin,
    succeeded,
    failed,
  });
}
