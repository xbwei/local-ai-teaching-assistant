import { spawn } from "node:child_process";

const SECURITY_EXECUTABLE = "/usr/bin/security";
const MAX_SECRET_OUTPUT_BYTES = 4_096;

export interface SecretReference {
  readonly kind: "opaque";
  readonly id: string;
}

export type SecretUnavailableCode =
  | "SECRET_MISSING"
  | "SECRET_INACCESSIBLE"
  | "SECRET_INVALID"
  | "SECRET_COMMAND_FAILED"
  | "SECRET_TIMEOUT"
  | "SECRET_CANCELLED";

export interface SecretHandle {
  consume<T>(consumer: (value: string) => T | Promise<T>): Promise<T>;
}

export type SecretResolution =
  | { readonly status: "RESOLVED"; readonly secret: SecretHandle }
  | { readonly status: "UNAVAILABLE"; readonly code: SecretUnavailableCode };

export interface SecretProvider {
  resolve(
    reference: SecretReference,
    context: { readonly signal: AbortSignal },
  ): Promise<SecretResolution>;
}

export interface SecretCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export type SecretCommandRunner = (
  executable: string,
  args: readonly string[],
  options: {
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  },
) => Promise<SecretCommandResult>;

export interface MacOSKeychainSecretProviderOptions {
  readonly references: Readonly<
    Record<string, { readonly service: string; readonly account: string }>
  >;
  readonly commandRunner?: SecretCommandRunner;
  readonly timeoutMs?: number;
}

export class SecretConfigurationError extends Error {
  override readonly name = "SecretConfigurationError";
}

class OneUseSecretHandle implements SecretHandle {
  #value: string | undefined;

  constructor(value: string) {
    this.#value = value;
  }

  async consume<T>(consumer: (value: string) => T | Promise<T>): Promise<T> {
    const value = this.#value;
    this.#value = undefined;
    if (value === undefined) {
      throw new Error("Secret handle has already been consumed.");
    }
    return consumer(value);
  }

  toJSON(): undefined {
    return undefined;
  }
}

export function createSecretHandleForProvider(value: string): SecretHandle {
  if (!validSecretMaterial(value)) {
    throw new SecretConfigurationError("Secret value is malformed.");
  }
  return new OneUseSecretHandle(value);
}

function boundedText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validReferenceId(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value);
}

function validSecretMaterial(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_SECRET_OUTPUT_BYTES &&
    value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function normalizeSecretOutput(value: string): string | undefined {
  const normalized = value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
  return validSecretMaterial(normalized) ? normalized : undefined;
}

async function runCommand(
  executable: string,
  args: readonly string[],
  options: {
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  },
): Promise<SecretCommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const child = spawn(executable, [...args], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    let bytes = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      child.kill();
      finish(() => reject(new DOMException("Aborted", "AbortError")));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new DOMException("Timed out", "TimeoutError")));
    }, options.timeoutMs);
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    const stdoutStream = child.stdout;
    if (!stdoutStream) {
      child.kill();
      finish(() => reject(new Error("Secret command stdout is unavailable.")));
      return;
    }
    stdoutStream.once("error", () => {
      child.kill();
      finish(() => reject(new Error("Secret command output failed.")));
    });
    stdoutStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > options.maxOutputBytes) {
        child.kill();
        finish(() => reject(new Error("Secret output exceeded its bound.")));
        return;
      }
      stdout += chunk;
    });
    child.once("error", () =>
      finish(() => reject(new Error("Secret command failed."))),
    );
    child.once("close", (code) =>
      finish(() => resolve({ exitCode: code ?? 1, stdout })),
    );
  });
}

export class MacOSKeychainSecretProvider implements SecretProvider {
  readonly #references: ReadonlyMap<
    string,
    { readonly service: string; readonly account: string }
  >;
  readonly #runner: SecretCommandRunner;
  readonly #timeoutMs: number;

  constructor(options: MacOSKeychainSecretProviderOptions) {
    if (
      !options ||
      typeof options !== "object" ||
      !options.references ||
      typeof options.references !== "object" ||
      Array.isArray(options.references)
    ) {
      throw new SecretConfigurationError(
        "Keychain references must be unique and bounded.",
      );
    }
    const entries = Object.entries(options.references);
    if (
      entries.length === 0 ||
      entries.length > 16 ||
      entries.some(
        ([id, value]) =>
          !validReferenceId(id) ||
          !value ||
          typeof value !== "object" ||
          !boundedText(value.service) ||
          !boundedText(value.account),
      )
    ) {
      throw new SecretConfigurationError(
        "Keychain references must be unique and bounded.",
      );
    }
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 10 ||
      timeoutMs > 30_000
    ) {
      throw new SecretConfigurationError("Secret timeout must be bounded.");
    }
    this.#references = new Map(entries);
    this.#runner = options.commandRunner ?? runCommand;
    this.#timeoutMs = timeoutMs;
  }

  async resolve(
    reference: SecretReference,
    context: { readonly signal: AbortSignal },
  ): Promise<SecretResolution> {
    if (context.signal.aborted) {
      return { status: "UNAVAILABLE", code: "SECRET_CANCELLED" };
    }
    const item =
      reference.kind === "opaque" && validReferenceId(reference.id)
        ? this.#references.get(reference.id)
        : undefined;
    if (!item) return { status: "UNAVAILABLE", code: "SECRET_MISSING" };
    try {
      const result = await this.#runner(
        SECURITY_EXECUTABLE,
        ["find-generic-password", "-w", "-s", item.service, "-a", item.account],
        {
          signal: context.signal,
          timeoutMs: this.#timeoutMs,
          maxOutputBytes: MAX_SECRET_OUTPUT_BYTES,
        },
      );
      if (result.exitCode === 44) {
        return { status: "UNAVAILABLE", code: "SECRET_MISSING" };
      }
      if (result.exitCode === 36 || result.exitCode === 51) {
        return { status: "UNAVAILABLE", code: "SECRET_INACCESSIBLE" };
      }
      if (result.exitCode !== 0) {
        return { status: "UNAVAILABLE", code: "SECRET_COMMAND_FAILED" };
      }
      const value = normalizeSecretOutput(result.stdout);
      return value === undefined
        ? { status: "UNAVAILABLE", code: "SECRET_INVALID" }
        : { status: "RESOLVED", secret: new OneUseSecretHandle(value) };
    } catch (error) {
      if (
        context.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return { status: "UNAVAILABLE", code: "SECRET_CANCELLED" };
      }
      if (error instanceof DOMException && error.name === "TimeoutError") {
        return { status: "UNAVAILABLE", code: "SECRET_TIMEOUT" };
      }
      return { status: "UNAVAILABLE", code: "SECRET_COMMAND_FAILED" };
    }
  }
}
