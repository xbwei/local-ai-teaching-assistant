import assert from "node:assert/strict";
import test from "node:test";

import {
  createSecretHandleForProvider,
  MacOSKeychainSecretProvider,
  SecretConfigurationError,
} from "../dist/index.js";

const syntheticSecret = `sk-test_${"a".repeat(32)}`;
const reference = { kind: "opaque", id: "openai-primary" };
const item = { service: "org.example.project", account: "runtime-reader" };

function provider(result, options = {}) {
  const calls = [];
  const instance = new MacOSKeychainSecretProvider({
    references: { [reference.id]: item },
    commandRunner: async (...args) => {
      calls.push(args);
      if (result instanceof Error) throw result;
      return result;
    },
    ...options,
  });
  return { instance, calls };
}

const context = (signal = new AbortController().signal) => ({ signal });

test("Keychain resolver constructs one fixed no-shell security command", async () => {
  const { instance, calls } = provider({
    exitCode: 0,
    stdout: `${syntheticSecret}\n`,
  });
  const result = await instance.resolve(reference, context());
  assert.equal(result.status, "RESOLVED");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/security");
  assert.deepEqual(calls[0][1], [
    "find-generic-password",
    "-w",
    "-s",
    item.service,
    "-a",
    item.account,
  ]);
  assert.deepEqual(calls[0][2], {
    signal: calls[0][2].signal,
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
  });
  let observed;
  await result.secret.consume((value) => {
    observed = value;
  });
  assert.equal(observed, syntheticSecret);
  await assert.rejects(() => result.secret.consume(() => undefined));
  assert.equal(JSON.stringify(result.secret), undefined);
});

test("Keychain resolver classifies missing, inaccessible, and command failures", async () => {
  for (const [exitCode, code] of [
    [44, "SECRET_MISSING"],
    [36, "SECRET_INACCESSIBLE"],
    [51, "SECRET_INACCESSIBLE"],
    [1, "SECRET_COMMAND_FAILED"],
  ]) {
    const { instance } = provider({ exitCode, stdout: "" });
    assert.deepEqual(await instance.resolve(reference, context()), {
      status: "UNAVAILABLE",
      code,
    });
  }
  const { instance } = provider(new Error(syntheticSecret));
  assert.deepEqual(await instance.resolve(reference, context()), {
    status: "UNAVAILABLE",
    code: "SECRET_COMMAND_FAILED",
  });
});

test("Keychain resolver rejects unknown references and malformed secret output", async () => {
  const malformed = ["", "   ", "line\nbreak", "\u0000", "x".repeat(4_097)];
  for (const stdout of malformed) {
    const { instance } = provider({ exitCode: 0, stdout });
    assert.deepEqual(await instance.resolve(reference, context()), {
      status: "UNAVAILABLE",
      code: "SECRET_INVALID",
    });
  }
  const { instance, calls } = provider({
    exitCode: 0,
    stdout: `${syntheticSecret}\n`,
  });
  assert.deepEqual(
    await instance.resolve({ kind: "opaque", id: "unknown" }, context()),
    { status: "UNAVAILABLE", code: "SECRET_MISSING" },
  );
  assert.equal(calls.length, 0);
});

test("Keychain resolver distinguishes timeout and cancellation without leaking details", async () => {
  const timeout = new DOMException(syntheticSecret, "TimeoutError");
  const timed = provider(timeout).instance;
  assert.deepEqual(await timed.resolve(reference, context()), {
    status: "UNAVAILABLE",
    code: "SECRET_TIMEOUT",
  });
  const controller = new AbortController();
  controller.abort();
  const cancelled = provider({ exitCode: 0, stdout: syntheticSecret }).instance;
  assert.deepEqual(
    await cancelled.resolve(reference, context(controller.signal)),
    {
      status: "UNAVAILABLE",
      code: "SECRET_CANCELLED",
    },
  );
});

test("secret configuration and synthetic handles fail closed", async () => {
  for (const options of [undefined, null, {}, { references: null }]) {
    assert.throws(
      () => new MacOSKeychainSecretProvider(options),
      SecretConfigurationError,
    );
  }
  assert.throws(
    () => new MacOSKeychainSecretProvider({ references: {} }),
    SecretConfigurationError,
  );
  assert.throws(
    () =>
      new MacOSKeychainSecretProvider({
        references: { [reference.id]: null },
      }),
    SecretConfigurationError,
  );
  for (const item of [
    { account: "synthetic-account" },
    { service: "synthetic-service", account: 42 },
  ]) {
    assert.throws(
      () =>
        new MacOSKeychainSecretProvider({
          references: { [reference.id]: item },
        }),
      SecretConfigurationError,
    );
  }
  assert.throws(
    () => createSecretHandleForProvider("line\nbreak"),
    SecretConfigurationError,
  );
  const handle = createSecretHandleForProvider(syntheticSecret);
  const serialized = JSON.stringify({ handle, reference });
  assert.doesNotMatch(serialized, /sk-/u);
  assert.match(serialized, /openai-primary/u);
});
