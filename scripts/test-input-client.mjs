import {
  createProviderOrchestrator,
  createProviderHealthController,
} from "@laita/orchestration";
import {
  createFakeProviderAdapter,
  fakeProviderConfiguration,
} from "@laita/providers/test-support";
import { parseConfiguration } from "@laita/runtime";
import {
  createCapabilityEvaluator,
  createDemoCapabilityContext,
} from "@laita/policy";
import test from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyInput } from "@laita/safety";
import { fixture, capabilities } from "../apps/api/test/browser-fixture.mjs";
import { LearningClient } from "../apps/web/src/client/controller.ts";
import { InputApi } from "../apps/web/src/client/api.ts";
import { wav } from "../apps/web/src/client/microphone.ts";
import { validateWav } from "@laita/speech";
async function clientFixture(t, options = {}) {
  const f = await fixture(options);
  const routes = [];
  const uploads = [];
  const fetcher = async (route, init) => {
    routes.push(route);
    if (route.endsWith("/transcriptions"))
      uploads.push(init.headers["x-input-language"]);
    assert.ok(
      /^\/api\/v1\/(input\/(sessions|session|build|choices|model|interactions|transcriptions|turns|turns\/[a-f0-9]{64}\/unsubmitted|jobs\/[a-f0-9]{64}))$/.test(
        route,
      ),
    );
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.mode, "same-origin");
    assert.equal(init.redirect, "error");
    if (options.speechTerminal && route.endsWith("/transcriptions")) {
      return Response.json(
        {
          contractVersion: "input-job.v1",
          jobRef: "a".repeat(64),
          sequence: 1,
          state: options.speechTerminal,
          cleanup:
            options.speechTerminal === "CLEANUP_FAILED" ? "FAILED" : "DELETED",
        },
        { status: 202 },
      );
    }
    const r = await f.request(route, {
      ...init,
      headers: init.headers,
    });
    return r;
  };
  const c = new LearningClient(() => {}, new InputApi(fetcher), 5);
  t.after(() => {
    c.close();
    f.close();
  });
  await c.boot();
  assert.equal(c.phase, "idle");
  return { c, f, routes, uploads };
}
test("real typed client uses fresh choices, build, jobs, provenance and independent Compare", async (t) => {
  const { c, f, routes } = await clientFixture(t);
  assert.equal(c.build.commit, "a".repeat(40));
  await c.send("Explain a research question.");
  assert.equal(c.phase, "success");
  assert.equal(f.calls(), 1);
  assert.equal(c.messages[1].provider, "Local");
  assert.match(c.messages[1].provenance, /gemma4:12b-mlx/);
  await c.reset();
  c.select("COMPARE");
  await c.send("Compare explanations.");
  assert.equal(c.phase, "success");
  assert.deepEqual(
    c.messages.slice(1).map((m) => m.provider),
    ["Local", "OpenAI"],
  );
  await c.reset();
  c.select("OPENAI");
  await c.send("private question");
  assert.equal(f.calls(), 2);
  assert.equal(c.phase, "idle");
  assert.match(c.status, /isn’t available/);
  assert.equal(c.mode, "OPENAI");
  c.select("LOCAL");
  await c.send("unavailable question");
  assert.equal(f.calls(), 2);
  assert.match(c.status, /isn’t available/);
  assert.ok(
    routes.every((r) => !r.includes("admin") && !r.includes("pairings")),
  );
});
test("grounded Local result reaches the shared client with exact inspectable sources", async (t) => {
  const commit = "b".repeat(40);
  const { c } = await clientFixture(t, {
    execute(request) {
      return {
        contractVersion: "provider-run-result.v1",
        interactionRef: `interaction-${randomUUID()}`,
        mode: "LOCAL",
        legs: [
          {
            runRef: `run-${randomUUID()}`,
            provider: "LOCAL",
            model: request.localModel,
            status: "COMPLETED",
            provenance: {
              actualProvider: "LOCAL",
              actualModel: request.localModel,
              adapter: "synthetic",
            },
            output: { text: "Three worksheets and one dashboard." },
            metrics: { latencyMs: 1 },
          },
        ],
        grounding: {
          status: "GROUNDED",
          course: "IA342",
          snapshot: commit,
          sources: [
            {
              course: "IA342",
              repository: "JMU-Data/IA342",
              commit,
              path: "docs/assignments/lab-5/index.md",
              section: "Submission",
              url: `https://github.com/JMU-Data/IA342/blob/${commit}/docs/assignments/lab-5/index.md#submission`,
              excerpt: "There is no Canvas submission for this lab.",
            },
          ],
        },
      };
    },
  });
  await c.send("What must students submit for IA342 Lab 5?");
  assert.equal(c.phase, "success");
  assert.equal(c.messages[1].provider, "Local");
  assert.equal(c.messages[1].sources.length, 1);
  assert.equal(
    c.messages[1].sources[0].path,
    "docs/assignments/lab-5/index.md",
  );
  assert.equal(c.messages[1].sources[0].commit, commit);
  await c.reset();
  assert.equal(c.messages.length, 0);
});
test("valid automatic bilingual STT displays transcript and submits exactly once", async (t) => {
  const { c, f, uploads } = await clientFixture(t);
  assert.ok(c.beginListening());
  const bytes = wav(new Int16Array(3200).fill(400));
  await c.upload(bytes);
  assert.ok(bytes.every((v) => v === 0));
  assert.equal(c.phase, "success");
  assert.equal(c.messages[0].text, "Explain a research question.");
  assert.equal(f.calls(), 1);
  assert.deepEqual(uploads, [undefined]);
  await c.upload(wav(new Int16Array(3200).fill(400)));
  assert.equal(f.calls(), 1);
});
test("cancel/reset reject a late fake provider completion while preserving browser auth", async (t) => {
  const { c, f } = await clientFixture(t);
  const pending = c.send("slow question");
  while (f.calls() === 0) await new Promise((r) => setTimeout(r, 5));
  await c.cancel();
  await c.reset();
  await pending;
  assert.equal(c.messages.length, 0);
  assert.equal(c.connected, true);
  assert.equal(c.phase, "idle");
  assert.equal(f.calls(), 1);
});
test("WAV boundary rejects invalid length and keeps the 15-second limit", () => {
  assert.throws(() => wav(new Int16Array(1599)));
  assert.throws(() => wav(new Int16Array(240001)));
  assert.equal(wav(new Int16Array(240000)).length, 480044);
});
test("reset does not claim success for malformed or failed acknowledgements", async () => {
  let reply;
  const api = new InputApi(async () => Response.json(reply));
  reply = {
    contractVersion: "input-session.v1",
    sessionRef: "a".repeat(64),
    limits: {
      maxSessions: 16,
      maxJobs: 16,
      observationMs: 300000,
      uploadMs: 20000,
      uploadBytes: 524288,
      uploadChunks: 1024,
    },
  };
  await api.start();
  reply = {
    contractVersion: "input-reset.v1",
    state: "RESET",
    cleanup: "FAILED",
  };
  await assert.rejects(api.reset());
});

test("voice-first discovery enables Mic after direct entry and New conversation without authorizing empty inference", async (t) => {
  const observed = [];
  const { c, f } = await clientFixture(t, {
    capabilities(text) {
      observed.push(text);
      return capabilities(text);
    },
  });
  assert.deepEqual(observed, [undefined]);
  assert.equal(c.choices.speech, "READY");
  assert.equal(c.canListen, true);
  for (const text of [" ", "\n\t"]) {
    await c.refreshChoices(text);
    assert.equal(observed.at(-1), undefined);
    assert.equal(c.canListen, true);
  }
  await c.send("");
  await c.send("   ");
  assert.equal(f.calls(), 0);
  assert.equal(classifyInput(""), undefined);
  assert.equal(classifyInput("   "), undefined);
  await c.reset();
  assert.equal(observed.at(-1), undefined);
  assert.equal(c.phase, "idle");
  assert.equal(c.messages.length, 0);
  assert.equal(c.canListen, true);
  assert.equal(c.beginListening(), true);
  await c.cancel();
  await c.reset();
  assert.equal(c.canListen, true);
  c.close();
  assert.equal(c.canListen, false);
});

for (const speechState of ["DISABLED", "BUSY", "CLEANUP_FAILED"]) {
  test(`speech ${speechState} keeps Mic disabled after entry and reset`, async (t) => {
    const { c } = await clientFixture(t, { speechState });
    assert.equal(c.choices.speech, speechState);
    assert.equal(c.canListen, false);
    assert.equal(c.beginListening(), false);
    await c.reset();
    assert.equal(c.canListen, false);
  });
}

test("real bounded history reaches requests; reset removes it and selected Llama reaches Compare", async (t) => {
  const { c, f } = await clientFixture(t);
  await c.send("用中文解释二叉树。");
  await c.send("给一个例子。");
  assert.equal(f.requests[1].input.history[0].content, "用中文解释二叉树。");
  assert.equal(f.requests[1].input.history[1].role, "ASSISTANT");
  await c.selectLocalModel("llama3.1:8b");
  c.select("COMPARE");
  await c.send("Compare examples.");
  assert.equal(f.requests[2].localModel, "llama3.1:8b");
  assert.equal(f.requests[2].mode, "COMPARE");
  await c.reset();
  await c.send("Fresh.");
  assert.deepEqual(f.requests[3].input.history, []);
});
for (const transcript of ["", "password = synthetic"])
  test(`invalid transcript never invokes a provider: ${transcript.length}`, async (t) => {
    const { c, f } = await clientFixture(t, {
      transcribe: async () => transcript,
    });
    c.beginListening();
    await c.upload(wav(new Int16Array(3200).fill(400)));
    assert.equal(f.calls(), 0);
    assert.equal(c.phase, "error");
  });

// Exercise the real client -> input routes -> orchestrator -> adapter boundary.
for (const { failed, long = false } of [
  {},
  { failed: "LOCAL" },
  { failed: "OPENAI" },
  { long: true },
]) {
  test(`two-turn Compare isolates assistant history, first failure=${failed ?? "none"}, long=${long}`, async (t) => {
    const parsed = parseConfiguration(
      readFileSync(
        new URL(
          "../packages/runtime/examples/openai-demo.example.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    assert.equal(parsed.ok, true);
    parsed.value.provenance = {
      demoProfileVersion: "demo-profile.v4",
      policyVersion: "demo-policy.v4",
    };
    const evaluator = createCapabilityEvaluator(parsed.value);
    const context = createDemoCapabilityContext("INSTRUCTOR");
    const health = createProviderHealthController({
      localModels: parsed.value.providers.local.candidates,
      openaiModels: [parsed.value.providers.openai.model],
      selectedLocalModel: parsed.value.providers.local.model,
      selectedOpenAIModel: parsed.value.providers.openai.model,
    });
    health.setStatus("LOCAL", parsed.value.providers.local.model, "READY");
    health.setStatus("OPENAI", parsed.value.providers.openai.model, "READY");
    const base = {
      evaluator,
      context,
      health,
      authorization: {
        authorize: (selection, identity) => ({
          ok: true,
          value: evaluator.authorizeSelection(
            context,
            { emergencyStop: false, ...health.capabilityControls() },
            selection,
            identity,
          ),
        }),
      },
      // Synthetic accounting port; reservation arithmetic is covered in orchestration tests.
      usage: {
        admit: () => ({ ok: true, value: {} }),
        finalize: () => ({ ok: true, value: { estimatedCostNanoUsd: null } }),
      },
    };
    base.context.dataClass = "IDENTITY_MINIMIZED_USER_TEXT";
    const observed = { LOCAL: [], OPENAI: [] };
    const adapters = Object.fromEntries(
      ["LOCAL", "OPENAI"].map((provider) => [
        provider,
        {
          provider,
          configuration: fakeProviderConfiguration,
          invoke(request, context) {
            observed[provider].push(request);
            return createFakeProviderAdapter({
              provider,
              scenario:
                provider === failed && observed[provider].length === 1
                  ? "UNAVAILABLE"
                  : "SUCCESS",
              output:
                provider === "LOCAL"
                  ? "LOCAL_UNIQUE_CEDAR" + (long ? "x".repeat(1300) : "")
                  : "OPENAI_UNIQUE_CORAL",
            }).invoke(request, context);
          },
        },
      ]),
    );
    const service = createProviderOrchestrator({
      adapters,
      health: base.health,
      authorization: base.authorization,
      usage: base.usage,
      timeoutMs: 1000,
    });
    const f = await fixture({
      capabilities: () =>
        base.evaluator.availability(base.context, {
          emergencyStop: false,
          ...base.health.capabilityControls(),
        }),
      execute: (request, signal) =>
        service.execute({
          request,
          context: base.context,
          sessionRef: "session-123e4567-e89b-42d3-a456-426614174000",
          signal,
        }),
    });
    const c = new LearningClient(
      () => {},
      new InputApi((route, init) => f.request(route, init)),
      1,
    );
    t.after(() => {
      c.close();
      f.close();
    });
    await c.boot();
    c.select("COMPARE");
    await c.send("解释树。");
    assert.equal(c.phase, "success");
    await c.send("Continue with an example.");
    assert.equal(c.phase, "success");
    for (const provider of ["LOCAL", "OPENAI"]) {
      const messages = observed[provider][1].input.messages;
      const text = JSON.stringify(messages);
      const own =
        provider === "LOCAL" ? "LOCAL_UNIQUE_CEDAR" : "OPENAI_UNIQUE_CORAL";
      const peer =
        provider === "LOCAL" ? "OPENAI_UNIQUE_CORAL" : "LOCAL_UNIQUE_CEDAR";
      assert.equal(text.includes(own), provider !== failed);
      assert.equal(text.includes(peer), false);
      assert.deepEqual(
        messages.filter((m) => m.role === "USER").map((m) => m.content),
        ["解释树。", "Continue with an example."],
      );
      assert.ok(messages.every((m) => !("provider" in m)));
    }
    // Switching modes preserves USER continuity, never imports the other branch.
    c.select("LOCAL");
    await c.send("Local follow-up.");
    c.select("OPENAI");
    await c.send("Cloud follow-up.");
    const cloud = observed.OPENAI.at(-1).input.messages;
    assert.equal(JSON.stringify(cloud).includes("LOCAL_UNIQUE_CEDAR"), false);
    assert.ok(
      cloud.some((m) => m.role === "USER" && m.content === "Local follow-up."),
    );
    if (long) {
      c.select("COMPARE");
      for (let i = 0; i < 5; i++) await c.send(`Bounded follow-up ${i}.`);
      const branches = ["LOCAL", "OPENAI"].map((provider) =>
        observed[provider].at(-1).input.messages.slice(1),
      );
      assert.deepEqual(
        branches[0].filter((m) => m.role === "USER"),
        branches[1].filter((m) => m.role === "USER"),
      );
      for (const [i, messages] of branches.entries()) {
        assert.ok(messages.length <= 7); // 6 history plus current question
        assert.ok(
          Buffer.byteLength(messages.map((m) => m.content).join("")) <= 2800,
        );
        assert.equal(
          JSON.stringify(messages).includes(
            i === 0 ? "OPENAI_UNIQUE_CORAL" : "LOCAL_UNIQUE_CEDAR",
          ),
          false,
        );
        assert.equal(
          messages.some((m) => m.content === "解释树。"),
          false,
        );
        assert.ok(messages.some((m) => m.content === "Bounded follow-up 4."));
        assert.ok(messages.some((m) => m.role === "ASSISTANT"));
      }
    }
    await c.reset();
    c.select("COMPARE");
    await c.send("Fresh question.");
    for (const provider of ["LOCAL", "OPENAI"])
      assert.deepEqual(
        observed[provider].at(-1).input.messages.map((m) => m.role),
        ["SYSTEM", "USER"],
      );
  });
}

for (const code of [
  "TIMEOUT",
  "MODEL_LOADING",
  "PROVIDER_BUSY",
  "SELECTED_MODEL_UNAVAILABLE",
  "SELECTED_PROVIDER_UNAVAILABLE",
  "TEMPORARY_PROVIDER_FAILURE",
  "POLICY_DENIED",
  "INTERNAL_FAILURE",
]) {
  test(`Compare preserves the successful peer and shows safe Local ${code} without retry`, async (t) => {
    const { c, f } = await clientFixture(t, {
      execute: async (request) => ({
        contractVersion: "provider-run-result.v1",
        interactionRef: `interaction-${randomUUID()}`,
        mode: "COMPARE",
        comparisonRef: `comparison-${randomUUID()}`,
        legs: [
          {
            runRef: `run-${randomUUID()}`,
            provider: "LOCAL",
            model: request.localModel,
            status: "FAILED",
            failure: { code, retryable: code !== "POLICY_DENIED" },
            metrics: { latencyMs: 30002 },
          },
          {
            runRef: `run-${randomUUID()}`,
            provider: "OPENAI",
            model: "synthetic-cloud",
            status: "COMPLETED",
            output: { text: "Independent OpenAI answer" },
            provenance: {
              actualProvider: "OPENAI",
              actualModel: "synthetic-cloud",
              adapter: "synthetic",
            },
            metrics: { latencyMs: 10 },
          },
        ],
      }),
    });
    assert.equal(c.choices.local.residency, "UNLOADED");
    c.select("COMPARE");
    await c.send("Synthetic question");
    assert.equal(f.calls(), 1);
    assert.equal(c.messages[1].provider, "Local");
    assert.equal(c.messages[1].error, true);
    assert.doesNotMatch(
      c.messages[1].text,
      /This answer is unavailable|couldn’t finish/,
    );
    if (code === "TIMEOUT")
      assert.match(c.messages[1].text, /Local model took too long/);
    assert.equal(c.messages[2].provider, "OpenAI");
    assert.equal(c.messages[2].text, "Independent OpenAI answer");
    assert.equal(c.messages[2].error, false);
  });
}

for (const [state, message] of Object.entries({
  INVALID: "The recorded audio could not be processed. Please try again.",
  TIMEOUT: "Speech recognition took too long. Please try again.",
  FAILED: "Local speech recognition could not complete this recording.",
  CLEANUP_FAILED:
    "Speech recognition is temporarily unavailable while audio cleanup recovers.",
  CANCELLED: "Cancelled. Ask whenever you’re ready.",
})) {
  test(`speech ${state} uses fixed public copy without provider submission`, async (t) => {
    const { c, f, routes } = await clientFixture(t, { speechTerminal: state });
    assert.ok(c.beginListening());
    const audio = wav(new Int16Array(3200).fill(400));
    await c.upload(audio);
    assert.equal(c.phase, state === "CANCELLED" ? "cancelled" : "error");
    assert.equal(c.status, message);
    assert.equal(f.calls(), 0);
    assert.ok(!routes.some((route) => route.endsWith("/interactions")));
    assert.ok(audio.every((byte) => byte === 0));
    assert.equal(c.messages.length, 0);
  });
}
