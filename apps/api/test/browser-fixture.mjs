import { createServer } from "node:http";
import {
  request as httpsRequest,
  createServer as createHttpsServer,
} from "node:https";
import { once } from "node:events";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../dist/app.js";
import { createAccessController } from "../dist/access.js";
import { createSpeechService } from "@laita/speech";
import { defaultConfiguration } from "@laita/runtime";
const sha = `sha256:${"a".repeat(64)}`;
export function capabilities(text) {
  // Match the production distinction: absent discovery text is allowed, empty input is not.
  if (text !== undefined && !text.trim()) return undefined;
  text ??= "";
  const local = {
    id: "LOCAL",
    label: "Local",
    state: text.includes("unavailable") ? "UNAVAILABLE" : "READY",
    models: [
      { id: "gemma4:12b-mlx", label: "Gemma" },
      { id: "llama3.1:8b", label: "Llama" },
    ],
  };
  const cloud = {
    id: "OPENAI",
    label: "OpenAI",
    state: "READY",
    models: [{ id: "synthetic-cloud", label: "OpenAI" }],
  };
  const localOnly = text.includes("private");
  return {
    contractVersion: "capability-availability.v1",
    decisionRef: "decision-0123456789abcdef01234567",
    identity: {
      policy: {
        runtimeDigest: sha,
        profileVersion: "demo-profile.v4",
        policyVersion: "demo-policy.v4",
        providerPolicyVersion: "demo-provider-eligibility.v4",
        classificationVersion: "data-classification.v1",
        retentionPolicyVersion: "retention-policy.v1",
        gradingBoundaryVersion: "grading-boundary.v1",
      },
      configuration: { version: "application-configuration.v2", digest: sha },
    },
    providers: localOnly ? [local] : [local, cloud],
    modes: [
      ...(local.state === "READY"
        ? [{ id: "LOCAL", label: "Local", providers: ["LOCAL"] }]
        : []),
      ...(!localOnly
        ? [
            { id: "OPENAI", label: "OpenAI", providers: ["OPENAI"] },
            ...(local.state === "READY"
              ? [
                  {
                    id: "COMPARE",
                    label: "Compare",
                    providers: ["LOCAL", "OPENAI"],
                  },
                ]
              : []),
          ]
        : []),
    ],
    guidance: "SELECT_AVAILABLE_MODE",
    recheckOn: [
      "INPUT_CHANGE",
      "ARTIFACT_CHANGE",
      "COURSE_OR_MODULE_CHANGE",
      "WORKFLOW_OR_MODE_CHANGE",
      "PROVIDER_OR_MODEL_CHANGE",
      "SCHEDULE_OR_FEATURE_CHANGE",
      "BUDGET_OR_QUOTA_CHANGE",
      "ASSESSMENT_STATE_CHANGE",
      "POLICY_VERSION_CHANGE",
      "PROVIDER_HEALTH_CHANGE",
    ],
  };
}
export async function fixture(options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "browser-input-test-"));
  const token = randomBytes(32).toString("base64url");
  const config = {
    ...defaultConfiguration().access,
    mode: "single-operator",
    enabled: true,
    maintenanceMode: false,
    requireForwardedHttps: true,
    credentials: [
      {
        id: "synthetic-owner",
        role: "instructor",
        courseScopes: ["course-synthetic-demo"],
        tokenSha256: createHash("sha256").update(token).digest("hex"),
        expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 3600,
        revoked: false,
      },
    ],
    adminCredentials: [
      {
        id: "synthetic-admin",
        tokenSha256: createHash("sha256").update(randomBytes(32)).digest("hex"),
        expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 3600,
        revoked: false,
      },
    ],
    credentialRateLimit: { maxRequests: 120, windowSeconds: 60 },
  };
  let app;
  const handler = (req, res) => {
    if (options.tls) {
      req.headers["x-forwarded-proto"] = "https";
      req.headers["x-forwarded-host"] = new URL(config.publicOrigin).host;
    }
    app(req, res);
  };
  const server = options.tls
    ? createHttpsServer(options.tls, handler)
    : createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const host = `127.0.0.1:${server.address().port}`;
  config.publicOrigin = `https://${host}`;
  const requests = [];
  let selectedModel = "gemma4:12b-mlx";
  let calls = 0,
    busy = false;
  const logs = [];
  const speech = createSpeechService({
    paths: { speechDirectory: () => root },
    adapter: {
      identity: "synthetic",
      transcribe:
        options.transcribe ??
        (async (_file, language) => {
          if (language !== "auto") throw new Error();
          return "Explain a research question.";
        }),
    },
    ttsAdapter: {
      identity: "synthetic-local-tts",
      async synthesize(text, language, output) {
        if (options.synthesize) {
          await options.synthesize(text, language, output);
          return;
        }
        const samples = new Int16Array(1600).fill(
          language === "zh" ? 600 : 400,
        );
        const bytes = Buffer.alloc(44 + samples.byteLength);
        bytes.write("RIFF");
        bytes.writeUInt32LE(bytes.length - 8, 4);
        bytes.write("WAVEfmt ", 8);
        bytes.writeUInt32LE(16, 16);
        bytes.writeUInt16LE(1, 20);
        bytes.writeUInt16LE(1, 22);
        bytes.writeUInt32LE(16000, 24);
        bytes.writeUInt32LE(32000, 28);
        bytes.writeUInt16LE(2, 32);
        bytes.writeUInt16LE(16, 34);
        bytes.write("data", 36);
        bytes.writeUInt32LE(samples.byteLength, 40);
        for (let i = 0; i < samples.length; i++)
          bytes.writeInt16LE(samples[i], 44 + i * 2);
        writeFileSync(output, bytes, { flag: "wx", mode: 0o600 });
      },
    },
  });
  app = createApp({
    ...(options.history ? { history: options.history } : {}),
    access: options.access ?? createAccessController(config),
    browserAccess: config,
    ...(options.now ? { browserNow: options.now } : {}),
    ...(options.webRoot ? { webRoot: options.webRoot } : {}),
    logger: { write: (v) => logs.push(v) },
    input: {
      ...(options.history ? { history: options.history } : {}),
      localState: () => ({ selectedModel, residency: "UNLOADED" }),
      async switchLocal(model) {
        selectedModel = model;
        return true;
      },
      buildIdentity: "a".repeat(40),
      speech: options.speechState
        ? {
            ...speech,
            status: () =>
              typeof options.speechState === "function"
                ? options.speechState()
                : options.speechState,
            ...(options.ttsState
              ? {
                  ttsStatus: () =>
                    typeof options.ttsState === "function"
                      ? options.ttsState()
                      : options.ttsState,
                }
              : {}),
          }
        : options.ttsState
          ? {
              ...speech,
              ttsStatus: () =>
                typeof options.ttsState === "function"
                  ? options.ttsState()
                  : options.ttsState,
            }
          : speech,
      capabilities: options.capabilities ?? capabilities,
      acquire() {
        if (busy) return;
        busy = true;
        return () => {
          busy = false;
        };
      },
      async execute(request, signal, sessionRef, trace, source) {
        calls++;
        requests.push(structuredClone(request));
        if (options.execute)
          return options.execute(request, signal, sessionRef, trace, source);
        await new Promise((r) =>
          setTimeout(r, request.input.text.includes("slow") ? 3000 : 20),
        );
        const allowed = capabilities(request.input.text).modes.some(
          (m) => m.id === request.mode,
        );
        if (!allowed) throw new Error("Synthetic policy denial");
        const result = {
          contractVersion: "provider-run-result.v1",
          interactionRef: `interaction-${randomUUID()}`,
          mode: request.mode,
          ...(request.mode === "COMPARE"
            ? { comparisonRef: `comparison-${randomUUID()}` }
            : {}),
          legs: (request.mode === "COMPARE"
            ? ["LOCAL", "OPENAI"]
            : [request.mode]
          ).map((provider) => ({
            runRef: `run-${randomUUID()}`,
            provider,
            model:
              provider === "LOCAL" ? request.localModel : "synthetic-cloud",
            status: "COMPLETED",
            provenance: {
              actualProvider: provider,
              actualModel:
                provider === "LOCAL" ? request.localModel : "synthetic-cloud",
              adapter: "synthetic",
            },
            output: {
              text:
                (typeof options.answerText === "function"
                  ? options.answerText(request)
                  : options.answerText) ??
                "A focused research question names what you want to understand and what evidence could help.\n\n" +
                  "Narrow the scope, compare explanations, and identify a limitation. Use only approved data and keep your reasoning visible.\n\n".repeat(
                    1,
                  ),
            },
            metrics: { latencyMs: 20 },
          })),
        };
        const grounding =
          typeof options.grounding === "function"
            ? options.grounding(request)
            : options.grounding;
        return grounding ? { ...result, grounding } : result;
      },
    },
  });
  const origin = `${options.tls ? "https" : "http"}://${host}`;
  const request = (route, init = {}) => {
    const headers = {
      "x-forwarded-proto": "https",
      "x-forwarded-host": host,
      origin: config.publicOrigin,
      ...init.headers,
    };
    if (!options.tls) return fetch(origin + route, { ...init, headers });
    // Isolated test certificate on this fixture's loopback server only.
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        origin + route,
        { method: init.method ?? "GET", headers, rejectUnauthorized: false },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const h = new Headers();
            for (const [key, value] of Object.entries(res.headers))
              if (value)
                h.set(key, Array.isArray(value) ? value.join(",") : value);
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: h,
              }),
            );
          });
        },
      );
      req.on("error", reject);
      req.end(init.body);
    });
  };
  async function device() {
    const owner = randomBytes(32).toString("hex");
    return {
      send: (route, init = {}) =>
        request(route, {
          ...init,
          headers: { "x-owner-client": owner, ...init.headers },
        }),
    };
  }
  return {
    config,
    token,
    request,
    device,
    origin,
    host,
    logs,
    calls: () => calls,
    requests,
    close() {
      app.locals.closeInput();
      server.closeAllConnections();
      server.close();
      rmSync(root, { recursive: true, force: true });
    },
    app,
  };
}
