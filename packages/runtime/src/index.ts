import {
  isApplicationConfiguration,
  type ApplicationConfiguration,
} from "@laita/contracts/server";
import {
  isClientConfiguration,
  type ClientConfiguration,
} from "@laita/contracts";
export type ConfigurationResult<T> =
  { ok: true; value: T } | { ok: false; code: "INVALID_CONFIGURATION" };
const invalid = (): ConfigurationResult<never> => ({
  ok: false,
  code: "INVALID_CONFIGURATION",
});
const maxConfigurationCharacters = 32768;

export function defaultConfiguration(): ApplicationConfiguration {
  return {
    contractVersion: "application-configuration.v2",
    provenance: {
      demoProfileVersion: "demo-profile.v2",
      policyVersion: "demo-policy.v2",
    },
    mode: "scaffold",
    server: { bind: "loopback", port: 3100 },
    runtime: { maxConcurrentOperations: 1, operationTimeoutMs: 30000 },
    runtimeRoot: null,
    access: {
      mode: "localhost-validation",
      enabled: true,
      maintenanceMode: false,
      publicOrigin: "http://127.0.0.1:5173",
      requireForwardedHttps: false,
      authenticationRateLimit: { windowSeconds: 60, maxRequests: 20 },
      credentialRateLimit: { windowSeconds: 60, maxRequests: 120 },
      credentials: [],
      adminCredentials: [],
    },
    providers: {
      local: {
        provider: "LOCAL",
        model: "gemma4:12b-mlx",
        candidates: ["gemma4:12b-mlx", "llama3.1:8b"],
      },
      openai: {
        provider: "OPENAI",
        model: "gpt-5.6-luna",
        secretReference: null,
      },
    },
    features: {
      local: true,
      openai: false,
      compare: false,
      speech: false,
    },
  };
}

// Only JSON data crosses this boundary. No environment spread, file reads, secret
// interpolation, Ajv defaults/coercion, or credential resolution occurs here.
export function parseConfiguration(
  json: string,
): ConfigurationResult<ApplicationConfiguration> {
  if (typeof json !== "string" || json.length > maxConfigurationCharacters)
    return invalid();
  try {
    const value: unknown = JSON.parse(json);
    if (!isApplicationConfiguration(value)) return invalid();
    if (
      (value.mode === "scaffold") !==
      (value.access.mode === "localhost-validation")
    )
      return invalid();
    return { ok: true, value };
  } catch {
    return invalid();
  }
}

export function loadConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): ConfigurationResult<ApplicationConfiguration> {
  const json = environment.APP_CONFIG_JSON;
  // An explicitly empty/malformed value must not silently select defaults.
  return parseConfiguration(
    json === undefined ? JSON.stringify(defaultConfiguration()) : json,
  );
}

// Accept serialized server configuration so validation cannot be bypassed by a
// TypeScript cast or a mutated object. Deliberate allowlist; never spread input.
export function projectClientConfiguration(
  json: string,
): ConfigurationResult<ClientConfiguration> {
  const result = parseConfiguration(json);
  if (!result.ok) return result;
  const flags = result.value.features;
  const value: ClientConfiguration = {
    contractVersion: "client-configuration.v2",
    configurationVersion: result.value.contractVersion,
    features: {
      local: flags.local,
      openai: flags.openai,
      compare: flags.compare,
      speech: flags.speech,
    },
  };
  return isClientConfiguration(value) ? { ok: true, value } : invalid();
}

export {
  createCorrelationId,
  createPublicError,
  mapUnexpectedFailure,
  safeOperationalEvent,
  createOperationalLogger,
} from "./operations.ts";
export type {
  Operation,
  OutcomeCode,
  OperationalEventInput,
  OperationalEvent,
  OperationalLogger,
  OperationalSink,
  LogLevel,
} from "./operations.ts";

export { createWorkGate } from "./work-gate.ts";
export type { WorkGate, WorkResult } from "./work-gate.ts";

export { initializeRuntimePaths } from "./paths.ts";
export type { RuntimePaths, FoundationResult } from "./paths.ts";

export {
  createSecretHandleForProvider,
  MacOSKeychainSecretProvider,
  SecretConfigurationError,
} from "./secret-provider.ts";
export type {
  MacOSKeychainSecretProviderOptions,
  SecretCommandResult,
  SecretCommandRunner,
  SecretHandle,
  SecretProvider,
  SecretReference,
  SecretResolution,
  SecretUnavailableCode,
} from "./secret-provider.ts";
