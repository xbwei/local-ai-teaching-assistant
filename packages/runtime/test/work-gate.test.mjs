import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createWorkGate } from "@laita/runtime";

const limits = { maxConcurrentOperations: 2, operationTimeoutMs: 100 };
const deferred = () => Promise.withResolvers();
const busy = { ok: false, code: "BUSY" };

test("capacity is acquired synchronously; saturation rejects without retaining or starting queued work", async () => {
  const gate = createWorkGate(limits);
  const pending = [deferred(), deferred()];
  let calls = 0;
  const work = pending.map((p) =>
    gate.run(() => {
      calls++;
      return p.promise;
    }),
  );
  for (let index = 0; index < 50; index++) {
    assert.deepEqual(
      await gate.run(() => {
        calls++;
      }),
      busy,
    );
  }
  assert.equal(calls, 2);
  assert.equal(gate.isReady(), true); // saturation is BUSY, not missing foundation
  pending.forEach((p) => p.resolve("done"));
  assert.deepEqual(await Promise.all(work), [
    { ok: true, value: "done" },
    { ok: true, value: "done" },
  ]);
  assert.equal(calls, 2); // no rejected callback starts after slots become free
  assert.deepEqual(await gate.run(() => "next"), { ok: true, value: "next" });
});

for (const terminal of ["success", "failure", "timeout", "cancellation"]) {
  test(`${terminal} releases exactly one slot; late settlement, old timers and repeat abort cannot release a new slot`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const gate = createWorkGate(limits);
    const parent = new AbortController();
    const first = deferred();
    const second = deferred();
    let dependencySignal;
    const result = gate.run((signal) => {
      dependencySignal = signal;
      return first.promise;
    }, parent.signal);
    assert.equal(getEventListeners(parent.signal, "abort").length, 1);
    if (terminal === "success") first.resolve("done");
    if (terminal === "failure")
      first.reject(new Error("synthetic-private-failure"));
    if (terminal === "timeout") t.mock.timers.tick(100);
    if (terminal === "cancellation") parent.abort("synthetic-private-reason");
    assert.deepEqual(
      await result,
      terminal === "success"
        ? { ok: true, value: "done" }
        : {
            ok: false,
            code: {
              failure: "INTERNAL_FAILURE",
              timeout: "OPERATION_TIMEOUT",
              cancellation: "CANCELLED",
            }[terminal],
          },
    );
    assert.equal(getEventListeners(parent.signal, "abort").length, 0);
    assert.equal(
      dependencySignal.aborted,
      terminal === "timeout" || terminal === "cancellation",
    );
    if (dependencySignal.aborted)
      assert.notEqual(dependencySignal.reason, "synthetic-private-reason");
    // Clear the old deadline before starting replacement work.
    t.mock.timers.tick(100);
    assert.equal(
      dependencySignal.aborted,
      terminal === "timeout" || terminal === "cancellation",
    );
    if (terminal === "timeout" || terminal === "cancellation") {
      assert.equal(gate.isReady(), false);
      assert.deepEqual(await gate.run(() => assert.fail("still draining")), {
        ok: false,
        code: "SERVICE_UNAVAILABLE",
      });
      first.reject(new Error("synthetic-late-rejection"));
      await Promise.resolve();
      assert.equal(gate.isReady(), true);
    }
    const held = gate.run(() => second.promise);
    const replacement = deferred();
    const next = gate.run(() => replacement.promise);
    assert.deepEqual(await gate.run(() => assert.fail("must not run")), busy);
    parent.abort();
    first.reject(new Error("synthetic-late-rejection"));
    await Promise.resolve();
    assert.deepEqual(await gate.run(() => assert.fail("double release")), busy);
    second.resolve(1);
    replacement.resolve(2);
    await Promise.all([held, next]);
    assert.deepEqual(await gate.run(() => 3), { ok: true, value: 3 });
  });
}

test("cooperative dependency settles on timeout/cancel and removes its own resources", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const terminal of ["timeout", "cancellation"]) {
    const gate = createWorkGate(limits);
    const parent = new AbortController();
    const stopped = deferred();
    let signal;
    const result = gate.run((incoming) => {
      signal = incoming;
      return new Promise((resolve) => {
        incoming.addEventListener(
          "abort",
          () => {
            stopped.resolve();
            resolve("stopped");
          },
          { once: true },
        );
      });
    }, parent.signal);
    if (terminal === "timeout") t.mock.timers.tick(100);
    else parent.abort();
    await stopped.promise;
    assert.equal(
      (await result).code,
      terminal === "timeout" ? "OPERATION_TIMEOUT" : "CANCELLED",
    );
    assert.equal(getEventListeners(signal, "abort").length, 0);
    assert.deepEqual(await gate.run(() => 1), { ok: true, value: 1 });
  }
});

test("pre-aborted and controlled-unavailable work never starts; stopped propagation cannot suppress cancellation", async () => {
  const gate = createWorkGate(limits);
  const parent = new AbortController();
  parent.signal.addEventListener("abort", (event) =>
    event.stopImmediatePropagation(),
  );
  let dependencyAborted = false;
  const result = gate.run(
    (signal) =>
      new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            dependencyAborted = true;
            resolve();
          },
          { once: true },
        );
      }),
    parent.signal,
  );
  parent.abort();
  assert.deepEqual(await result, { ok: false, code: "CANCELLED" });
  assert.equal(dependencyAborted, true);
  assert.deepEqual(
    await gate.run(() => assert.fail("pre-aborted"), parent.signal),
    { ok: false, code: "CANCELLED" },
  );
  gate.setAvailable(false);
  assert.equal(gate.isReady(), false);
  assert.deepEqual(await gate.run(() => assert.fail("unavailable")), {
    ok: false,
    code: "SERVICE_UNAVAILABLE",
  });
  gate.setAvailable(true);
  assert.deepEqual(await gate.run(() => 1), { ok: true, value: 1 });
});

test("synchronous throws and throwing thenables become safe failures; gate snapshots validated limits", async () => {
  const settings = { ...limits, maxConcurrentOperations: 1 };
  const gate = createWorkGate(settings);
  settings.maxConcurrentOperations = 999;
  for (const operation of [
    () => {
      throw "route";
    },
    () => ({
      get then() {
        throw "router";
      },
    }),
  ]) {
    assert.deepEqual(await gate.run(operation), {
      ok: false,
      code: "INTERNAL_FAILURE",
    });
  }
  const pending = deferred();
  const work = gate.run(() => pending.promise);
  assert.deepEqual(await gate.run(() => 0), busy);
  pending.resolve();
  await work;
  for (const invalid of [
    { ...limits, maxConcurrentOperations: 0 },
    { ...limits, operationTimeoutMs: Infinity },
  ]) {
    assert.throws(
      () => createWorkGate(invalid),
      /^Error: INVALID_CONFIGURATION$/,
    );
  }
});

test("ignored cancellation fails closed until settlement; controlled unavailability is not overwritten by late completion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = createWorkGate(limits);
  const pending = [deferred(), deferred()];
  const results = pending.map((p) => gate.run(() => p.promise));
  t.mock.timers.tick(100);
  for (const result of results)
    assert.deepEqual(await result, { ok: false, code: "OPERATION_TIMEOUT" });
  for (let index = 0; index < 50; index++) {
    assert.deepEqual(
      await gate.run(() => assert.fail("no orphan accumulation")),
      { ok: false, code: "SERVICE_UNAVAILABLE" },
    );
  }
  pending[0].resolve();
  await Promise.resolve();
  assert.equal(gate.isReady(), false);
  gate.setAvailable(false);
  pending[1].resolve();
  await Promise.resolve();
  assert.equal(gate.isReady(), false);
  gate.setAvailable(true);
  assert.equal(gate.isReady(), true);
  const held = [deferred(), deferred()];
  const newWork = held.map((p) => gate.run(() => p.promise));
  assert.deepEqual(
    await gate.run(() => assert.fail("no double release")),
    busy,
  );
  held.forEach((p) => p.resolve());
  await Promise.all(newWork);
});
