import { addAbortListener } from "node:events";
import { isRuntimeLimits, type RuntimeLimits } from "@laita/contracts/server";

type WorkFailure =
  | "BUSY"
  | "SERVICE_UNAVAILABLE"
  | "OPERATION_TIMEOUT"
  | "CANCELLED"
  | "INTERNAL_FAILURE";
export type WorkResult<T> =
  { ok: true; value: T } | { ok: false; code: WorkFailure };
export interface WorkGate {
  isReady(): boolean;
  // Composition/lifecycle control only. No HTTP or environment toggle exists.
  setAvailable(available: boolean): void;
  run<T>(
    operation: (signal: AbortSignal) => T | PromiseLike<T>,
    signal?: AbortSignal,
  ): Promise<WorkResult<T>>;
}

export function createWorkGate(limits: RuntimeLimits): WorkGate {
  // Runtime validation also protects direct in-process callers, not only startup.
  if (!isRuntimeLimits(limits)) throw new Error("INVALID_CONFIGURATION");
  const { maxConcurrentOperations, operationTimeoutMs } = limits;
  let active = 0;
  let available = true;
  let cancelling = 0;
  return {
    isReady: () => available && cancelling === 0,
    setAvailable(value) {
      available = value === true;
    },
    run<T>(
      operation: (signal: AbortSignal) => T | PromiseLike<T>,
      signal?: AbortSignal,
    ): Promise<WorkResult<T>> {
      if (signal?.aborted)
        return Promise.resolve({ ok: false, code: "CANCELLED" });
      if (!available || cancelling > 0)
        return Promise.resolve({ ok: false, code: "SERVICE_UNAVAILABLE" });
      if (active >= maxConcurrentOperations)
        return Promise.resolve({ ok: false, code: "BUSY" });
      active++;
      const controller = new AbortController();
      return new Promise((resolve) => {
        let finished = false;
        let operationSettled = false;
        let draining = false;
        let cancellation: ReturnType<typeof addAbortListener> | undefined;
        const finish = (result: WorkResult<T>, abort = false) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          cancellation?.[Symbol.dispose]();
          active--;
          // Never forward caller-provided abort reasons (which may be private).
          if (abort) {
            // An AbortSignal cannot force an uncooperative operation to stop.
            // Release its slot once, but fail closed to new work until it settles
            // so repeated timeouts cannot accumulate expensive orphaned work.
            if (!operationSettled) {
              draining = true;
              cancelling++;
            }
            controller.abort();
          }
          resolve(result);
        };
        const timer = setTimeout(
          () => finish({ ok: false, code: "OPERATION_TIMEOUT" }, true),
          operationTimeoutMs,
        );
        if (signal)
          cancellation = addAbortListener(signal, () =>
            finish({ ok: false, code: "CANCELLED" }, true),
          );
        const settled = (result: WorkResult<T>) => {
          operationSettled = true;
          if (draining) {
            draining = false;
            cancelling--;
          }
          finish(result);
        };
        try {
          // Register both handlers even for late settlement after abort. No raw
          // rejection escapes and the single terminal guard prevents double release.
          Promise.resolve(operation(controller.signal)).then(
            (value) => settled({ ok: true, value }),
            () => settled({ ok: false, code: "INTERNAL_FAILURE" }),
          );
        } catch {
          settled({ ok: false, code: "INTERNAL_FAILURE" });
        }
      });
    },
  };
}
