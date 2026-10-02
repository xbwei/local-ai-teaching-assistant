import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { isProviderRunResult } from "@laita/contracts";
import {
  courseEvidencePrompt,
  createCourseGrounder,
  refreshCourseSources,
} from "@laita/course-grounding";
import {
  createCourseAwareExecution,
  CoursePreparationError,
  coursePreparationDeadlineMs,
} from "../dist/course-execution.js";

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
function request(text, mode = "LOCAL") {
  return {
    contractVersion: "provider-run-request.v1",
    clientRequestId: "123e4567-e89b-42d3-a456-426614174000",
    mode,
    input: { text },
    capabilityIdentity: identity,
    ...(mode !== "OPENAI" ? { localModel: "gemma4:12b-mlx" } : {}),
    ...(mode !== "LOCAL" ? { openaiModel: "gpt-5.6-luna" } : {}),
  };
}
function providerResult(mode = "LOCAL") {
  return {
    contractVersion: "provider-run-result.v1",
    interactionRef: "interaction-123e4567-e89b-42d3-a456-426614174001",
    mode,
    ...(mode === "COMPARE"
      ? { comparisonRef: "comparison-123e4567-e89b-42d3-a456-426614174002" }
      : {}),
    legs: [
      {
        runRef: "run-123e4567-e89b-42d3-a456-426614174003",
        provider: mode === "OPENAI" ? "OPENAI" : "LOCAL",
        model: mode === "OPENAI" ? "gpt-5.6-luna" : "gemma4:12b-mlx",
        status: "COMPLETED",
        output: { text: "synthetic answer" },
        provenance: {
          actualProvider: mode === "OPENAI" ? "OPENAI" : "LOCAL",
          actualModel: mode === "OPENAI" ? "gpt-5.6-luna" : "gemma4:12b-mlx",
          adapter: "synthetic.v1",
        },
        metrics: { latencyMs: 1 },
      },
      ...(mode === "COMPARE"
        ? [
            {
              runRef: "run-123e4567-e89b-42d3-a456-426614174004",
              provider: "OPENAI",
              model: "gpt-5.6-luna",
              status: "COMPLETED",
              output: { text: "cloud answer" },
              provenance: {
                actualProvider: "OPENAI",
                actualModel: "gpt-5.6-luna",
                adapter: "synthetic.v1",
              },
              metrics: { latencyMs: 1 },
            },
          ]
        : []),
    ],
  };
}
const session = "session-123e4567-e89b-42d3-a456-426614174005";

test("real bilingual overview retrieval delivers the displayed bounded sources to one fake Local call", async (t) => {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "overview-execution-")),
  );
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const documents = {
    IA340:
      "# IA340\n## Course Overview\nIA340 teaches students to organize, analyze, and explain public data using several analytical methods. Students learn to connect data with evidence-based decisions.",
    IA342:
      "# IA342\n## Course Overview\nIA342 teaches students to explore public data through visual analysis and clear communication. Students learn to build useful visual explanations for decisions.",
  };
  const commits = { IA340: "a".repeat(40), IA342: "b".repeat(40) };
  const blobs = Object.fromEntries(
    Object.entries(documents).map(([course, content]) => [
      course,
      Object.entries({
        "README.md": content,
        "docs/index.md": `# ${course} Home\nPublic course navigation.`,
        "docs/syllabus/index.md": `# ${course} Syllabus\nPublic course schedule.`,
        "docs/modules/module-1/index.md": `# Module 1\nPublic module material.`,
      }).map(([file, body]) => ({
        file,
        content: body,
        sha: createHash("sha1")
          .update(`${course}:${file}:${body}`)
          .digest("hex"),
      })),
    ]),
  );
  const fetcher = async (input) => {
    const match = /^\/repos\/JMU-Data\/(IA340|IA342)(.*)$/u.exec(
      new URL(String(input)).pathname,
    );
    assert.ok(match);
    const [, course, suffix] = match;
    const courseBlobs = blobs[course];
    let value;
    if (suffix === "")
      value = {
        full_name: `JMU-Data/${course}`,
        private: false,
        visibility: "public",
        default_branch: "main",
      };
    else if (suffix === "/commits/main") value = { sha: commits[course] };
    else if (suffix.startsWith("/git/trees/"))
      value = {
        sha: commits[course],
        url: "https://api.github.test/tree",
        tree: courseBlobs.map((blob) => ({
          path: blob.file,
          mode: "100644",
          type: "blob",
          sha: blob.sha,
          size: Buffer.byteLength(blob.content),
          url: "https://api.github.test/blob",
        })),
        truncated: false,
      };
    else if (suffix.startsWith("/git/blobs/")) {
      const blob = courseBlobs.find(
        (candidate) => suffix === `/git/blobs/${candidate.sha}`,
      );
      assert.ok(blob);
      value = {
        sha: blob.sha,
        node_id: "synthetic",
        size: Buffer.byteLength(blob.content),
        url: "https://api.github.test/blob",
        content: Buffer.from(blob.content).toString("base64"),
        encoding: "base64",
      };
    } else assert.fail(`Unexpected public fixture route: ${suffix}`);
    return Response.json(value);
  };
  const now = () => new Date("2026-09-27T12:00:00.000Z");
  assert.equal((await refreshCourseSources(root, { fetcher, now })).ok, true);
  const grounder = createCourseGrounder(root, { fetcher, now });
  for (const [course, question] of [
    ["IA340", "What do students learn in IA340?"],
    ["IA340", "IA340这门课学什么？"],
    ["IA342", "What is IA342 about?"],
    ["IA342", "请介绍一下IA342这门课"],
  ])
    for (const history of [
      [],
      [
        { role: "USER", content: "Earlier synthetic question." },
        {
          role: "ASSISTANT",
          provider: "LOCAL",
          content: "Earlier synthetic answer.",
        },
      ],
    ]) {
      let calls = 0;
      let used;
      const execute = createCourseAwareExecution({
        grounder,
        async executeProvider(value, _signal, _session, evidence) {
          calls++;
          used = { value, evidence };
          return providerResult();
        },
      });
      const req = request(question);
      req.input.history = history;
      const result = await execute(req, new AbortController().signal, session);
      assert.equal(result.grounding.status, "GROUNDED", question);
      assert.equal(result.grounding.course, course);
      assert.equal(result.grounding.sources[0].path, "README.md");
      assert.equal(result.grounding.sources[0].section, "Course Overview");
      assert.equal(result.grounding.sources[0].commit, commits[course]);
      assert.equal(calls, 1);
      assert.equal(used.value.input.text, question);
      assert.deepEqual(used.value.input.history, history);
      assert.equal(
        used.evidence.prompt,
        courseEvidencePrompt(result.grounding.sources),
      );
      assert.deepEqual(used.evidence.refs, ["course-source-1"]);
    }
});

test("ordinary chat remains unchanged and course evidence is isolated to one Local call", async () => {
  const calls = [];
  let grounded = true;
  const execute = createCourseAwareExecution({
    grounder: {
      async ground(_question, signal) {
        assert.equal(signal.aborted, false);
        if (!grounded) return { status: "ORDINARY" };
        return {
          status: "FOUND",
          course: "IA342",
          snapshot: "b".repeat(40),
          sources: [
            {
              course: "IA342",
              repository: "JMU-Data/IA342",
              commit: "b".repeat(40),
              path: "docs/assignments/lab-5/index.md",
              section: "Submission",
              url: `https://github.com/JMU-Data/IA342/blob/${"b".repeat(40)}/docs/assignments/lab-5/index.md#submission`,
              excerpt: "There is no Canvas submission.",
            },
          ],
        };
      },
    },
    async executeProvider(value, signal, sessionRef, evidence) {
      calls.push({ value, signal, sessionRef, evidence });
      return providerResult(value.mode);
    },
  });
  const first = await execute(
    request("What must I submit for IA342 Lab 5?"),
    new AbortController().signal,
    session,
  );
  assert.equal(first.grounding.status, "GROUNDED");
  assert.equal(first.grounding.sources.length, 1);
  assert.match(calls[0].evidence.systemInstruction, /only from the supplied/);
  assert.match(calls[0].evidence.prompt, /There is no Canvas submission/);

  grounded = false;
  const second = await execute(
    request("Explain database normalization"),
    new AbortController().signal,
    session,
  );
  assert.equal(second.grounding, undefined);
  assert.equal(calls[1].evidence, undefined);

  for (const mode of ["OPENAI", "COMPARE"]) {
    const ordinary = await execute(
      request("Explain database normalization", mode),
      new AbortController().signal,
      session,
    );
    assert.equal(ordinary.mode, mode);
    assert.equal(ordinary.grounding, undefined);
    assert.equal(calls.at(-1).evidence, undefined);
  }
});

test("OpenAI and Compare course requests stop before retrieval or provider contact", async () => {
  let retrievals = 0;
  let providerCalls = 0;
  const execute = createCourseAwareExecution({
    grounder: {
      async ground() {
        retrievals++;
        throw new Error("must not retrieve");
      },
    },
    async executeProvider() {
      providerCalls++;
      return providerResult();
    },
  });
  for (const mode of ["OPENAI", "COMPARE"]) {
    const result = await execute(
      request("What is due for IA340 Lab 5?", mode),
      new AbortController().signal,
      session,
    );
    assert.equal(result.grounding.status, "LOCAL_ONLY");
    assert.equal(result.legs.length, 0);
    assert.equal(isProviderRunResult(result), true);
  }
  assert.equal(retrievals, 0);
  assert.equal(providerCalls, 0);
});

test("missing, ambiguous, conflicting and unavailable evidence do not call a model", async () => {
  for (const status of ["MISSING", "AMBIGUOUS", "CONFLICTING", "UNAVAILABLE"]) {
    let providerCalls = 0;
    const execute = createCourseAwareExecution({
      grounder: {
        async ground(_question, signal) {
          assert.equal(signal.aborted, false);
          return { status, course: "IA340" };
        },
      },
      async executeProvider() {
        providerCalls++;
        return providerResult();
      },
    });
    const result = await execute(
      request("What is required for IA340 Lab 5?"),
      new AbortController().signal,
      session,
    );
    assert.equal(result.legs.length, 0);
    assert.equal(isProviderRunResult(result), true);
    assert.equal(providerCalls, 0);
  }
});

test("cancellation signal is passed into retrieval without cross-request state", async () => {
  const signals = [];
  let providerCalls = 0;
  const entered = Promise.withResolvers();
  const execute = createCourseAwareExecution({
    grounder: {
      async ground(_question, signal) {
        signals.push(signal);
        if (signals.length === 1) {
          entered.resolve();
          await new Promise((resolve) =>
            signal.addEventListener("abort", resolve, { once: true }),
          );
        }
        return signal.aborted
          ? { status: "UNAVAILABLE" }
          : { status: "UNAVAILABLE", course: "IA340" };
      },
    },
    async executeProvider() {
      providerCalls++;
      return providerResult();
    },
  });
  const first = new AbortController();
  const cancelled = execute(request("IA340 Lab 5"), first.signal, session);
  await entered.promise;
  first.abort();
  await assert.rejects(
    cancelled,
    (error) =>
      error instanceof CoursePreparationError && error.outcome === "CANCELLED",
  );
  await assert.rejects(execute(request("IA340 Lab 5"), first.signal, session), {
    outcome: "CANCELLED",
  });
  const second = new AbortController();
  await execute(request("IA340 Lab 5"), second.signal, session);
  assert.equal(signals.length, 2, "pre-aborted input skips grounding");
  assert.equal(providerCalls, 0);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  assert.notEqual(signals[0], signals[1]);
  // The successful preparation removed its parent abort listener.
  second.abort();
  assert.equal(signals[1].aborted, false);
});

test("preparation deadline is bounded and cannot leak into ordinary/provider work", async () => {
  assert.equal(coursePreparationDeadlineMs, 30000);
  const options = {
    grounder: {
      async ground() {
        assert.fail("ordinary chat cannot prepare courses");
      },
    },
    async executeProvider(_request, signal) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(signal.aborted, false);
      return providerResult();
    },
  };
  for (const preparationMs of [0, -1, 1.5, NaN, Infinity, 30001])
    assert.throws(() =>
      createCourseAwareExecution({ ...options, preparationMs }),
    );
  const execute = createCourseAwareExecution({ ...options, preparationMs: 1 });
  const result = await execute(
    request("Explain a tree."),
    new AbortController().signal,
    session,
  );
  assert.equal(result.legs[0].status, "COMPLETED");
});

test(
  "native fetch abort settles stalled headers and body reads",
  { timeout: 5000 },
  async (t) => {
    for (const stalled of ["headers", "body"])
      await t.test(stalled, async (t) => {
        const root = realpathSync(
          mkdtempSync(path.join(tmpdir(), "course-deadline-native-")),
        );
        chmodSync(root, 0o700);
        const closed = Promise.withResolvers();
        const server = http.createServer((_req, res) => {
          res.once("close", () => closed.resolve());
          if (stalled === "body") {
            res.writeHead(200, { "content-type": "application/json" });
            res.write('{"partial":');
          }
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        t.after(() => {
          server.closeAllConnections();
          server.close();
          rmSync(root, { recursive: true, force: true });
        });
        let calls = 0,
          providerCalls = 0;
        const execute = createCourseAwareExecution({
          preparationMs: 100,
          grounder: createCourseGrounder(root, {
            fetcher(_url, init) {
              calls++;
              return fetch(`http://127.0.0.1:${server.address().port}`, init);
            },
          }),
          async executeProvider() {
            providerCalls++;
            return providerResult();
          },
        });
        const events = [];
        await assert.rejects(
          execute(
            request("IA340 Lab 5"),
            new AbortController().signal,
            session,
            (...event) => events.push(event),
          ),
          { outcome: "TIMEOUT" },
        );
        await closed.promise;
        assert.equal(calls, 1);
        assert.equal(providerCalls, 0);
        assert.ok(
          events.some((e) => e[0] === "RETRIEVAL" && e[1] === "TIMEOUT"),
        );
        assert.ok(
          events.some((e) => e[0] === "PROVIDER" && e[1] === "NOT_EXECUTED"),
        );
      });
  },
);

test("evidence fits the complete request, preserves multi-turn context and exact displayed sources", async () => {
  const { providerMessages, reservedProviderInput } =
    await import("@laita/contracts");
  const { courseEvidencePrompt } = await import("@laita/course-grounding");
  const sources = [1, 2, 3].map((n) => ({
    course: "IA340",
    repository: "JMU-Data/IA340",
    commit: "a".repeat(40),
    path: `docs/assignments/lab-4/part-${n}.md`,
    section: `Instructions ${n}`,
    url: `https://github.com/JMU-Data/IA340/blob/${"a".repeat(40)}/docs/assignments/lab-4/part-${n}.md`,
    excerpt: `Instruction ${n}. ` + "x".repeat(850),
  }));
  let calls = 0,
    used;
  const execute = createCourseAwareExecution({
    grounder: {
      async ground() {
        return {
          status: "FOUND",
          course: "IA340",
          snapshot: "a".repeat(40),
          sources,
        };
      },
    },
    async executeProvider(value, _signal, _session, evidence) {
      calls++;
      used = { value, evidence };
      assert.ok(
        reservedProviderInput(
          providerMessages(value.input, "LOCAL", evidence),
        ) <= 3584,
      );
      return providerResult();
    },
  });
  const question = "what do we do in lab4 of ia340";
  for (const model of ["gemma4:12b-mlx", "llama3.1:8b"]) {
    const req = request(question);
    req.localModel = model;
    req.input.history = [
      { role: "USER", content: "Earlier question." },
      { role: "ASSISTANT", provider: "LOCAL", content: "Earlier answer." },
    ];
    const result = await execute(req, new AbortController().signal, session);
    assert.equal(result.grounding.status, "GROUNDED");
    assert.equal(result.grounding.sources.length, 2);
    assert.equal(used.value, req);
    assert.equal(
      used.evidence.prompt,
      courseEvidencePrompt(result.grounding.sources),
    );
    assert.deepEqual(used.evidence.refs, [
      "course-source-1",
      "course-source-2",
    ]);
    assert.equal(isProviderRunResult(result), true);
  }
  const req = request(question);
  req.input.text = question + " " + "x".repeat(2300);
  req.input.history = [{ role: "USER", content: "Old context." }];
  const events = [];
  const limited = await execute(
    req,
    new AbortController().signal,
    session,
    (...args) => events.push(args),
  );
  assert.equal(limited.grounding.status, "EVIDENCE_INPUT_LIMIT");
  assert.equal(limited.legs.length, 0);
  assert.equal(calls, 2);
  assert.ok(events.some((e) => e[1] === "EVIDENCE_INPUT_LIMIT"));
  assert.ok(!events.some((e) => e[1] === "SOURCES_SELECTED"));
  assert.equal(isProviderRunResult(limited), true);

  // Keep a ranked prefix: do not substitute a smaller third source after the
  // second source no longer fits, even though the third alone would fit.
  const smallThird = { ...sources[2], excerpt: "Small lower-ranked excerpt." };
  sources[2] = smallThird;
  const ranked = request(question);
  ranked.input.history = [{ role: "USER", content: "h".repeat(1100) }];
  const prefix = await execute(ranked, new AbortController().signal, session);
  assert.deepEqual(prefix.grounding.sources, [sources[0]]);
  assert.ok(
    reservedProviderInput(
      providerMessages(ranked.input, "LOCAL", {
        systemInstruction: "s".repeat(543),
        prompt: courseEvidencePrompt([sources[0], smallThird]),
      }),
    ) <= 3584,
    "smaller third source could fit but must not displace rank 2",
  );
});

test("follow-up reclaims oldest whole turns only when one ranked source cannot fit", async () => {
  const { validConversation, providerMessages, reservedProviderInput } =
    await import("@laita/contracts");
  const { courseEvidencePrompt, courseGroundingInstruction } =
    await import("@laita/course-grounding");
  const text = "What must I submit for IA340 Lab 4?";
  const sources = [1, 2, 3].map((n) => ({
    course: "IA340",
    repository: "JMU-Data/IA340",
    commit: "a".repeat(40),
    path: `docs/assignments/lab-4/part-${n}.md`,
    section: `Instructions ${n}`,
    url: `https://github.com/JMU-Data/IA340/blob/${"a".repeat(40)}/docs/assignments/lab-4/part-${n}.md`,
    excerpt: "Submit the database address. " + "x".repeat(850),
  }));
  const history = [
    { role: "USER", content: "Earlier RA340 question. " + "u".repeat(50) },
    {
      role: "ASSISTANT",
      provider: "LOCAL",
      content: "Earlier generic answer. " + "a".repeat(1750),
    },
    { role: "USER", content: "Recent question." },
    { role: "ASSISTANT", provider: "LOCAL", content: "Recent answer." },
  ];
  const req = request(text);
  req.input.history = history;
  assert.equal(validConversation(text, history), true);
  const evidence = {
    systemInstruction: courseGroundingInstruction,
    prompt: courseEvidencePrompt([sources[0]]),
  };
  const before = reservedProviderInput(
    providerMessages(req.input, "LOCAL", evidence),
  );
  assert.ok(before > 3584);
  let calls = 0,
    used;
  const events = [];
  const execute = createCourseAwareExecution({
    grounder: {
      async ground() {
        return {
          status: "FOUND",
          course: "IA340",
          snapshot: "a".repeat(40),
          sources,
        };
      },
    },
    async executeProvider(value, signal, sessionRef, actualEvidence) {
      calls++;
      used = { value, evidence: actualEvidence };
      return providerResult();
    },
  });
  const result = await execute(
    req,
    new AbortController().signal,
    session,
    (...e) => events.push(e),
  );
  assert.equal(result.grounding.status, "GROUNDED");
  assert.equal(calls, 1);
  assert.equal(used.value.input.text, text);
  assert.deepEqual(used.value.input.history, history.slice(2));
  assert.deepEqual(req.input.history, history);
  assert.equal(
    used.evidence.prompt,
    courseEvidencePrompt(result.grounding.sources),
  );
  const after = reservedProviderInput(
    providerMessages(used.value.input, "LOCAL", used.evidence),
  );
  assert.ok(after <= 3584);
  assert.ok(
    events.some((e) => e[0] === "RETRIEVAL" && e[1] === "CONTEXT_REDUCED"),
  );
  console.log(
    JSON.stringify({
      reproduction: "whole-turn-budget",
      before,
      after,
      removedMessages: 2,
      remainingMessages: 2,
      selectedSources: result.grounding.sources.length,
    }),
  );
});

test("follow-up fitting preserves recent turns, supports repeated whole removals and fails closed when impossible", async () => {
  const { providerMessages, reservedProviderInput, validConversation } =
    await import("@laita/contracts");
  const { courseEvidencePrompt } = await import("@laita/course-grounding");
  const source = {
    course: "IA340",
    repository: "JMU-Data/IA340",
    commit: "a".repeat(40),
    path: "docs/assignments/lab-4/index.md",
    section: "Instructions",
    url: `https://github.com/JMU-Data/IA340/blob/${"a".repeat(40)}/docs/assignments/lab-4/index.md`,
    excerpt: "Submit the database address. " + "x".repeat(850),
  };
  let calls = 0,
    used;
  const execute = createCourseAwareExecution({
    grounder: {
      async ground() {
        return {
          status: "FOUND",
          course: "IA340",
          snapshot: source.commit,
          sources: [source],
        };
      },
    },
    async executeProvider(value, signal, sessionRef, evidence) {
      calls++;
      used = value;
      assert.ok(
        reservedProviderInput(
          providerMessages(value.input, "LOCAL", evidence),
        ) <= 3584,
      );
      assert.equal(evidence.prompt, courseEvidencePrompt([source]));
      return providerResult();
    },
  });
  const pair = (size) => [
    { role: "USER", content: "Older question" },
    { role: "ASSISTANT", provider: "LOCAL", content: "a".repeat(size) },
  ];
  for (const [history, text, removed, status] of [
    [pair(20), "IA340 Lab 4", 0, "GROUNDED"],
    [[...pair(40), ...pair(2000), ...pair(20)], "IA340 Lab 4", 2, "GROUNDED"],
    [
      [
        ...pair(2000),
        { role: "ASSISTANT", provider: "OPENAI", content: "Other old leg" },
        ...pair(20),
      ],
      "IA340 Lab 4",
      1,
      "GROUNDED",
    ],
    [pair(20), "IA340 Lab 4 " + "q".repeat(2400), 1, "EVIDENCE_INPUT_LIMIT"],
    // Existing representation also permits unanswered USER turns and orphan
    // assistant prefixes; neither may be split or attached to another turn.
    [
      [
        { role: "ASSISTANT", provider: "LOCAL", content: "a".repeat(2100) },
        ...pair(20),
      ],
      "IA340 Lab 4",
      1,
      "GROUNDED",
    ],
  ]) {
    const req = request(text);
    req.input.history = history;
    assert.equal(validConversation(text, history), true);
    const original = structuredClone(req),
      events = [],
      before = calls;
    const result = await execute(
      req,
      new AbortController().signal,
      session,
      (...e) => events.push(e),
    );
    assert.equal(result.grounding.status, status);
    assert.deepEqual(req, original);
    assert.equal(
      events.filter((e) => e[1] === "CONTEXT_REDUCED").length,
      removed,
    );
    if (status === "GROUNDED") {
      assert.equal(calls, before + 1);
      assert.equal(used.input.text, text);
      assert.equal(used.localModel, req.localModel);
      assert.deepEqual(used.input.history, removed ? pair(20) : history);
    } else {
      assert.equal(calls, before);
      assert.equal(result.legs.length, 0);
    }
  }
});

test("follow-up transcript alias routing keeps typed behavior and Cloud isolation", async () => {
  let calls = 0,
    grounded = 0;
  const inputs = [];
  const execute = createCourseAwareExecution({
    grounder: {
      async ground(text, signal, trace, source) {
        grounded++;
        inputs.push({ text, source });
        return { status: "AMBIGUOUS", course: "IA340" };
      },
    },
    async executeProvider() {
      calls++;
      return providerResult();
    },
  });
  const text = "What must I submit for RA340 lab 4?",
    req = request(text),
    events = [];
  const voice = await execute(
    req,
    new AbortController().signal,
    session,
    (...e) => events.push(e),
    "TRANSCRIPT",
  );
  assert.equal(voice.grounding.status, "EVIDENCE_AMBIGUOUS");
  assert.equal(calls, 0);
  assert.deepEqual(inputs, [{ text, source: "TRANSCRIPT" }]);
  assert.ok(events.some((e) => e[1] === "TRANSCRIPT_ALIAS_RECOVERED"));
  const typed = await execute(
    req,
    new AbortController().signal,
    session,
    undefined,
    "TYPED",
  );
  assert.equal(typed.grounding, undefined);
  assert.equal(calls, 1);
  for (const mode of ["OPENAI", "COMPARE"]) {
    const result = await execute(
      request(text, mode),
      new AbortController().signal,
      session,
      undefined,
      "TRANSCRIPT",
    );
    assert.equal(result.grounding.status, "LOCAL_ONLY");
  }
  const mixed = await execute(
    request("RA340 and IA342 lab 4"),
    new AbortController().signal,
    session,
    undefined,
    "TRANSCRIPT",
  );
  assert.equal(mixed.grounding.status, "EVIDENCE_AMBIGUOUS");
  assert.equal(grounded, 1);
  assert.equal(calls, 1);
});
