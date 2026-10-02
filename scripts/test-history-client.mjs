import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import {
  createCourseGrounder,
  refreshCourseSources,
  courseGroundingInstruction,
  courseEvidencePrompt,
} from "@laita/course-grounding";
import { initializePersistence } from "@laita/persistence";
import { initializeRuntimePaths } from "@laita/runtime";
import { fixture } from "../apps/api/test/browser-fixture.mjs";
import { InputApi } from "../apps/web/src/client/api.ts";
import { LearningClient } from "../apps/web/src/client/controller.ts";
import { wav } from "../apps/web/src/client/microphone.ts";
import { createCourseAwareExecution } from "../apps/api/dist/course-execution.js";
import {
  createGoldenGrounder,
  publicCourses,
} from "../apps/api/test/course-golden-fixture.mjs";
function persistence(t) {
  const root = mkdtempSync(path.join(tmpdir(), "api-history-"));
  const paths = initializeRuntimePaths(root);
  assert.equal(paths.ok, true);
  const p = initializePersistence(paths.value);
  assert.equal(p.ok, true);
  t.after(() => {
    p.value.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, p: p.value, store: p.value.history(), paths: paths.value };
}
async function setup(t, options = {}) {
  const p = persistence(t);
  const f = await fixture({ history: options.history ?? p.store, ...options });
  const api = new InputApi((r, i) => f.request(r, i));
  const c = new LearningClient(() => {}, api, 2);
  await c.boot();
  t.after(() => {
    c.close();
    f.close();
  });
  return { ...p, f, api, c };
}
const complete = (request) => ({
  contractVersion: "provider-run-result.v1",
  interactionRef: `interaction-${randomUUID()}`,
  mode: request.mode,
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
      output: { text: "Complete synthetic reply" },
      metrics: { latencyMs: 1 },
    },
  ],
});
test("typed, voice, complete long answer, reset isolation and restart history through protected API", async (t) => {
  const text = "完整回答 ".repeat(600);
  const { c, api, store, p, paths, f } = await setup(t, { answerText: text });
  await c.send("Explain IA340 Lab 4.");
  assert.equal(c.phase, "success");
  const first = c.messages[1];
  assert.equal(first.text, text);
  assert.equal(first.audio.speechEligible, false);
  const skippedTurn = store.conversation(first.history.conversation).turns[0];
  assert.ok(
    skippedTurn.events.some(
      (e) => e.stage === "TTS" && e.outcome === "SKIPPED_LONG_ANSWER",
    ),
  );
  assert.equal(store.list({ problems: true }).items.length, 0);
  assert.deepEqual(
    await api.synthesize({
      contractVersion: "tts-synthesis-request.v1",
      jobRef: first.audio.jobRef,
      runRef: first.audio.runRef,
    }),
    { contractVersion: "tts-skipped.v1", reason: "LONG_ANSWER" },
  );
  assert.equal(f.calls(), 1);
  assert.equal(first.history.recording, "RECORDED");
  await api.historyRequest("feedback", {
    conversation: first.history.conversation,
    turn: first.history.turn,
    leg: first.leg,
    vote: "HELPFUL",
    report: false,
    reason: "Useful",
  });
  await c.send("Explain that further.");
  assert.equal(store.conversation(first.history.conversation).turns.length, 2);
  await c.reset();
  await c.send("New unrelated question.");
  assert.deepEqual(f.requests.at(-1).input.history, []);
  assert.equal(store.conversation(first.history.conversation).turns.length, 2);
  c.beginListening();
  await c.upload(wav(new Int16Array(32000).fill(600)));
  assert.equal(c.phase, "success");
  const voice = c.messages.at(-1);
  assert.equal(
    store.conversation(voice.history.conversation).turns.at(-1).inputType,
    "VOICE",
  );
  assert.match(
    store.conversation(voice.history.conversation).turns.at(-1).text,
    /research question/,
  );
  await c.reset();
  assert.equal(
    store.conversation(voice.history.conversation).turns.at(-1).outcome,
    "SUCCESS",
  );
  const calls = f.calls();
  const page = await api.historyRequest("query", { search: "Lab 4" });
  assert.equal(page.items.length, 1);
  assert.equal(f.calls(), calls);
  p.close();
  const restarted = initializePersistence(paths);
  assert.equal(restarted.ok, true);
  assert.equal(
    restarted.value.history().conversation(first.history.conversation).turns[0]
      .answers[0].text,
    text,
  );
  restarted.value.close();
});
test("pinned public overview keeps displayed sources exact across history and New conversation reset", async (t) => {
  const { grounder } = await createGoldenGrounder(t);
  const delivered = [];
  const produced = [];
  const executeCore = createCourseAwareExecution({
    grounder,
    async executeProvider(request, _signal, _session, evidence) {
      delivered.push({ request, evidence });
      return complete(request);
    },
  });
  const execute = async (...args) => {
    const result = await executeCore(...args);
    produced.push(result);
    return result;
  };
  const { c, f, store } = await setup(t, { execute });
  for (const question of ["IA340主要学什么？", "What is IA340 about?"]) {
    await c.send(question);
    assert.equal(c.phase, "success", question);
    const shown = c.messages.at(-1);
    assert.equal(shown.sources[0].path, "README.md", question);
    assert.equal(shown.sources[0].section, "Course Overview", question);
    assert.equal(shown.sources[0].commit, publicCourses.IA340.commit, question);
    assert.deepEqual(shown.sources, produced.at(-1).grounding.sources);
    assert.equal(
      delivered.at(-1).evidence.prompt,
      courseEvidencePrompt(shown.sources),
    );
    assert.deepEqual(
      delivered.at(-1).evidence.refs,
      shown.sources.map((_, index) => `course-source-${index + 1}`),
    );
  }
  assert.equal(delivered.length, 2);
  assert.deepEqual(delivered[0].request.input.history, []);
  assert.ok(delivered[1].request.input.history.length > 0);
  const previousConversation = c.messages.at(-1).history.conversation;
  assert.equal(store.conversation(previousConversation).turns.length, 2);
  await c.reset();
  await c.send("请介绍一下IA342这门课");
  assert.equal(c.phase, "success");
  const shown = c.messages.at(-1);
  assert.equal(shown.sources[0].path, "README.md");
  assert.equal(shown.sources[0].section, "Course Overview");
  assert.equal(shown.sources[0].commit, publicCourses.IA342.commit);
  assert.deepEqual(shown.sources, produced[2].grounding.sources);
  assert.deepEqual(delivered[2].request.input.history, []);
  assert.equal(
    delivered[2].evidence.prompt,
    courseEvidencePrompt(shown.sources),
  );
  assert.notEqual(shown.history.conversation, previousConversation);
  assert.equal(store.conversation(previousConversation).turns.length, 2);
  assert.equal(store.conversation(shown.history.conversation).turns.length, 1);
  assert.equal(f.calls(), 3);
});
test("Compare exact labelled feedback and answer-less reports, review persists, no provider reexecution", async (t) => {
  const { c, api, store, f } = await setup(t);
  c.select("COMPARE");
  await c.send("Compare two explanations.");
  const [local, cloud] = c.messages.slice(1);
  const feedback = {
    conversation: local.history.conversation,
    turn: local.history.turn,
    leg: local.leg,
    vote: "HELPFUL",
    report: false,
    reason: "",
  };
  for (let i = 0; i < 3; i++) await api.historyRequest("feedback", feedback);
  await api.historyRequest("feedback", {
    ...feedback,
    leg: cloud.leg,
    vote: "NOT_HELPFUL",
    report: true,
    reason: "Please review",
  });
  await assert.rejects(
    api.historyRequest("feedback", {
      ...feedback,
      conversation: "f".repeat(64),
    }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    api.historyRequest("feedback", { ...feedback, leg: "unknown" }),
    (error) => error.status === 400,
  );
  await api.historyRequest("review", {
    conversation: feedback.conversation,
    turn: feedback.turn,
    review: "NO_ISSUE",
    note: "Dislike alone does not establish an error",
    suspected: true,
    suspicionReason: "Manual flag for review",
  });
  const turn = store.conversation(feedback.conversation).turns[0];
  assert.equal(turn.feedback.length, 2);
  assert.equal(turn.review, "NO_ISSUE");
  assert.equal(turn.suspicionSource, "OWNER");
  assert.equal(f.calls(), 1);
});
test("course missing, provider exception, timeout and successful text with failed TTS stay distinct", async (t) => {
  for (const scenario of ["missing", "exception", "timeout", "tts"])
    await t.test(scenario, async (t) => {
      const options = {};
      if (scenario === "missing")
        options.execute = createCourseAwareExecution({
          grounder: {
            ground: async () => ({ status: "MISSING", course: "IA340" }),
          },
          executeProvider: async () => {
            throw new Error("must not run");
          },
        });
      if (scenario === "exception")
        options.execute = async () => {
          throw new Error("DO_NOT_STORE_RAW_PROVIDER_SECRET");
        };
      if (scenario === "timeout")
        options.execute = async (req) => ({
          ...complete(req),
          legs: [
            {
              runRef: `run-${randomUUID()}`,
              provider: "LOCAL",
              model: req.localModel,
              status: "FAILED",
              failure: { code: "TIMEOUT", retryable: true },
              metrics: { latencyMs: 10 },
            },
          ],
        });
      if (scenario === "tts")
        options.synthesize = async () => {
          throw new Error("DO_NOT_STORE_TTS_PATH");
        };
      const { c, api, store, root, f } = await setup(t, options);
      await c.send("Explain IA340 Lab 4.");
      const row = store.list({}).items[0];
      const turn = () => store.conversation(row.conversation).turns[0];
      if (scenario === "tts") {
        const m = c.messages.at(-1);
        await assert.rejects(
          api.synthesize({
            contractVersion: "tts-synthesis-request.v1",
            jobRef: m.audio.jobRef,
            runRef: m.audio.runRef,
          }),
        );
        assert.equal(turn().outcome, "SUCCESS");
        assert.ok(
          turn().events.some(
            (e) => e.stage === "TTS" && e.outcome === "FAILED",
          ),
        );
      } else
        assert.equal(
          turn().outcome,
          { missing: "NO_ANSWER", exception: "FAILED", timeout: "TIMEOUT" }[
            scenario
          ],
        );
      await api.historyRequest("feedback", {
        conversation: row.conversation,
        turn: row.id,
        leg: "",
        vote: null,
        report: true,
        reason: "Problem occurred",
      });
      assert.equal(store.list({ feedback: "REPORT" }).items.length, 1);
      const data = readFileSync(
        path.join(root, "data/foundation.sqlite"),
      ).toString("utf8");
      assert.doesNotMatch(data, /DO_NOT_STORE/);
      assert.doesNotMatch(
        JSON.stringify(f.logs),
        /IA340|DO_NOT_STORE|Complete synthetic/,
      );
    });
});
test("cancel and busy capture retain questions; incomplete disk capture still delivers one answer", async (t) => {
  const { c, api, store, f } = await setup(t);
  const pending = c.send("A slow synthetic question.");
  await new Promise((r) => setTimeout(r, 80));
  await c.cancel();
  await pending;
  assert.equal(store.list({ outcome: "CANCELLED" }).items.length, 1);
  await c.send("Another question while work drains.");
  assert.ok(store.list({ outcome: "NO_ANSWER" }).items.length);
  assert.ok(store.list({ search: "Another question" }).items.length);
  assert.equal(f.calls(), 1);
  const broken = await setup(t, {
    history: {
      begin() {
        throw new Error("DISK_SECRET");
      },
      incomplete() {
        throw new Error();
      },
      event() {
        throw new Error();
      },
      text() {
        throw new Error();
      },
      result() {
        throw new Error();
      },
      outcome() {
        throw new Error();
      },
    },
  });
  await broken.c.send("Retain a visible answer on disk failure.");
  assert.equal(broken.c.phase, "success");
  assert.equal(broken.c.messages.at(-1).history.recording, "INCOMPLETE");
  assert.equal(broken.f.calls(), 1);
  assert.equal(broken.c.recordingIncomplete, true);
});
test("history capture, generation and observation accept JSON charset and reject non-JSON", async (t) => {
  const { store } = persistence(t);
  const f = await fixture({ history: store });
  let contentType = "application/json; charset=utf-8";
  const api = new InputApi((url, init) => {
    if (/\/history\/|\/input\/(turns|interactions|observation)$/.test(url)) {
      const headers = new Headers(init.headers);
      headers.set("content-type", contentType);
      return f.request(url, { ...init, headers: Object.fromEntries(headers) });
    }
    return f.request(url, init);
  });
  const c = new LearningClient(() => {}, api, 2);
  t.after(() => {
    c.close();
    f.close();
  });
  await c.boot();
  await c.send("A permitted JSON charset question.");
  assert.equal(c.phase, "success");
  const m = c.messages.at(-1);
  await api.observation(m.audio.jobRef, m.audio.runRef, "DISPLAYED");
  const rows = await api.historyRequest("query", {});
  assert.equal(rows.items.length, 1);
  assert.ok(
    store
      .conversation(m.history.conversation)
      .turns[0].events.some((event) => event.outcome === "DISPLAYED"),
  );
  contentType = "text/plain";
  await assert.rejects(api.historyRequest("query", {}));
  await assert.rejects(api.beginTurn("Rejected media type", "TYPED"));
  assert.equal(f.calls(), 1);
});
test("history/review deny missing private boundary, foreign origin, mode/maintenance; safe query and excluded content", async (t) => {
  const { f, api, c, store } = await setup(t);
  await c.send("Safe synthetic question.");
  for (const headers of [
    {},
    { "x-owner-client": "a".repeat(64), "x-forwarded-host": "evil.invalid" },
    { "x-owner-client": "a".repeat(64), origin: "https://evil.invalid" },
    { "x-owner-client": "a".repeat(64), "x-forwarded-proto": "http" },
    { "x-owner-client": "a".repeat(64), authorization: "Bearer synthetic" },
    { "x-owner-client": "a".repeat(64), "sec-fetch-site": "cross-site" },
  ]) {
    const r = await f.request("/api/v1/history/query", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{}",
    });
    assert.equal(r.status, 403);
  }
  f.config.maintenanceMode = true;
  await assert.rejects(api.historyRequest("query", {}));
  f.config.maintenanceMode = false;
  f.config.mode = "operator";
  await assert.rejects(api.historyRequest("query", {}));
  f.config.mode = "single-operator";
  const before = f.calls();
  await assert.rejects(
    api.historyRequest("query", { sql: "DROP TABLE history_turns" }),
    (error) => error.status === 400,
  );
  assert.equal(
    (await api.historyRequest("query", { search: "' OR 1=1 --" })).items.length,
    0,
  );
  assert.equal(f.calls(), before);
  const ref = await api.beginTurn("password sk-synthetic-sensitive", "TYPED");
  assert.equal(store.conversation(ref.conversation).turns.at(-1).text, null);
  assert.equal(
    store.conversation(ref.conversation).turns.at(-1).suspicionSource,
    "SAFETY",
  );
});

test("history validation is 400 while unavailable storage remains 503 without raw errors", async (t) => {
  const { store } = persistence(t);
  let failStorage = false;
  const { c, api, f } = await setup(t, {
    history: {
      ...store,
      list(...args) {
        if (failStorage) throw new Error("PRIVATE_SYNTHETIC_STORAGE_ERROR");
        return store.list(...args);
      },
      review(...args) {
        if (failStorage) throw new Error("PRIVATE_SYNTHETIC_STORAGE_ERROR");
        return store.review(...args);
      },
    },
  });
  await c.send("Review validation example.");
  const m = c.messages.at(-1);
  const review = {
    conversation: m.history.conversation,
    turn: m.history.turn,
    review: "REVIEWED",
    note: "password sk-synthetic-sensitive",
    suspected: false,
    suspicionReason: "",
  };
  await assert.rejects(
    api.historyRequest("review", review),
    (e) => e.status === 400,
  );
  await assert.rejects(
    api.historyRequest("query", { since: "not-a-date" }),
    (e) => e.status === 400,
  );
  failStorage = true;
  await assert.rejects(
    api.historyRequest("query", {}),
    (e) => e.status === 503,
  );
  await assert.rejects(
    api.historyRequest("review", { ...review, note: "Safe review" }),
    (e) => e.status === 503,
  );
  assert.equal(f.calls(), 1);
  assert.doesNotMatch(
    JSON.stringify(f.logs),
    /PRIVATE_SYNTHETIC_STORAGE_ERROR|sk-synthetic/,
  );
});

test("history parser rejects malformed, oversized and unsupported JSON before storage without leaking details", async (t) => {
  const { store } = persistence(t);
  let reads = 0,
    failStorage = false;
  const { f } = await setup(t, {
    history: {
      ...store,
      list(...args) {
        reads++;
        if (failStorage) throw new Error("RAW_STORAGE_DETAIL");
        return store.list(...args);
      },
    },
  });
  const device = await f.device();
  for (const [body, extra] of [
    ['{"search":"MALFORMED_PRIVATE_BODY",', {}],
    [JSON.stringify({ search: "OVERSIZED_PRIVATE_BODY".repeat(1000) }), {}],
    ["{}", { "content-type": "application/json; charset=unsupported" }],
  ]) {
    const response = await device.send("/api/v1/history/query", {
      method: "POST",
      headers: { "content-type": "application/json", ...extra },
      body,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { code: "INVALID_REQUEST" });
  }
  assert.equal(reads, 0);
  const encoded = await device.send("/api/v1/history/query", {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
    body: "{}",
  });
  assert.equal(encoded.status, 403);
  assert.equal(reads, 0);
  const query = () =>
    device.send("/api/v1/history/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  const valid = await query();
  assert.equal(valid.status, 200);
  assert.deepEqual((await valid.json()).items, []);
  failStorage = true;
  const unavailable = await query();
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    code: "HISTORY_UNAVAILABLE",
    recording: "INCOMPLETE",
  });
  const unauthorized = await f.request("/api/v1/history/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"invalid":',
  });
  assert.equal(unauthorized.status, 403);
  assert.equal(f.calls(), 0);
  assert.doesNotMatch(
    JSON.stringify(f.logs),
    /PRIVATE_BODY|RAW_STORAGE_DETAIL|SyntaxError|entity.too.large|Unexpected|stack|charset/,
  );
  assert.ok(f.logs.every((entry) => entry.code !== "INTERNAL_FAILURE"));
});

test("real negative course retrieval retains the searched snapshot through restart without citations or private evidence", async (t) => {
  const { root, p, paths, store } = persistence(t);
  const sourceRoot = path.join(realpathSync(root), "synthetic-course-sources");
  const commit = "c".repeat(40);
  const files = {
    "README.md": "# Course\nEXCERPT_NOT_ARCHIVED_189 public overview.",
    "docs/index.md": "# Overview\nGeneral course overview.",
    "docs/syllabus/index.md": "# Syllabus\nGeneral course policies.",
    "docs/assignments/lab-5/index.md": "# Lab 5\nSubmit a synthetic example.",
  };
  const blobs = new Map(
    Object.values(files).map((text) => [
      createHash("sha1").update(text).digest("hex"),
      Buffer.from(text),
    ]),
  );
  const fetcher = async (input) => {
    const match = /^\/repos\/JMU-Data\/(IA340|IA342)(.*)$/.exec(
      new URL(String(input)).pathname,
    );
    assert.ok(match);
    const [, course, suffix] = match;
    let value;
    if (!suffix)
      value = {
        full_name: `JMU-Data/${course}`,
        private: false,
        visibility: "public",
        default_branch: "main",
      };
    else if (suffix === "/commits/main") value = { sha: commit };
    else if (suffix.startsWith("/git/trees/"))
      value = {
        truncated: false,
        tree: Object.entries(files).map(([file, text]) => ({
          path: file,
          mode: "100644",
          type: "blob",
          sha: createHash("sha1").update(text).digest("hex"),
          size: Buffer.byteLength(text),
        })),
      };
    else if (suffix.startsWith("/git/blobs/")) {
      const sha = suffix.slice("/git/blobs/".length),
        bytes = blobs.get(sha);
      assert.ok(bytes);
      value = {
        sha,
        size: bytes.length,
        encoding: "base64",
        content: bytes.toString("base64"),
      };
    } else assert.fail("Unexpected synthetic source endpoint");
    return new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
    });
  };
  const now = () => new Date("2026-09-26T12:00:00.000Z");
  assert.equal(
    (await refreshCourseSources(sourceRoot, { fetcher, now })).ok,
    true,
  );
  let providerCalls = 0;
  const execute = createCourseAwareExecution({
    grounder: createCourseGrounder(sourceRoot, { fetcher, now }),
    executeProvider: async () => {
      providerCalls++;
      throw new Error("RAW_EXCEPTION_NOT_ARCHIVED_189");
    },
  });
  const f = await fixture({ history: store, execute });
  const api = new InputApi((r, i) => f.request(r, i));
  const c = new LearningClient(() => {}, api, 2);
  t.after(() => {
    c.close();
    f.close();
  });
  await c.boot();
  await c.send("What must I submit for IA340 Lab 4?");
  const ref = c.messages.at(-1).history;
  assert.equal(providerCalls, 0);
  assert.equal(p.close().ok, true);
  const reopened = initializePersistence(paths);
  assert.equal(reopened.ok, true);
  const f2 = await fixture({ history: reopened.value.history() });
  t.after(() => {
    f2.close();
    reopened.value.close();
  });
  const page = await new InputApi((r, i) => f2.request(r, i)).historyRequest(
    "conversation",
    { conversation: ref.conversation },
  );
  const turn = page.turns[0];
  assert.equal(turn.course, "IA340");
  assert.equal(turn.lab, "4");
  assert.deepEqual(turn.sources, []);
  assert.deepEqual(turn.answers, []);
  assert.equal(turn.outcome, "NO_ANSWER");
  for (const [stage, outcome] of [
    ["FRESHNESS", "AVAILABLE"],
    ["SNAPSHOT", "LOADED"],
    ["RETRIEVAL", "MISSING"],
    ["PROVIDER", "NOT_EXECUTED"],
  ])
    assert.ok(
      turn.events.some((e) => e.stage === stage && e.outcome === outcome),
    );
  assert.deepEqual(turn.events.find((e) => e.stage === "SNAPSHOT").snapshot, {
    course: "IA340",
    commit,
  });
  const bytes = readFileSync(
    path.join(root, "data/foundation.sqlite"),
  ).toString("utf8");
  assert.doesNotMatch(
    bytes,
    /EXCERPT_NOT_ARCHIVED_189|RAW_EXCEPTION_NOT_ARCHIVED_189|COURSE EVIDENCE \(untrusted/,
  );
  assert.equal(bytes.includes(courseGroundingInstruction), false);
  assert.equal(f2.calls(), 0);
});

test("sources are recorded before provider failure, playback reports stay browser facts, transient write failure remains incomplete", async (t) => {
  const source = {
    course: "IA340",
    repository: "JMU-Data/IA340",
    commit: "b".repeat(40),
    path: "lab4.md",
    section: "Instructions",
    url: `https://github.com/JMU-Data/IA340/blob/${"b".repeat(40)}/lab4.md#instructions`,
    excerpt: "DO_NOT_COPY_GROUNDING_EXCERPT",
  };
  const execute = createCourseAwareExecution({
    grounder: {
      async ground(_q, _s, trace) {
        trace?.("FRESHNESS", "AVAILABLE", 2);
        trace?.("SNAPSHOT", "LOADED");
        trace?.("COURSE", "LOCATOR_CHECKED", undefined, {
          course: "IA340",
          lab: "4",
          sources: [],
        });
        return {
          status: "FOUND",
          course: "IA340",
          snapshot: source.commit,
          sources: [source],
          prompt: "DO_NOT_COPY_HIDDEN_PROMPT",
          evidenceRefs: ["course-source-1"],
        };
      },
    },
    executeProvider: async () => {
      throw new Error("DO_NOT_COPY_RAW_EXCEPTION");
    },
  });
  const a = await setup(t, { execute });
  await a.c.send("IA340 Lab 4 requirements");
  const row = a.store.list({ course: "IA340", lab: "4" }).items[0];
  const turn = a.store.conversation(row.conversation).turns[0];
  assert.equal(turn.sources[0].commit, source.commit);
  assert.equal(turn.sources[0].excerpt, undefined);
  assert.equal(turn.outcome, "FAILED");
  assert.ok(
    turn.events.some((e) => e.stage === "PROVIDER" && e.outcome === "FAILED"),
  );
  assert.doesNotMatch(
    readFileSync(path.join(a.root, "data/foundation.sqlite")).toString("utf8"),
    /DO_NOT_COPY/,
  );
  const b = await setup(t);
  await b.c.send("Playback observation example");
  const m = b.c.messages.at(-1);
  await b.api.observation(m.audio.jobRef, m.audio.runRef, "PLAY_STARTED");
  await b.api.observation(m.audio.jobRef, m.audio.runRef, "PLAY_ENDED");
  await assert.rejects(
    b.api.observation(m.audio.jobRef, "run-unknown", "PLAY_STARTED"),
  );
  await assert.rejects(
    b.api.observation(m.audio.jobRef, m.audio.runRef, "OWNER_HEARD_AUDIO"),
  );
  const events = b.store.conversation(m.history.conversation).turns[0].events;
  assert.ok(
    events.some((e) => e.origin === "BROWSER" && e.outcome === "PLAY_ENDED"),
  );
  await b.api.cancel(m.audio.jobRef);
  assert.equal(
    b.store.conversation(m.history.conversation).turns[0].outcome,
    "SUCCESS",
  );
  assert.equal(b.f.calls(), 1);
  const original = b.store;
  const broken = {
    ...original,
    result() {
      throw new Error("Synthetic disk full");
    },
  };
  const c = await setup(t, { history: broken });
  await c.c.send("One generated answer despite a failed save");
  assert.equal(c.c.messages.at(-1).history.recording, "INCOMPLETE");
  assert.equal(c.c.phase, "success");
  assert.equal(c.f.calls(), 1);
  assert.equal(
    original.list({ search: "failed save" }).items[0].recording,
    "INCOMPLETE",
  );
});

test("safe no-provider course notices survive wire validation and reach the browser/history", async (t) => {
  for (const [status, expected] of [
    ["EVIDENCE_NOT_FOUND", /did not find reliable support/],
    ["EVIDENCE_AMBIGUOUS", /ambiguous/],
    ["SOURCES_UNAVAILABLE", /snapshot is unavailable/],
    ["EVIDENCE_INPUT_LIMIT", /cannot fit together/],
  ]) {
    await t.test(status, async (t) => {
      const { c, store } = await setup(t, {
        execute: async (req) => ({
          contractVersion: "provider-run-result.v1",
          interactionRef: `interaction-${randomUUID()}`,
          mode: req.mode,
          legs: [],
          grounding: { status, course: "IA340" },
        }),
      });
      await c.send("Explain IA340 Lab 4.");
      assert.equal(c.phase, "success");
      assert.match(c.messages.at(-1).text, expected);
      assert.equal(c.messages.at(-1).provider, "Course sources");
      const row = store.list({}).items[0];
      const turn = store.conversation(row.conversation).turns[0];
      assert.equal(turn.outcome, "NO_ANSWER");
      assert.equal(turn.answers.length, 0);
      assert.ok(
        turn.events.some((e) => e.stage === "ANSWER" && e.outcome === status),
      );
    });
  }
});

test("Chinese course rejection keeps the machine outcome and displays Chinese recovery text", async (t) => {
  const { c, store, f } = await setup(t, {
    execute: async (req) => ({
      contractVersion: "provider-run-result.v1",
      interactionRef: `interaction-${randomUUID()}`,
      mode: req.mode,
      legs: [],
      grounding: { status: "EVIDENCE_NOT_FOUND", course: "IA340" },
    }),
  });
  await c.send("IA340主要学什么？");
  assert.equal(c.phase, "success");
  assert.match(c.messages.at(-1).text, /没有找到足够可靠的依据/u);
  assert.equal(c.messages.at(-1).provider, "Course sources");
  assert.equal(f.calls(), 1);
  const row = store.list({}).items[0];
  const turn = store.conversation(row.conversation).turns[0];
  assert.equal(turn.outcome, "NO_ANSWER");
  assert.equal(turn.answers.length, 0);
  assert.ok(
    turn.events.some(
      (event) =>
        event.stage === "ANSWER" && event.outcome === "EVIDENCE_NOT_FOUND",
    ),
  );
});

test("follow-up verified transcript source and context reduction reach retained history without rewriting text", async (t) => {
  const { providerMessages, reservedProviderInput, validConversation } =
    await import("@laita/contracts");
  const { identifyCourseQuestion, courseEvidencePrompt } =
    await import("@laita/course-grounding");
  const transcript = "What must I submit for RA340 lab 4?";
  const source = {
    course: "IA340",
    repository: "JMU-Data/IA340",
    commit: "a".repeat(40),
    path: "docs/assignments/lab-4/index.md",
    section: "Submit",
    url: `https://github.com/JMU-Data/IA340/blob/${"a".repeat(40)}/docs/assignments/lab-4/index.md#submit`,
    excerpt: "EXCERPT_NOT_ARCHIVED_184 " + "x".repeat(850),
  };
  const seen = [];
  let calls = 0;
  const execute = createCourseAwareExecution({
    grounder: {
      async ground(text, signal, trace, origin) {
        assert.equal(identifyCourseQuestion(text, origin), "IA340");
        trace?.("COURSE", "LOCATOR_CHECKED", undefined, {
          course: "IA340",
          lab: "4",
          sources: [],
        });
        return {
          status: "FOUND",
          course: "IA340",
          snapshot: source.commit,
          sources: [source],
        };
      },
    },
    async executeProvider(req, signal, session, evidence, trace) {
      calls++;
      seen.push({ req, evidence });
      if (evidence) {
        assert.equal(evidence.prompt, courseEvidencePrompt([source]));
        assert.ok(
          reservedProviderInput(
            providerMessages(req.input, "LOCAL", evidence),
          ) <= 3584,
        );
      }
      trace?.("ADMISSION", "PROVIDER_RESERVED");
      trace?.("PROVIDER", "STARTED");
      const result = complete(req);
      if (!evidence)
        result.legs[0].output.text =
          "Earlier generic answer. " + "a".repeat(2050);
      return result;
    },
  });
  const { c, store, api } = await setup(t, {
    execute,
    transcribe: async () => transcript,
  });
  await c.send("Earlier ordinary question.");
  const first = c.messages.at(-1).history;
  assert.ok(c.beginListening());
  await c.upload(wav(new Int16Array(32000).fill(600)));
  assert.equal(c.phase, "success");
  assert.equal(c.messages.at(-2).text, transcript);
  assert.equal(calls, 2);
  assert.equal(seen[1].req.input.text, transcript);
  assert.deepEqual(seen[1].req.input.history, []);
  assert.ok(
    validConversation(transcript, [
      { role: "USER", content: "Earlier ordinary question." },
      {
        role: "ASSISTANT",
        provider: "LOCAL",
        content: "Earlier generic answer. " + "a".repeat(2050),
      },
    ]),
  );
  assert.deepEqual(c.messages.at(-1).sources, [source]);
  const page = await api.historyRequest("conversation", {
    conversation: first.conversation,
  });
  assert.equal(page.turns.length, 2);
  const voice = page.turns[1];
  assert.equal(voice.text, transcript);
  assert.equal(voice.inputType, "VOICE");
  assert.equal(voice.course, "IA340");
  assert.equal(voice.lab, "4");
  assert.equal(voice.outcome, "SUCCESS");
  for (const outcome of [
    "TRANSCRIPT_ALIAS_RECOVERED",
    "CONTEXT_REDUCED",
    "SOURCES_SELECTED",
    "PROVIDER_RESERVED",
    "STARTED",
    "RETURNED",
  ])
    assert.ok(
      voice.events.some((e) => e.outcome === outcome),
      outcome,
    );
  assert.equal(voice.sources.length, 1);
  assert.equal(voice.sources[0].commit, source.commit);
  assert.equal(store.list({ problems: true }).items.length, 0);
  assert.equal(calls, 2);
  assert.doesNotMatch(
    JSON.stringify(page),
    /EXCERPT_NOT_ARCHIVED_184|COURSE EVIDENCE/,
  );
});
