import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
function protectedBytes(file, max) {
  if (!path.isAbsolute(file) || realpathSync(file) !== file) throw new Error();
  const stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.nlink !== 1 ||
    stat.size > max
  )
    throw new Error();
  return readFileSync(file);
}
// The transport seam lets CI prove the full bounded sequence without a provider.
export async function runInputAcceptance(
  request,
  audio,
  pause = () => new Promise((r) => setTimeout(r, 1000)),
  expectedBuild,
) {
  let session,
    sequence = 0;
  const owner = randomBytes(32).toString("hex");
  const call = (route, method, body, headers = {}) =>
    request(route, {
      method,
      headers: {
        "x-owner-client": owner,
        "x-input-sequence": String(++sequence),
        ...(session ? { "x-input-session": session } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body } : {}),
    });
  const poll = async (job) => {
    for (let i = 0; i < 300; i++) {
      const value = await call("/jobs/" + job, "GET");
      if (!["ACCEPTED", "PROCESSING"].includes(value.state)) return value;
      await pause();
    }
    throw new Error();
  };
  const infer = async (text, source, transcriptRef) => {
    const choices = await call("/choices", "POST", JSON.stringify({ text }), {
      "content-type": "application/json",
    });
    const model = choices.providers?.providers?.find((p) => p.id === "LOCAL")
      ?.models?.[0]?.id;
    if (!model) throw new Error();
    const accepted = await call(
      "/interactions",
      "POST",
      JSON.stringify({
        contractVersion: "input-submission.v1",
        clientKind: "COMPUTER",
        source,
        ...(transcriptRef ? { transcriptRef } : {}),
        request: {
          contractVersion: "provider-run-request.v1",
          clientRequestId: randomUUID(),
          mode: "LOCAL",
          localModel: model,
          input: { text },
          capabilityIdentity: choices.providers.identity,
        },
      }),
      { "content-type": "application/json" },
    );
    const result = await poll(accepted.jobRef);
    if (
      result.state !== "COMPLETED" ||
      result.result?.legs?.length !== 1 ||
      result.result.legs[0].status !== "COMPLETED" ||
      typeof result.result.legs[0].output?.text !== "string"
    )
      throw new Error();
  };
  try {
    session = (await call("/sessions", "POST")).sessionRef;
    if (!/^[a-f0-9]{64}$/.test(session)) throw new Error();
    if (expectedBuild) {
      const build = await call("/build", "GET");
      if (
        build.commit !== expectedBuild.commit ||
        build.profileVersion !== "demo-profile.v4" ||
        build.sttIdentity !== expectedBuild.sttIdentity
      )
        throw new Error();
    }
    await infer("Explain a tree.", "TYPED");
    const accepted = await call("/transcriptions", "POST", audio, {
      "content-type": "audio/wav",
      "idempotency-key": randomBytes(32).toString("hex"),
      "x-input-client": "COMPUTER",
      "x-input-consent": "press-to-talk",
    });
    const speech = await poll(accepted.jobRef);
    if (
      speech.state !== "REVIEW" ||
      speech.cleanup !== "DELETED" ||
      !speech.transcript?.text
    )
      throw new Error();
    // Authorized canary mirrors one automatic browser transcript submission.
    await infer(
      speech.transcript.text,
      "TRANSCRIPT",
      speech.transcript.transcriptRef,
    );
    return {
      contractVersion: "input-acceptance.v1",
      typed: "PASS",
      speechReview: "PASS",
      cleanup: "DELETED",
      inferenceRequests: 2,
    };
  } finally {
    if (session) await call("/session", "DELETE");
  }
}
async function main() {
  if (
    process.argv.length !== 5 ||
    process.argv[2] !== "--live" ||
    !/^[a-f0-9]{40}$/.test(process.argv[3])
  )
    throw new Error();
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const git = (args) =>
    spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 65536,
    });
  const head = git(["rev-parse", "HEAD"]),
    state = git(["status", "--porcelain"]);
  if (
    head.status !== 0 ||
    state.status !== 0 ||
    state.stdout ||
    head.stdout.trim() !== process.argv[3]
  )
    throw new Error();
  const manifest = JSON.parse(protectedBytes(process.argv[4], 4096));
  if (
    manifest.approvedCommit !== process.argv[3] ||
    manifest.maxInferenceRequests !== 2 ||
    manifest.runtimeBuildVerified !== true ||
    manifest.sttIdentity !== "whisper.cpp/1.8.3/small-multilingual/ggml-f16"
  )
    throw new Error();
  const configuration = JSON.parse(
    protectedBytes(manifest.configurationFile, 65536),
  );
  if (configuration.provenance.demoProfileVersion !== "demo-profile.v4")
    throw new Error();
  if (
    configuration.access.mode !== "single-operator" ||
    !configuration.access.enabled ||
    configuration.access.maintenanceMode ||
    manifest.ownerNetworkVerified !== true
  )
    throw new Error();
  const audio = protectedBytes(manifest.syntheticAudioFile, 524288);
  if (
    createHash("sha256").update(audio).digest("hex") !==
    manifest.syntheticAudioSha256
  )
    throw new Error();
  const origin = new URL(configuration.access.publicOrigin);
  if (origin.protocol !== "https:") throw new Error();
  const started = Date.now();
  try {
    const result = await runInputAcceptance(
      async (route, init) => {
        const response = await fetch(new URL("/api/v1/input" + route, origin), {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(35000),
          headers: { ...init.headers, origin: origin.origin },
        });
        if (!response.ok) throw new Error();
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 150000) throw new Error();
          chunks.push(chunk);
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      },
      audio,
      undefined,
      { commit: manifest.approvedCommit, sttIdentity: manifest.sttIdentity },
    );
    console.log(
      JSON.stringify({
        ...result,
        approvedCommit: manifest.approvedCommit,
        runtimeBuildIdentity: "OPERATOR_VERIFIED_BEFORE_RUN",
        sttIdentity: manifest.sttIdentity,
        latencyMs: Date.now() - started,
        memoryPressure: null,
        memoryReason: "USE_REVIEWED_DEPLOYMENT_RESOURCE_CAPTURE",
      }),
    );
  } finally {
    audio.fill(0);
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch(() => {
    console.log(
      JSON.stringify({
        status: "NOT_ACCEPTED",
        nextAction: "REVIEW_SANITIZED_GATE_RESULTS",
      }),
    );
    process.exitCode = 1;
  });
