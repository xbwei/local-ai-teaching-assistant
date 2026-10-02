import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { installInputRoutes } from "../dist/input.js";
import { createSpeechService } from "@laita/speech";
import { initializePersistence } from "@laita/persistence";
import { classifyInput } from "@laita/safety";
import { validConversation } from "@laita/contracts";
import { createCourseGrounder } from "@laita/course-grounding";
import { createCourseAwareExecution } from "../dist/course-execution.js";
import {
  createGoldenGrounder,
  publicCourses,
} from "./course-golden-fixture.mjs";
const identity = {
  policy: {
    runtimeDigest: `sha256:${"a".repeat(64)}`,
    profileVersion: "demo-profile.v4",
    policyVersion: "demo-policy.v4",
    providerPolicyVersion: "demo-provider-eligibility.v4",
    classificationVersion: "data-classification.v1",
    retentionPolicyVersion: "retention-policy.v1",
    gradingBoundaryVersion: "grading-boundary.v1",
  },
  configuration: {
    version: "application-configuration.v2",
    digest: `sha256:${"b".repeat(64)}`,
  },
};

test("safe current course question survives unsafe synthetic assistant history", async (t) => {
  const text = "What must I submit for IA340 Lab 4?";
  const history = [
    { role: "USER", content: "Explain relational databases." },
    {
      role: "ASSISTANT",
      provider: "LOCAL",
      content: "fixture@example.invalid",
    },
    { role: "USER", content: "Give me one short example." },
    {
      role: "ASSISTANT",
      provider: "LOCAL",
      content: "Two tables share a key.",
    },
  ];
  assert.ok(classifyInput(text));
  assert.equal(classifyInput(history[1].content), undefined);
  assert.equal(validConversation(text, history), true);
  let used;
  const f = await fixture(t, {
    recordHistory: true,
    observeExecution: (req) => {
      used = req;
    },
  });
  const session = await f.start();
  const value = submission();
  value.request.input = { text, history };
  const response = await f.request("/interactions", {
    session,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  assert.equal(response.status, 202);
  const result = await f.poll((await response.json()).jobRef, session);
  assert.equal(result.state, "COMPLETED");
  assert.equal(f.calls, 1);
  assert.equal(used.input.text, text);
  assert.deepEqual(used.input.history, history.slice(2));
});

test("safety fitting keeps the minimal whole safe suffix and never exempts a history role", async (t) => {
  const user = (content) => ({ role: "USER", content });
  const answer = (content, provider = "LOCAL") => ({
    role: "ASSISTANT",
    provider,
    content,
  });
  const recent = [user("Recent question."), answer("Recent answer.")];
  const safe = [user("Earlier question."), answer("Earlier answer.")];
  const unsafeUser = [user("password = synthetic"), answer("Earlier answer.")];
  const unsafeAnswer = [
    user("Earlier question."),
    answer("fixture@example.invalid"),
  ];
  for (const [name, history, removed] of [
    ["empty", [], 0],
    ["all safe", [...safe, ...recent], 0],
    ["unsafe USER", [...unsafeUser, ...recent], 2],
    ["unsafe ASSISTANT", [...unsafeAnswer, ...recent], 2],
    ["offending middle turn", [...safe, ...unsafeAnswer, ...recent], 4],
    ["multiple unsafe turns", [...unsafeUser, ...unsafeAnswer, ...recent], 4],
    ["nothing remains", unsafeAnswer, 2],
    [
      "both assistant legs",
      [...unsafeAnswer, answer("Safe peer leg.", "OPENAI"), ...recent],
      3,
    ],
    [
      "unsafe unselected leg",
      [...safe, answer("fixture@example.invalid", "OPENAI"), ...recent],
      3,
    ],
    [
      "orphan assistant prefix",
      [
        answer("Safe orphan."),
        answer("fixture@example.invalid", "OPENAI"),
        ...recent,
      ],
      2,
    ],
    ["unanswered USER", [user("password = synthetic"), ...recent], 1],
  ])
    await t.test(name, async (t) => {
      let used;
      const f = await fixture(t, {
        recordHistory: true,
        observeExecution: (req) => {
          used = req;
        },
      });
      const session = await f.start();
      const value = submission();
      value.request.input.history = history;
      const original = structuredClone(value);
      assert.equal(validConversation(value.request.input.text, history), true);
      const response = await f.request("/interactions", {
        session,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      });
      assert.equal(response.status, 202);
      const job = await f.poll((await response.json()).jobRef, session);
      assert.equal(job.state, "COMPLETED");
      assert.equal(f.calls, 1);
      assert.deepEqual(used, {
        ...value.request,
        input: { ...value.request.input, history: history.slice(removed) },
      });
      assert.ok(used.input.history.every((m) => classifyInput(m.content)));
      assert.deepEqual(value, original);
      const turn = f.history.conversation(job.history.conversation).turns[0];
      assert.equal(turn.text, value.request.input.text);
      assert.equal(turn.suspected, false);
      const events = turn.events.filter((e) => e.stage === "SAFETY");
      assert.deepEqual(
        events.map((e) => e.outcome),
        removed ? ["PASSED", "HISTORY_REDUCED"] : ["PASSED"],
      );
      for (const event of events)
        assert.deepEqual(Object.keys(event).sort(), [
          "at",
          "origin",
          "outcome",
          "stage",
        ]);
      assert.doesNotMatch(
        JSON.stringify(turn),
        /fixture@example\.invalid|password = synthetic/,
      );
      assert.equal(f.history.list({ problems: true }).items.length, 0);
      // The original request digest remains authoritative: replay never executes again.
      const replay = await f.request("/interactions", {
        session,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      });
      assert.equal(replay.status, 200);
      assert.equal(f.calls, 1);
    });
});

test("current excluded text is withheld before history fitting or execution", async (t) => {
  const f = await fixture(t, { recordHistory: true });
  const session = await f.start();
  for (const text of [
    "password = synthetic",
    "api_key = synthetic",
    "student record",
    "student score 42",
    "active assessment",
    "fixture@example.invalid",
    "000-00-0000",
    "my name is Synthetic Person",
  ]) {
    assert.equal(classifyInput(text), undefined);
    const value = submission();
    value.request.input = {
      text,
      history: [
        { role: "USER", content: "password = synthetic" },
        {
          role: "ASSISTANT",
          provider: "LOCAL",
          content: "fixture@example.invalid",
        },
      ],
    };
    const response = await f.request("/interactions", {
      session,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    assert.equal(response.status, 400);
    const turn = f.history
      .list({})
      .items.find((x) => x.id === response.headers.get("x-history-turn"));
    const detail = f.history.conversation(turn.conversation, turn.ordinal - 1)
      .turns[0];
    assert.equal(detail.text, null);
    assert.equal(detail.suspected, true);
    assert.deepEqual(
      detail.events.map((e) => [e.stage, e.outcome]),
      [
        ["INPUT", "RECEIVED"],
        ["SAFETY", "REJECTED_TEXT_WITHHELD"],
      ],
    );
    assert.equal(f.calls, 0);
    assert.doesNotMatch(
      JSON.stringify(detail),
      /fixture@example\.invalid|password = synthetic/,
    );
  }
});
const submission = (changes = {}) => ({
  contractVersion: "input-submission.v1",
  clientKind: "PHONE",
  source: "TYPED",
  request: {
    contractVersion: "provider-run-request.v1",
    clientRequestId: randomUUID(),
    mode: "LOCAL",
    localModel: "gemma4:12b-mlx",
    input: { text: "Explain a tree." },
    capabilityIdentity: identity,
  },
  ...changes,
});
function wav() {
  const b = Buffer.alloc(3244);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(b.length - 44, 40);
  for (let i = 44; i < b.length; i += 2) b.writeInt16LE(400, i);
  return b;
}
async function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "input-test-"));
  let busy = false,
    calls = 0;
  const synthesized = [];
  let persistence;
  if (options.recordHistory) {
    const initialized = initializePersistence({
      prepareDatabaseFile: () => ":memory:",
    });
    assert.equal(initialized.ok, true);
    persistence = initialized.value;
    t.after(() => persistence.close());
  }
  const history = persistence?.history();
  const speech = createSpeechService({
    paths: { speechDirectory: () => root },
    adapter: {
      identity: "synthetic",
      transcribe: options.transcribe ?? (async () => "Explain a tree."),
    },
    ttsAdapter: {
      identity: "synthetic-local-tts",
      async synthesize(text, language, output) {
        synthesized.push({ text, language });
        if (options.synthesize) {
          await options.synthesize(text, language, output);
          return;
        }
        writeFileSync(output, wav(), { flag: "wx", mode: 0o600 });
      },
    },
    ...(options.now ? { now: options.now } : {}),
  });
  const ports = {
    speech,
    ...(history ? { history } : {}),
    ...(options.localState ? { localState: options.localState } : {}),
    acquire() {
      if (busy) return;
      busy = true;
      options.onAcquire?.();
      return () => {
        busy = false;
        options.onRelease?.();
      };
    },
    capabilities: options.capabilities ?? (() => undefined),
    async execute(req, signal, sessionRef, trace, source) {
      calls++;
      options.observeExecution?.(req, source);
      assert.deepEqual(readdirSync(root), []);
      if (options.execute)
        return options.execute(req, signal, sessionRef, trace, source);
      return {
        contractVersion: "provider-run-result.v1",
        interactionRef: `interaction-${randomUUID()}`,
        mode: "LOCAL",
        legs: [
          {
            runRef: `run-${randomUUID()}`,
            provider: "LOCAL",
            model: req.localModel,
            status: "COMPLETED",
            provenance: {
              actualProvider: "LOCAL",
              actualModel: req.localModel,
              adapter: "synthetic",
            },
            output: {
              text: options.answerText ?? "A complete synthetic answer.",
            },
            metrics: { latencyMs: 0 },
          },
        ],
      };
    },
  };
  const app = express();
  app.use((_req, res, next) => {
    options.observeResponse?.(res);
    next();
  });
  const controller = installInputRoutes(
    app,
    ports,
    (req, res) => {
      const owner = req.get("authorization");
      if (!owner) {
        res.sendStatus(401);
        return false;
      }
      return { owner, expires: Date.now() + 10000 };
    },
    {
      sessionMs: options.sessionMs ?? 10000,
      uploadMs: 20,
    },
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/api/v1/input`;
  t.after(() => {
    controller.close();
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  let sequence = 0;
  const request = (route, { owner = "owner-a", session, ...init } = {}) =>
    fetch(url + route, {
      ...init,
      headers: {
        authorization: owner,
        "x-input-sequence": String(++sequence),
        ...(session ? { "x-input-session": session } : {}),
        ...init.headers,
      },
    });
  const start = async (owner = "owner-a") =>
    (await (await request("/sessions", { owner, method: "POST" })).json())
      .sessionRef;
  const poll = async (id, session) => {
    for (let i = 0; i < 40; i++) {
      const r = await request("/jobs/" + id, { session });
      const v = await r.json();
      if (!["ACCEPTED", "PROCESSING"].includes(v.state)) return v;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error("job did not settle");
  };
  return {
    url,
    request,
    start,
    poll,
    ports,
    root,
    synthesized,
    history,
    get calls() {
      return calls;
    },
  };
}

test(
  "course deadline/cancellation settles fetch/body cleanup before admission release",
  { timeout: 10000 },
  async (t) => {
    for (const scenario of [
      "stalled fetch",
      "late fetch response",
      "stalled freshness body",
      "slow freshness body",
      "stalled staged blob body",
      "explicit fetch cancel",
      "explicit body cancel",
    ])
      await t.test(scenario, async (t) => {
        const golden = await createGoldenGrounder(t);
        const snapshotFiles = () =>
          Object.fromEntries(
            readdirSync(golden.root, { recursive: true })
              .filter((name) =>
                /current\.json$|manifest\.json$|\/files\//u.test(name),
              )
              .filter((name) => statSync(path.join(golden.root, name)).isFile())
              .map((name) => [
                name,
                readFileSync(path.join(golden.root, name)),
              ]),
          );
        const before = snapshotFiles();
        const statusBefore = JSON.parse(
          readFileSync(path.join(golden.root, "refresh-status.json"), "utf8"),
        );
        let stall = true,
          aborted = false,
          cleaned = false,
          released = 0;
        let providerCalls = 0,
          fetchCalls = 0,
          blobCalls = 0,
          chunks = 0;
        const entered = Promise.withResolvers();
        const abortSeen = Promise.withResolvers();
        const cleanup = Promise.withResolvers();
        t.after(() => cleanup.resolve());
        const fetcher = async (url, init) => {
          fetchCalls++;
          assert.equal(init.method, "GET");
          assert.equal(init.redirect, "error");
          assert.equal(init.signal.aborted, false, "no new fetch after abort");
          const response = await golden.fetcher(
            String(url).replace(
              "c".repeat(40),
              publicCourses[String(url).includes("/IA342/") ? "IA342" : "IA340"]
                .commit,
            ),
          );
          const staged = scenario === "stalled staged blob body";
          if (stall && staged && String(url).endsWith("/commits/main"))
            return Response.json({ sha: "c".repeat(40) });
          const target =
            stall &&
            (!staged ||
              (String(url).includes("/git/blobs/") && ++blobCalls === 2));
          if (!target) return response;
          entered.resolve();
          if (scenario.includes("fetch")) {
            return new Promise((resolve, reject) => {
              init.signal.addEventListener(
                "abort",
                async () => {
                  aborted = true;
                  abortSeen.resolve();
                  await cleanup.promise;
                  cleaned = true;
                  if (scenario === "late fetch response") resolve(response);
                  else reject(init.signal.reason);
                },
                { once: true },
              );
            });
          }
          let interval;
          const body = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"partial":'));
              if (scenario === "slow freshness body")
                interval = setInterval(() => {
                  chunks++;
                  controller.enqueue(new TextEncoder().encode(" "));
                }, 2);
            },
            async cancel(reason) {
              clearInterval(interval);
              assert.equal(
                reason.outcome,
                scenario.startsWith("explicit") ? "CANCELLED" : "TIMEOUT",
              );
              aborted = true;
              abortSeen.resolve();
              await cleanup.promise;
              cleaned = true;
            },
          });
          return new Response(body);
        };
        const execute = createCourseAwareExecution({
          preparationMs: 60,
          grounder: createCourseGrounder(golden.root, {
            fetcher,
            now: () => new Date("2026-09-29T12:00:00.000Z"),
          }),
          async executeProvider(req) {
            providerCalls++;
            return {
              contractVersion: "provider-run-result.v1",
              interactionRef: `interaction-${randomUUID()}`,
              mode: "LOCAL",
              legs: [
                {
                  runRef: `run-${randomUUID()}`,
                  provider: "LOCAL",
                  model: req.localModel,
                  status: "COMPLETED",
                  provenance: {
                    actualProvider: "LOCAL",
                    actualModel: req.localModel,
                    adapter: "synthetic",
                  },
                  output: { text: "Synthetic subsequent answer." },
                  metrics: { latencyMs: 0 },
                },
              ],
            };
          },
        });
        const f = await fixture(t, {
          recordHistory: true,
          execute,
          onRelease: () => {
            assert.equal(cleaned, true);
            released++;
          },
        });
        const session = await f.start();
        const submit = (text) => {
          const value = submission();
          value.request.input.text = text;
          return f.request("/interactions", {
            session,
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(value),
          });
        };
        const accepted = await submit("What must I submit for IA340 Lab 4?");
        assert.equal(accepted.status, 202);
        const job = await accepted.json();
        await entered.promise;
        const cancelled = scenario.startsWith("explicit");
        if (cancelled) {
          const cancel = await f.request("/jobs/" + job.jobRef, {
            session,
            method: "DELETE",
          });
          assert.equal((await cancel.json()).state, "CANCELLED");
        }
        await abortSeen.promise;
        assert.equal(aborted, true);
        assert.equal(providerCalls, 0);
        assert.equal(released, 0);
        assert.equal(cleaned, false);
        const pending = await (
          await f.request("/jobs/" + job.jobRef, { session })
        ).json();
        assert.equal(pending.state, cancelled ? "CANCELLED" : "PROCESSING");
        assert.equal(
          (await submit("Independent ordinary question.")).status,
          503,
        );
        const callsAtAbort = fetchCalls;
        cleanup.resolve();
        // Explicit cancellation publishes immediately; release must still wait
        // for the asynchronous preparation cleanup rather than that job state.
        for (let i = 0; i < 100 && !released; i++)
          await new Promise((resolve) => setTimeout(resolve, 2));
        assert.equal(released, 1);
        const terminal = await f.poll(job.jobRef, session);
        assert.equal(terminal.state, cancelled ? "CANCELLED" : "TIMEOUT");
        assert.equal(terminal.result, undefined);
        assert.equal(providerCalls, 0);
        assert.equal(fetchCalls, callsAtAbort);
        assert.deepEqual(snapshotFiles(), before);
        assert.equal(
          readdirSync(golden.root, { recursive: true }).some((name) =>
            name.includes(".staging-"),
          ),
          false,
        );
        const state = JSON.parse(
          readFileSync(path.join(golden.root, "refresh-status.json"), "utf8"),
        );
        for (const course of ["IA340", "IA342"]) {
          assert.equal(state.courses[course].status, "FAILED");
          assert.equal(
            state.courses[course].commit,
            statusBefore.courses[course].commit,
          );
          assert.equal(
            state.courses[course].checkedAt,
            statusBefore.courses[course].checkedAt,
          );
          assert.equal(
            state.courses[course].refreshedAt,
            statusBefore.courses[course].refreshedAt,
          );
        }
        const turn = f.history
          .conversation(job.history.conversation)
          .turns.find((turn) => turn.id === job.history.turn);
        assert.equal(turn.outcome, cancelled ? "CANCELLED" : "TIMEOUT");
        assert.equal(turn.answers.length, 0);
        assert.ok(
          turn.events.some(
            (e) => e.stage === "RETRIEVAL" && e.outcome === turn.outcome,
          ),
        );
        assert.ok(
          turn.events.some(
            (e) => e.stage === "PROVIDER" && e.outcome === "NOT_EXECUTED",
          ),
        );
        assert.equal(
          turn.events.some(
            (e) => e.stage === "PROVIDER" && e.outcome === "REQUESTED",
          ),
          false,
        );
        if (scenario === "slow freshness body") assert.ok(chunks > 1);
        stall = false;
        const next = await submit("What must I submit for IA340 Lab 4?");
        assert.equal(next.status, 202);
        assert.equal(
          (await f.poll((await next.json()).jobRef, session)).result.grounding
            .status,
          "GROUNDED",
        );
        assert.equal(providerCalls, 1);
        const ordinary = await submit("Explain a tree.");
        assert.equal(ordinary.status, 202);
        assert.equal(
          (await f.poll((await ordinary.json()).jobRef, session)).state,
          "COMPLETED",
        );
        assert.equal(providerCalls, 2);
      });
  },
);
test("four device kinds share typed contract; idempotency replay/conflict and cross-session isolation", async (t) => {
  const f = await fixture(t);
  for (const clientKind of ["PHONE", "TABLET", "COMPUTER", "PI"]) {
    const s = await f.start();
    const v = submission({ clientKind });
    const init = {
      session: s,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(v),
    };
    const accepted = await f.request("/interactions", init);
    assert.equal(accepted.status, 202);
    const j = await accepted.json();
    assert.equal(
      (await f.poll(j.jobRef, s)).result.legs[0].output.text,
      "A complete synthetic answer.",
    );
    assert.equal((await f.request("/interactions", init)).status, 200);
    v.request.input.text += " changed";
    assert.equal(
      (await f.request("/interactions", { ...init, body: JSON.stringify(v) }))
        .status,
      409,
    );
    assert.equal(
      (await f.request("/jobs/" + j.jobRef, { session: s, owner: "owner-b" }))
        .status,
      404,
    );
    const other = await f.start();
    assert.equal(
      (await f.request("/jobs/" + j.jobRef, { session: other })).status,
      404,
    );
  }
  assert.equal(f.calls, 4);
});
test("TTS derives English/Chinese from completed answer legs, consumes media once and never reruns inference", async (t) => {
  for (const [answerText, language] of [
    ["A complete English answer.", "en"],
    ["这是一个完整的中文回答。", "zh"],
  ]) {
    const f = await fixture(t, { answerText });
    const session = await f.start();
    const accepted = await f.request("/interactions", {
      session,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(submission()),
    });
    const job = await f.poll((await accepted.json()).jobRef, session);
    const leg = job.result.legs[0];
    const synthesis = await f.request("/synthesis", {
      session,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractVersion: "tts-synthesis-request.v1",
        jobRef: job.jobRef,
        runRef: leg.runRef,
      }),
    });
    assert.equal(synthesis.status, 200);
    const media = await synthesis.json();
    assert.equal(media.language, language);
    assert.equal(f.synthesized[0].text, answerText);
    assert.equal(f.synthesized[0].language, language);
    const audio = await f.request("/media/" + media.mediaRef, { session });
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get("content-type"), "audio/wav");
    assert.ok((await audio.arrayBuffer()).byteLength >= 44);
    assert.equal(
      (await f.request("/media/" + media.mediaRef, { session })).status,
      404,
    );
    assert.equal(f.calls, 1);
    assert.deepEqual(readdirSync(f.root), []);
  }
});

test("TTS accepts no arbitrary text/path/media URL and reset revokes undelivered audio", async (t) => {
  const f = await fixture(t);
  const session = await f.start();
  const accepted = await f.request("/interactions", {
    session,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(submission()),
  });
  const job = await f.poll((await accepted.json()).jobRef, session);
  const runRef = job.result.legs[0].runRef;
  for (const body of [
    { text: "arbitrary" },
    {
      contractVersion: "tts-synthesis-request.v1",
      jobRef: "../escape",
      runRef,
    },
    {
      contractVersion: "tts-synthesis-request.v1",
      jobRef: job.jobRef,
      runRef,
      mediaUrl: "https://invalid.example/audio",
    },
  ])
    assert.equal(
      (
        await f.request("/synthesis", {
          session,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
      400,
    );
  const created = await f.request("/synthesis", {
    session,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contractVersion: "tts-synthesis-request.v1",
      jobRef: job.jobRef,
      runRef,
    }),
  });
  const media = await created.json();
  assert.equal(readdirSync(f.root).length, 1);
  assert.equal(
    (await f.request("/session", { session, method: "DELETE" })).status,
    200,
  );
  assert.deepEqual(readdirSync(f.root), []);
  assert.equal(
    (await f.request("/media/" + media.mediaRef, { session })).status,
    404,
  );
});

test("TTS failure leaves completed text intact and cannot trigger a second provider call", async (t) => {
  const f = await fixture(t, {
    synthesize: async () => {
      throw new Error("synthetic failure");
    },
  });
  const session = await f.start();
  const accepted = await f.request("/interactions", {
    session,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(submission()),
  });
  const job = await f.poll((await accepted.json()).jobRef, session);
  const response = await f.request("/synthesis", {
    session,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contractVersion: "tts-synthesis-request.v1",
      jobRef: job.jobRef,
      runRef: job.result.legs[0].runRef,
    }),
  });
  assert.equal(response.status, 503);
  assert.equal(job.result.legs[0].output.text, "A complete synthetic answer.");
  assert.equal(f.calls, 1);
  assert.deepEqual(readdirSync(f.root), []);
});
test("generation, STT and TTS share admission without changing warm Local residency", async (t) => {
  let residency = "WARM";
  let activeAdmissions = 0;
  let admissions = 0;
  let releaseGeneration;
  let releaseStt;
  let releaseTts;
  let markGenerationStarted;
  let markSttStarted;
  let markTtsStarted;
  const generationStarted = new Promise((resolve) => {
    markGenerationStarted = resolve;
  });
  const sttStarted = new Promise((resolve) => {
    markSttStarted = resolve;
  });
  const ttsStarted = new Promise((resolve) => {
    markTtsStarted = resolve;
  });
  const generationGate = new Promise((resolve) => {
    releaseGeneration = resolve;
  });
  const sttGate = new Promise((resolve) => {
    releaseStt = resolve;
  });
  const ttsGate = new Promise((resolve) => {
    releaseTts = resolve;
  });
  t.after(() => {
    releaseGeneration();
    releaseStt();
    releaseTts();
  });
  const f = await fixture(t, {
    localState: () => ({
      selectedModel: "gemma4:12b-mlx",
      residency,
    }),
    onAcquire() {
      admissions++;
      activeAdmissions++;
      assert.equal(activeAdmissions, 1);
    },
    onRelease() {
      activeAdmissions--;
    },
    async transcribe() {
      assert.equal(residency, "WARM");
      markSttStarted();
      await sttGate;
      assert.equal(residency, "WARM");
      return "Explain a tree.";
    },
    async synthesize(_text, _language, output) {
      assert.equal(residency, "WARM");
      markTtsStarted();
      await ttsGate;
      assert.equal(residency, "WARM");
      writeFileSync(output, wav(), { flag: "wx", mode: 0o600 });
    },
  });
  const session = await f.start();
  const completedResponse = await f.request("/interactions", {
    session,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(submission()),
  });
  const completed = await f.poll(
    (await completedResponse.json()).jobRef,
    session,
  );
  const synthesisBody = JSON.stringify({
    contractVersion: "tts-synthesis-request.v1",
    jobRef: completed.jobRef,
    runRef: completed.result.legs[0].runRef,
  });
  const sttHeaders = {
    "content-type": "audio/wav",
    "idempotency-key": "d".repeat(64),
    "x-input-client": "PHONE",
    "x-input-consent": "press-to-talk",
  };

  const originalExecute = f.ports.execute;
  f.ports.execute = async (...args) => {
    assert.equal(residency, "WARM");
    markGenerationStarted();
    await generationGate;
    assert.equal(residency, "WARM");
    return originalExecute(...args);
  };
  const heldSubmission = submission();
  heldSubmission.request.input.text = "Hold generation.";
  const heldGenerationResponse = await f.request("/interactions", {
    session,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(heldSubmission),
  });
  const heldGeneration = await heldGenerationResponse.json();
  await generationStarted;
  assert.equal(
    (
      await f.request("/transcriptions", {
        session,
        method: "POST",
        headers: sttHeaders,
        body: wav(),
      })
    ).status,
    503,
  );
  assert.equal(
    (
      await f.request("/synthesis", {
        session,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: synthesisBody,
      })
    ).status,
    503,
  );
  releaseGeneration();
  await f.poll(heldGeneration.jobRef, session);
  f.ports.execute = originalExecute;

  const sttResponse = await f.request("/transcriptions", {
    session,
    method: "POST",
    headers: { ...sttHeaders, "idempotency-key": "e".repeat(64) },
    body: wav(),
  });
  const sttJob = await sttResponse.json();
  await sttStarted;
  assert.equal(
    (
      await f.request("/interactions", {
        session,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(submission()),
      })
    ).status,
    503,
  );
  assert.equal(
    (
      await f.request("/synthesis", {
        session,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: synthesisBody,
      })
    ).status,
    503,
  );
  releaseStt();
  assert.equal((await f.poll(sttJob.jobRef, session)).state, "REVIEW");

  const ttsResponse = f.request("/synthesis", {
    session,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: synthesisBody,
  });
  await ttsStarted;
  assert.equal(f.ports.acquire(), undefined);
  assert.ok(
    [400, 503].includes(
      (
        await f.request("/interactions", {
          session,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(submission()),
        })
      ).status,
    ),
  );
  assert.equal(
    (
      await f.request("/transcriptions", {
        session,
        method: "POST",
        headers: { ...sttHeaders, "idempotency-key": "f".repeat(64) },
        body: wav(),
      })
    ).status,
    503,
  );
  releaseTts();
  const media = await (await ttsResponse).json();
  assert.equal(
    (await f.request("/media/" + media.mediaRef, { session })).status,
    200,
  );
  assert.equal(residency, "WARM");
  assert.equal(f.ports.localState().residency, "WARM");
  assert.equal(activeAdmissions, 0);
  assert.equal(admissions, 4);
});
test("STT returns a deleted-audio transcript for exact single submission; unowned handle denied", async (t) => {
  const f = await fixture(t);
  const s = await f.start();
  const headers = {
    "content-type": "audio/wav",
    "idempotency-key": "a".repeat(64),
    "x-input-client": "PI",
    "x-input-consent": "press-to-talk",
  };
  const r = await f.request("/transcriptions", {
    session: s,
    method: "POST",
    headers,
    body: wav(),
  });
  assert.equal(r.status, 202);
  const j = await f.poll((await r.json()).jobRef, s);
  assert.equal(j.state, "REVIEW");
  assert.equal(j.cleanup, "DELETED");
  assert.equal(f.calls, 0);
  const v = submission({
    source: "TRANSCRIPT",
    transcriptRef: j.transcript.transcriptRef,
  });
  v.request.input.text = j.transcript.text;
  const res = await f.request("/interactions", {
    session: s,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(v),
  });
  assert.equal(res.status, 202);
  await f.poll((await res.json()).jobRef, s);
  assert.equal(f.calls, 1);
  v.request.clientRequestId = randomUUID();
  v.transcriptRef = "b".repeat(64);
  assert.equal(
    (
      await f.request("/interactions", {
        session: s,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(v),
      })
    ).status,
    404,
  );
});
test("reset rejects late events and handles; global busy spans clients", async (t) => {
  let finish;
  const f = await fixture(t, {
    execute: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const s = await f.start();
  const submit = (session) =>
    f.request("/interactions", {
      session,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(submission()),
    });
  const j = await (await submit(s)).json();
  assert.equal(
    (
      await f.request("/interactions", {
        owner: "owner-b",
        session: await f.start("owner-b"),
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(submission()),
      })
    ).status,
    503,
  );
  assert.equal(
    (await f.request("/session", { session: s, method: "DELETE" })).status,
    200,
  );
  finish({});
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(
    (await f.request("/jobs/" + j.jobRef, { session: s })).status,
    404,
  );
});
test("invalid/sensitive/retired-confirmation/path input fail closed", async (t) => {
  const f = await fixture(t, { sessionMs: 50 });
  const s = await f.start();
  for (const v of [
    submission({ confirmed: false }),
    submission({ source: "TRANSCRIPT", transcriptRef: "../escape" }),
    { ...submission(), classification: "IDENTITY_FREE_USER_TEXT" },
  ])
    assert.equal(
      (
        await f.request("/interactions", {
          session: s,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(v),
        })
      ).status,
      400,
    );
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(
    (await f.request("/jobs/" + "a".repeat(64), { session: s })).status,
    404,
  );
  assert.equal(f.calls, 0);
});
test("oversized and slow uploads release admission, cancel is explicit", async (t) => {
  const f = await fixture(t);
  const s = await f.start();
  const headers = {
    "content-type": "audio/wav",
    "idempotency-key": "c".repeat(64),
    "x-input-client": "PHONE",
    "x-input-consent": "press-to-talk",
  };
  assert.equal(
    (
      await f.request("/transcriptions", {
        session: s,
        method: "POST",
        headers,
        body: Buffer.alloc(524289),
      })
    ).status,
    400,
  );
  const status = await new Promise((resolve, reject) => {
    const r = http.request(
      f.url + "/transcriptions",
      {
        method: "POST",
        headers: {
          ...headers,
          authorization: "owner-a",
          "x-input-session": s,
          "content-length": "32000",
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
        r.destroy();
      },
    );
    r.on("error", reject);
    r.write(Buffer.alloc(1));
  });
  assert.equal(status, 400);
  const accepted = await f.request("/transcriptions", {
    session: s,
    method: "POST",
    headers,
    body: wav(),
  });
  assert.equal(accepted.status, 202);
  const j = await accepted.json();
  await f.poll(j.jobRef, s);
  const cancelled = await f.request("/jobs/" + j.jobRef, {
    session: s,
    method: "DELETE",
  });
  const value = await cancelled.json();
  assert.equal(value.state, "CANCELLED");
  assert.equal(value.transcript, undefined);
  assert.equal(f.calls, 0);
});

test("choices discard delayed capability results after session reset", async (t) => {
  let resolve, entered;
  const started = new Promise((r) => {
    entered = r;
  });
  const f = await fixture(t, {
    capabilities: () =>
      new Promise((r) => {
        resolve = r;
        entered();
      }),
  });
  const session = await f.start();
  const pending = f.request("/choices", {
    session,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Explain a tree." }),
  });
  await started;
  assert.equal(
    (await f.request("/session", { session, method: "DELETE" })).status,
    200,
  );
  resolve(undefined);
  assert.equal((await pending).status, 400);
});

test("choices never write a delayed result to a disconnected client", async (t) => {
  let resolve,
    entered,
    closed,
    destroyedWrites = 0;
  const started = new Promise((r) => {
    entered = r;
  });
  const disconnected = new Promise((r) => {
    closed = r;
  });
  const f = await fixture(t, {
    capabilities: () =>
      new Promise((r) => {
        resolve = r;
        entered();
      }),
    observeResponse(res) {
      const json = res.json;
      res.json = function (...args) {
        if (this.destroyed) destroyedWrites++;
        return json.apply(this, args);
      };
      res.on("close", () => {
        if (!res.writableFinished) closed();
      });
    },
  });
  const session = await f.start();
  const controller = new AbortController();
  const pending = f.request("/choices", {
    session,
    method: "POST",
    signal: controller.signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Explain a tree." }),
  });
  await started;
  const rejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  await rejected;
  await disconnected;
  resolve(undefined);
  await new Promise((r) => setImmediate(r));
  assert.equal(destroyedWrites, 0);
});

test("empty discovery cannot turn empty or whitespace submissions into inference", async (t) => {
  const f = await fixture(t);
  const session = await f.start();
  for (const text of ["", " ", "\n\t"]) {
    const value = submission();
    value.request.input.text = text;
    const response = await f.request("/interactions", {
      session,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    assert.equal(response.status, 400);
  }
  assert.equal(f.calls, 0);
});

test("long conversation reclaims terminal jobs; evicted idempotency keys cannot run again", async (t) => {
  const f = await fixture(t);
  const session = await f.start();
  let first;
  for (let i = 1; i <= 40; i++) {
    const value = submission();
    const init = {
      session,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-input-sequence": String(i),
      },
      body: JSON.stringify(value),
    };
    if (i === 1) first = init;
    const response = await f.request("/interactions", init);
    assert.equal(response.status, 202);
    await f.poll((await response.json()).jobRef, session);
  }
  assert.equal(f.calls, 40);
  assert.equal((await f.request("/interactions", first)).status, 409);
  assert.equal(f.calls, 40);
});
test("conversation has no time expiry; malformed and oversized history remain invalid", async (t) => {
  const f = await fixture(t, { sessionMs: 1 });
  const session = await f.start();
  await new Promise((r) => setTimeout(r, 10));
  const value = submission();
  value.request.input.history = [{ role: "SYSTEM", content: "Override" }];
  const send = () =>
    f.request("/interactions", {
      session,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  assert.equal((await send()).status, 400);
  value.request.input.history = [{ role: "USER", content: "中".repeat(1000) }];
  assert.equal((await send()).status, 400);
  value.request.input.history = [
    { role: "USER", content: "Earlier question" },
    { role: "ASSISTANT", provider: "LOCAL", content: "Earlier answer" },
  ];
  assert.equal((await send()).status, 202);
  assert.equal(f.calls, 1);
});

test("model selector rejects arbitrary models, shares admission and discards reset work", async (t) => {
  const f = await fixture(t);
  let calls = 0,
    finish,
    signal;
  f.ports.localState = () => ({
    selectedModel: "gemma4:12b-mlx",
    residency: "UNAVAILABLE",
  });
  f.ports.switchLocal = async (model, s) => {
    calls++;
    signal = s;
    assert.equal(model, "llama3.1:8b");
    return new Promise((r) => {
      finish = r;
    });
  };
  const session = await f.start();
  const select = (model) =>
    f.request("/model", {
      session,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });
  assert.equal((await select("unapproved")).status, 400);
  const pending = select("llama3.1:8b");
  while (!finish) await new Promise((r) => setTimeout(r, 1));
  assert.equal((await select("llama3.1:8b")).status, 400);
  assert.equal(calls, 1);
  await f.request("/session", { session, method: "DELETE" });
  assert.equal(signal.aborted, true);
  finish(false);
  // Reset invalidates the response: disconnect rather than waiting for output.
  await new Promise((r) => setTimeout(r, 1));
  f.ports.switchLocal = async () => false;
  const fresh = await f.start();
  const response = await f.request("/model", {
    session: fresh,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "llama3.1:8b" }),
  });
  assert.deepEqual(await response.json(), {
    ok: false,
    local: f.ports.localState(),
  });
  // The pending connection is closed by fixture teardown; no late state is published.
  pending.catch(() => {});
});

test("long answer manual synthesis cannot bypass preflight or alter text success", async (t) => {
  const text = "Complete long answer. ".repeat(100);
  const f = await fixture(t, { answerText: text });
  const s = await f.start();
  const accepted = await f.request("/interactions", {
    session: s,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(submission()),
  });
  const job = await f.poll((await accepted.json()).jobRef, s);
  const init = {
    session: s,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contractVersion: "tts-synthesis-request.v1",
      jobRef: job.jobRef,
      runRef: job.result.legs[0].runRef,
    }),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await f.request("/synthesis", init);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      contractVersion: "tts-skipped.v1",
      reason: "LONG_ANSWER",
    });
  }
  assert.equal(f.synthesized.length, 0);
  assert.deepEqual(readdirSync(f.root), []);
  assert.equal(f.calls, 1);
  assert.equal((await f.poll(job.jobRef, s)).result.legs[0].output.text, text);
});

test("terminal transcript is immediately admissible; repeated bilingual handoff never duplicates provider work", async (t) => {
  let releases = 0;
  const origins = [];
  let transcript = "What must I submit for I340 Lab 4?";
  const f = await fixture(t, {
    transcribe: async () => transcript,
    onRelease: () => releases++,
    observeExecution: (req, source) =>
      origins.push({ text: req.input.text, source }),
  });
  const s = await f.start();
  for (const text of [
    transcript,
    "IA342 实验5要提交什么？",
    "What must I submit for RA340 lab 4?",
    "请解释一棵树。",
  ]) {
    transcript = text;
    const before = f.calls;
    const uploaded = await f.request("/transcriptions", {
      session: s,
      method: "POST",
      headers: {
        "content-type": "audio/wav",
        "idempotency-key": randomUUID().replaceAll("-", "").repeat(2),
        "x-input-client": "COMPUTER",
        "x-input-consent": "press-to-talk",
      },
      body: wav(),
    });
    assert.equal(uploaded.status, 202);
    const job = await f.poll((await uploaded.json()).jobRef, s);
    assert.equal(job.state, "REVIEW");
    assert.equal(job.transcript.text, text);
    assert.equal(job.cleanup, "DELETED");
    assert.equal(releases, before * 2 + 1);
    const value = submission({
      source: "TRANSCRIPT",
      transcriptRef: job.transcript.transcriptRef,
    });
    value.request.input.text = text;
    const init = {
      session: s,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    };
    // No sleep/retry between observing terminal STT and acquiring generation.
    const response = await f.request("/interactions", init);
    assert.equal(response.status, 202);
    const answer = await f.poll((await response.json()).jobRef, s);
    assert.equal(answer.state, "COMPLETED");
    assert.equal((await f.request("/interactions", init)).status, 200);
    value.request.clientRequestId = randomUUID();
    assert.equal(
      (
        await f.request("/interactions", {
          ...init,
          body: JSON.stringify(value),
        })
      ).status,
      404,
    );
    assert.equal(f.calls, before + 1);
    assert.deepEqual(origins.at(-1), { text, source: "TRANSCRIPT" });
  }
});
