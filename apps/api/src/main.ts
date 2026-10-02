import { reviewedPolicyRuntimeContract } from "@laita/contracts";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  createSpeechService,
  loadMacOSTtsAdapter,
  loadWhisperAdapter,
} from "@laita/speech";
import { classifyInput } from "@laita/safety";
import {
  createCorrelationId,
  createOperationalLogger,
  loadConfiguration,
  createWorkGate,
  initializeRuntimePaths,
} from "@laita/runtime";
import { initializePersistence, type Persistence } from "@laita/persistence";
import { createApp } from "./app.ts";
import { createAccessController } from "./access.ts";
import {
  createCapabilityEvaluator,
  createDemoCapabilityContext,
  createInstructorPolicyService,
  applyUsageControls,
  createProviderUsageService,
  defaultInstructorPolicy,
  successorInstructorPolicy,
} from "@laita/policy";
import {
  createProviderHealthController,
  createProviderOrchestrator,
} from "@laita/orchestration";
import { OllamaLocalAdapter, OpenAIResponsesAdapter } from "@laita/providers";
import { MacOSKeychainSecretProvider } from "@laita/runtime";

import { createLocalHealthRefresh } from "./local-health.ts";
import { createCourseGrounder } from "@laita/course-grounding";
import { createCourseAwareExecution } from "./course-execution.ts";

const logger = createOperationalLogger();
const correlationId = createCorrelationId();
const configuration = loadConfiguration(process.env);
if (!configuration.ok) {
  logger.write({
    operation: "API_STARTUP",
    code: configuration.code,
    correlationId,
  });
  process.exit(1);
}
let persistence: Persistence | undefined;
let disableWork: (() => void) | undefined;
let closeInput: (() => void) | undefined;
let closeSpeech: (() => void) | undefined;
let closeServer: (() => void) | undefined;
let startupFailed = false;
function closePersistence() {
  if (persistence && !persistence.close().ok) {
    logger.write({
      operation: "API_STARTUP",
      code: "SERVICE_UNAVAILABLE",
      correlationId,
    });
    process.exitCode = 1;
  }
}
function failStartup() {
  if (startupFailed) return;
  startupFailed = true;
  process.exitCode = 1;
  // Normally drain diagnostics and exit naturally. A remaining referenced
  // handle must not hide a fatal failure from the process manager indefinitely.
  setTimeout(() => process.exit(1), 2_000).unref();
  for (const cleanup of [
    disableWork,
    closeInput,
    closeSpeech,
    closeServer,
    closePersistence,
  ]) {
    try {
      cleanup?.();
    } catch {
      // Still attempt every cleanup; the fatal result stays unavailable/nonzero.
    }
  }
  logger.write({
    operation: "API_STARTUP",
    code: "SERVICE_UNAVAILABLE",
    correlationId,
  });
}
try {
  const successor =
    configuration.value.provenance.demoProfileVersion === "demo-profile.v4";
  const paths = initializeRuntimePaths(configuration.value.runtimeRoot);
  if (!paths.ok) throw new Error();
  const initialized = initializePersistence(paths.value);
  if (!initialized.ok) throw new Error();
  persistence = initialized.value;
  const history = persistence.history();
  history.recover();
  const courseGrounder = createCourseGrounder(
    paths.value.courseSourceDirectory(),
  );
  const access = createAccessController(configuration.value.access);
  const capabilityEvaluator = createCapabilityEvaluator(configuration.value);
  if (!capabilityEvaluator) throw new Error();
  const policyState = persistence.policyState(
    configuration.value.provenance.demoProfileVersion === "demo-profile.v4"
      ? successorInstructorPolicy
      : defaultInstructorPolicy,
  );
  const policyControls = createInstructorPolicyService(
    policyState,
    capabilityEvaluator,
  );
  function contextForOwner(text?: string) {
    const state = policyControls.readState();
    if (!state.ok) return undefined;
    const comparison = state.value.policy.comparison;
    const classified = !successor
      ? { dataClass: comparison.dataClass, workflow: comparison.workflow }
      : text === undefined
        ? {
            dataClass: "IDENTITY_MINIMIZED_USER_TEXT" as const,
            workflow: comparison.workflow,
          }
        : classifyInput(text);
    if (!classified) return undefined;
    return {
      accessClass: "INSTRUCTOR" as const,
      courseRef: comparison.courseRef,
      moduleRef: comparison.moduleRef,
      workflow: classified.workflow,
      learningMode: comparison.learningMode,
      inputType: comparison.inputType,
      dataClass: classified.dataClass,
      artifactState: "NONE" as const,
      activeAssessment: false,
    };
  }
  const usageControls = createProviderUsageService(persistence.providerUsage());
  const providerConfiguration = {
    reference: "application-provider-control",
    version: configuration.value.contractVersion,
    digest: capabilityEvaluator.identity.configuration.digest,
  } as const;
  const health = createProviderHealthController({
    localModels: configuration.value.providers.local.candidates,
    openaiModels: [configuration.value.providers.openai.model],
    selectedLocalModel: configuration.value.providers.local.model,
    selectedOpenAIModel: configuration.value.providers.openai.model,
  });
  const localAdapter = new OllamaLocalAdapter({
    endpoint: "http://127.0.0.1:11434/",
    configuration: providerConfiguration,
    candidates: configuration.value.providers.local.candidates.map((model) => ({
      model,
      contextTokens: 4_096,
      maxInputBytes: 32_768,
      maxOutputTokens: 512,
      maxOutputBytes: 32_768,
      keepAliveSeconds: successor
        ? reviewedPolicyRuntimeContract.successor.limits.localIdleUnloadSeconds
        : 60,
    })),
    selectedModel: configuration.value.providers.local.model,
    maxResidentModels: 1,
    maxConcurrentRequests: 1,
  });
  const keychainService = process.env.LAITA_OPENAI_KEYCHAIN_SERVICE;
  const keychainAccount = process.env.LAITA_OPENAI_KEYCHAIN_ACCOUNT;
  const secretReference = configuration.value.providers.openai.secretReference;
  const keychain =
    secretReference && keychainService && keychainAccount
      ? new MacOSKeychainSecretProvider({
          references: {
            [secretReference.id]: {
              service: keychainService,
              account: keychainAccount,
            },
          },
        })
      : {
          async resolve() {
            return {
              status: "UNAVAILABLE" as const,
              code: "SECRET_MISSING" as const,
            };
          },
        };
  const openaiAdapter = new OpenAIResponsesAdapter({
    configuration: providerConfiguration,
    candidates: [
      {
        model: configuration.value.providers.openai.model,
        maxInputBytes: 32_768,
        maxMessages: 8,
        maxMessageBytes: 32_768,
        maxOutputTokens: 512,
        maxOutputBytes: 32_768,
      },
    ],
    selectedModel: configuration.value.providers.openai.model,
    secretProvider: keychain,
    secretReference: secretReference ?? {
      kind: "opaque",
      id: "openai-unconfigured",
    },
  });
  let sharedWork = false;
  const acquireGeneration = () => {
    if (sharedWork) return;
    sharedWork = true;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        sharedWork = false;
      }
    };
  };
  const refreshLocalHealth = createLocalHealthRefresh({
    adapter: localAdapter,
    health,
    acquire: acquireGeneration,
    enabled:
      configuration.value.mode === "operator" &&
      configuration.value.features.local,
    timeoutMs: Math.min(configuration.value.runtime.operationTimeoutMs, 5_000),
  });
  if (
    configuration.value.mode === "operator" &&
    configuration.value.features.local
  ) {
    await refreshLocalHealth();
  } else {
    for (const model of configuration.value.providers.local.candidates)
      health.setStatus(
        "LOCAL",
        model,
        configuration.value.features.local ? "UNAVAILABLE" : "DISABLED",
      );
  }
  health.setStatus(
    "OPENAI",
    configuration.value.providers.openai.model,
    configuration.value.features.openai &&
      secretReference &&
      keychainService &&
      keychainAccount
      ? "READY"
      : configuration.value.features.openai
        ? "UNAVAILABLE"
        : "DISABLED",
  );
  function combinedControls(
    context: ReturnType<typeof createDemoCapabilityContext>,
  ) {
    const usage = usageControls.capabilityControls(context);
    return usage.ok
      ? applyUsageControls(
          { emergencyStop: false, ...health.capabilityControls() },
          usage.value,
        )
      : undefined;
  }
  function healthWithUsage() {
    const snapshot = health.snapshot();
    return {
      ...snapshot,
      providers: snapshot.providers.map((provider) => {
        const usage = usageControls.state(provider.provider);
        return usage.ok && usage.value === "HARD_STOP"
          ? {
              ...provider,
              status:
                provider.provider === "OPENAI"
                  ? ("OVER_BUDGET" as const)
                  : ("OVER_QUOTA" as const),
            }
          : provider;
      }),
    };
  }
  const capabilities = {
    async read(_audience: "instructor", text?: string) {
      await refreshLocalHealth();
      const capabilityContext = contextForOwner(text);
      if (!capabilityContext) return undefined;
      const controls = combinedControls(capabilityContext);
      if (!controls) return undefined;
      const result = policyControls.capability(capabilityContext, controls);
      return result.ok ? result.value : undefined;
    },
  };
  // Provider endpoints remain loopback/private-HTTPS only; no admin/provider
  // port becomes browser reachable.
  const workGate = createWorkGate(configuration.value.runtime);
  workGate.setAvailable(false);
  disableWork = () => workGate.setAvailable(false);
  async function switchLocal(model: string, signal: AbortSignal) {
    const policy = policyControls.readState();
    if (
      !configuration.ok ||
      !configuration.value.features.local ||
      !policy.ok ||
      !policy.value.policy.models.local.includes(model)
    )
      return false;
    const previous = localAdapter.selectedModel;
    health.setStatus("LOCAL", model, "SWITCHING");
    const result = await localAdapter.switchModel(model, { signal }, 30_000);
    if (result.status === "SWITCHED") {
      health.selectModel("LOCAL", model);
      health.setStatus("LOCAL", model, "READY");
      health.setStatus(
        "LOCAL",
        previous,
        previous === model ? "READY" : "UNAVAILABLE",
      );
      return true;
    }
    health.setStatus("LOCAL", previous, "UNAVAILABLE");
    health.setStatus("LOCAL", model, "UNAVAILABLE");
    return false;
  }
  const providerControls = (() => {
    const orchestrator = createProviderOrchestrator({
      adapters: { LOCAL: localAdapter, OPENAI: openaiAdapter },
      health,
      usage: usageControls,
      authorization: {
        authorize(selection, identity, context) {
          const controls = combinedControls(context);
          if (!controls)
            return { ok: false as const, code: "SERVICE_UNAVAILABLE" };
          return policyControls.authorizeSelection(
            context,
            selection,
            identity,
            controls,
          );
        },
      },
      timeoutMs: configuration.value.runtime.operationTimeoutMs,
      maxOutputTokens: 512,
      async prepareLocalModel(model, signal) {
        if (signal.aborted)
          return { ok: false as const, code: "CANCELLED" as const };
        if (localAdapter.selectedModel === model) return { ok: true as const };
        const previousModel = localAdapter.selectedModel;
        health.selectModel("LOCAL", model);
        health.setStatus("LOCAL", model, "SWITCHING");
        const switched = await localAdapter.switchModel(
          model,
          { signal },
          Math.min(configuration.value.runtime.operationTimeoutMs, 30_000),
        );
        if (switched.status === "SWITCHED") {
          health.setStatus("LOCAL", model, "BUSY");
          return { ok: true as const };
        }
        health.selectModel("LOCAL", previousModel);
        health.setStatus("LOCAL", previousModel, "UNAVAILABLE");
        const code =
          switched.status === "CANCELLED"
            ? ("CANCELLED" as const)
            : switched.error?.code === "PROVIDER_BUSY"
              ? ("PROVIDER_BUSY" as const)
              : switched.error?.code === "TIMEOUT"
                ? ("TIMEOUT" as const)
                : switched.error?.code === "CONTRACT_VIOLATION"
                  ? ("SELECTED_MODEL_UNAVAILABLE" as const)
                  : ("TEMPORARY_PROVIDER_FAILURE" as const);
        return { ok: false as const, code };
      },
    });
    return {
      health() {
        return healthWithUsage();
      },
      execute(
        request: import("@laita/contracts").ProviderRunRequest,
        _audience: "instructor",
        signal: AbortSignal,
        sessionRef: `session-${string}`,
        evidence?: {
          readonly systemInstruction: string;
          readonly prompt: string;
          readonly refs: readonly string[];
        },
        trace?: import("@laita/contracts").Trace,
      ) {
        const context = contextForOwner(request.input.text);
        if (!context)
          return Promise.reject(new Error("Provider policy unavailable"));
        return orchestrator.execute({
          request,
          sessionRef,
          signal,
          context,
          ...(evidence ? { evidence } : {}),
          ...(trace ? { trace } : {}),
        });
      },
    };
  })();
  const executeCourseAware = createCourseAwareExecution({
    grounder: courseGrounder,
    executeProvider(request, signal, sessionRef, evidence, trace) {
      return providerControls.execute(
        request,
        "instructor",
        signal,
        sessionRef,
        evidence,
        trace,
      );
    },
  });
  let buildIdentity: string | undefined;
  try {
    const marker = readFileSync(
      new URL("../../../DEPLOYED_COMMIT", import.meta.url),
      "utf8",
    ).trim();
    if (/^[a-f0-9]{40}$/u.test(marker)) buildIdentity = marker;
  } catch {
    /* HOME has no deployment marker. */
  }
  let adapter: ReturnType<typeof loadWhisperAdapter>;
  let ttsAdapter: ReturnType<typeof loadMacOSTtsAdapter>;
  try {
    if (successor && configuration.value.features.speech) {
      adapter = loadWhisperAdapter(process.env.LAITA_STT_PROFILE);
      ttsAdapter = loadMacOSTtsAdapter();
    }
  } catch {
    logger.write({
      operation: "INPUT",
      code: "SERVICE_UNAVAILABLE",
      correlationId,
    });
  }
  const speech = createSpeechService({
    paths: paths.value,
    ...(adapter ? { adapter } : {}),
    ...(ttsAdapter ? { ttsAdapter } : {}),
  });
  closeSpeech = () => speech.close();
  const app = createApp({
    history,
    browserAccess: configuration.value.access,
    webRoot: fileURLToPath(new URL("../../web/dist", import.meta.url)),
    providerControls,
    ...(configuration.value.provenance.demoProfileVersion === "demo-profile.v4"
      ? {
          input: {
            history,
            ...(buildIdentity ? { buildIdentity } : {}),
            speech,
            health: healthWithUsage,
            localState() {
              return {
                selectedModel: localAdapter.selectedModel as
                  "gemma4:12b-mlx" | "llama3.1:8b",
                residency: localAdapter.state,
              };
            },
            switchLocal,
            acquire: acquireGeneration,
            capabilities(text?: string) {
              return capabilities.read("instructor", text);
            },
            execute(
              request: import("@laita/contracts").ProviderRunRequest,
              signal: AbortSignal,
              sessionRef: `session-${string}`,
              trace?: import("@laita/contracts").Trace,
              source?: "TYPED" | "TRANSCRIPT",
            ) {
              return executeCourseAware(
                request,
                signal,
                sessionRef,
                trace,
                source,
              );
            },
          },
        }
      : {}),
    logger,
    workGate,
    persistence,
    access,
    capabilities,
    policyControls: {
      readState: policyControls.readState,
      history: policyControls.history,
      preview(expectedVersion, policy) {
        const previewContext = createDemoCapabilityContext("INSTRUCTOR");
        const controls = combinedControls(previewContext);
        if (!controls)
          return { ok: false as const, code: "SERVICE_UNAVAILABLE" as const };
        return policyControls.preview(expectedVersion, policy, controls);
      },
      activate: policyControls.activate,
      emergencyDisable: policyControls.emergencyDisable,
      rollback: policyControls.rollback,
    },
    usageControls: { summary: usageControls.summary },
  });
  closeInput = () => app.locals.closeInput?.();
  const server = app.listen(configuration.value.server.port, "127.0.0.1");
  closeServer = () => {
    server.close();
    server.closeAllConnections();
  };
  // Express 5's listen callback also runs on bind errors; only the actual
  // listening event is evidence of successful startup.
  server.once("listening", () => {
    workGate.setAvailable(true);
    logger.write({ operation: "API_STARTUP", code: "OK", correlationId });
  });
  server.once("close", closePersistence);
  server.on("error", failStartup);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      workGate.setAvailable(false);
      app.locals.closeInput?.();
      speech.close();
      server.close();
      server.closeAllConnections();
    });
  }
} catch {
  failStartup();
}
