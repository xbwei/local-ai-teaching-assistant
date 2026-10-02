import type { ProviderHealthController } from "@laita/orchestration";
import type { OllamaLocalAdapter } from "@laita/providers";

// One read-only inventory per idle cooldown, shared by all capability callers.
// The same application lock excludes inference, switching and STT preparation.
export function createLocalHealthRefresh(options: {
  adapter: Pick<OllamaLocalAdapter, "inspectAvailability">;
  health: ProviderHealthController;
  acquire: () => (() => void) | undefined;
  enabled: boolean;
  timeoutMs: number;
  now?: () => number;
}) {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 5_000
  )
    throw new Error("Invalid Local inspection timeout");
  const now = options.now ?? (() => performance.now());
  let nextCheck = -Infinity;
  let pending: Promise<void> | undefined;
  return function refresh(): Promise<void> {
    if (!options.enabled) return Promise.resolve();
    if (pending) return pending;
    if (now() < nextCheck) return Promise.resolve();
    const before = options.health.snapshot();
    const local = before.providers.find((entry) => entry.provider === "LOCAL")!;
    // Do not turn an inspection into circuit recovery or a control override.
    if (
      local.breaker.state !== "CLOSED" ||
      local.models.some(
        (entry) => entry.status !== "READY" && entry.status !== "UNAVAILABLE",
      )
    )
      return Promise.resolve();
    const release = options.acquire();
    if (!release) return Promise.resolve();
    pending = (async () => {
      const statuses = new Map(
        local.models.map(({ model }) => [
          model,
          "UNAVAILABLE" as "READY" | "UNAVAILABLE",
        ]),
      );
      try {
        const inspected = await options.adapter.inspectAvailability(
          { signal: new AbortController().signal },
          options.timeoutMs,
        );
        if (
          !inspected.error &&
          inspected.onePrimaryResidencySafe &&
          inspected.selectedModel === local.selectedModel &&
          (["UNLOADED", "WARM"].includes(inspected.state) ||
            (inspected.state === "UNAVAILABLE" &&
              inspected.models.some(
                (m) =>
                  m.model === inspected.selectedModel &&
                  !m.installed &&
                  m.residency === "UNAVAILABLE",
              )))
        ) {
          for (const model of local.models) {
            const found = inspected.models.filter(
              (entry) => entry.model === model.model,
            );
            const value = found.length === 1 ? found[0] : undefined;
            if (
              value?.installed &&
              value.digest &&
              /^sha256:[a-f0-9]{64}$/u.test(value.digest) &&
              (value.residency === "UNLOADED" || value.residency === "WARM")
            )
              statuses.set(model.model, "READY");
          }
        }
      } catch {
        // No raw provider error escapes; an unsuccessful inspection is unavailable.
      } finally {
        // Discard observations made before another health transition.
        if (options.health.snapshot().revision === before.revision)
          for (const [model, status] of statuses)
            options.health.setStatus("LOCAL", model, status);
        nextCheck = now() + 5_000;
        release();
      }
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
