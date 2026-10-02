import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { initializePersistence } from "@laita/persistence";
import { initializeRuntimePaths } from "@laita/runtime";
import { classifyInput } from "@laita/safety";
import {
  providerMessages,
  reservedProviderInput,
  validConversation,
} from "@laita/contracts";
import {
  courseEvidencePrompt,
  courseGroundingInstruction,
} from "@laita/course-grounding";
import { createCourseAwareExecution } from "../apps/api/dist/course-execution.js";
import { fixture } from "../apps/api/test/browser-fixture.mjs";
import { InputApi } from "../apps/web/src/client/api.ts";
import { LearningClient } from "../apps/web/src/client/controller.ts";

// Synthetic source identity/text and synthetic provider outputs only.
const sources = [1, 2, 3].map((n) => ({
  course: "IA340",
  repository: "JMU-Data/IA340",
  commit: "a".repeat(40),
  path: `docs/assignments/lab-4/part-${n}.md`,
  section: `Instructions ${n}`,
  url: `https://github.com/JMU-Data/IA340/blob/${"a".repeat(40)}/docs/assignments/lab-4/part-${n}.md`,
  excerpt: "Submit the database address. " + "x".repeat(850),
}));
const firstEvidence = {
  systemInstruction: courseGroundingInstruction,
  prompt: courseEvidencePrompt(sources.slice(0, 1)),
};
const budget = (input) =>
  reservedProviderInput(providerMessages(input, "LOCAL", firstEvidence));
const question = "What must I submit for IA340 Lab 4?";
const marker = "fixture@example.invalid";

for (const scenario of [
  "safety only",
  "safety then budget",
  "still impossible",
]) {
  test(`browser/API/history course fitting: ${scenario}`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "safety-history-test-"));
    const paths = initializeRuntimePaths(root);
    assert.equal(paths.ok, true);
    const initialized = initializePersistence(paths.value);
    assert.equal(initialized.ok, true);
    const persistence = initialized.value,
      store = persistence.history();
    let calls = 0;
    const seen = [],
      prepared = [];
    const execute = createCourseAwareExecution({
      grounder: {
        async ground(text, signal, trace) {
          assert.ok(text.startsWith(question));
          trace("COURSE", "LOCATOR_CHECKED", undefined, {
            course: "IA340",
            lab: "4",
            sources: [],
          });
          return {
            status: "FOUND",
            course: "IA340",
            snapshot: sources[0].commit,
            sources,
          };
        },
      },
      async executeProvider(req, signal, session, evidence, trace) {
        calls++;
        seen.push({ req: structuredClone(req), evidence });
        assert.ok(classifyInput(req.input.text));
        assert.ok(
          (req.input.history ?? []).every((m) => classifyInput(m.content)),
        );
        if (evidence) {
          assert.ok(
            reservedProviderInput(
              providerMessages(req.input, "LOCAL", evidence),
            ) <= 3584,
          );
          assert.doesNotMatch(JSON.stringify(req), /fixture@example\.invalid/);
        }
        trace("ADMISSION", "PROVIDER_RESERVED");
        trace("PROVIDER", "STARTED");
        return {
          contractVersion: "provider-run-result.v1",
          interactionRef: `interaction-${randomUUID()}`,
          mode: req.mode,
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
                text:
                  calls === 1
                    ? `Synthetic database example: ${marker}`
                    : scenario === "safety then budget" && calls === 2
                      ? "a".repeat(1750)
                      : "A short synthetic answer.",
              },
              metrics: { latencyMs: 1 },
            },
          ],
        };
      },
    });
    const f = await fixture({
      history: store,
      execute(req, ...args) {
        prepared.push(structuredClone(req));
        return execute(req, ...args);
      },
    });
    const submitted = [];
    const api = new InputApi((route, init) => {
      if (route.endsWith("/interactions"))
        submitted.push(JSON.parse(init.body));
      return f.request(route, init);
    });
    const c = new LearningClient(() => {}, api, 2);
    t.after(() => {
      c.close();
      f.close();
      persistence.close();
      rmSync(root, { recursive: true, force: true });
    });
    await c.boot();
    await c.send(
      "Explain in several paragraphs how relational databases work. Aim for about 300 words.",
    );
    assert.equal(c.phase, "success");
    if (scenario !== "still impossible") {
      await c.send("Give me one short example.");
      assert.equal(c.phase, "success");
    }
    if (scenario === "safety then budget") {
      await c.send("Summarize in one sentence.");
      assert.equal(c.phase, "success");
    }
    const oldMessages = structuredClone(c.messages);
    const conversation = oldMessages[0].history.conversation;
    const oldRecords = store.conversation(conversation).turns;
    const beforeCalls = calls;
    const text =
      scenario === "still impossible"
        ? question + " " + "q".repeat(2300)
        : question;
    assert.ok(classifyInput(text));
    await c.send(text);
    const original = submitted.at(-1).request;
    const afterSafety = prepared.at(-1);
    assert.equal(validConversation(text, original.input.history), true);
    assert.ok(original.input.history.some((m) => !classifyInput(m.content)));
    assert.deepEqual(
      afterSafety.input.history,
      original.input.history.slice(2),
    );
    assert.equal(afterSafety.input.text, text);
    assert.equal(afterSafety.mode, "LOCAL");
    assert.equal(afterSafety.localModel, original.localModel);
    assert.deepEqual(c.messages.slice(0, oldMessages.length), oldMessages);
    assert.equal(c.messages.at(-2).text, text);
    const page = await api.historyRequest("conversation", { conversation });
    assert.deepEqual(page.turns.slice(0, oldRecords.length), oldRecords);
    const turn = page.turns.at(-1);
    assert.equal(turn.text, text);
    assert.equal(turn.course, "IA340");
    assert.equal(turn.lab, "4");
    assert.equal(turn.suspected, false);
    const reductions = turn.events.filter(
      (e) => e.outcome === "HISTORY_REDUCED",
    );
    assert.equal(reductions.length, 1);
    assert.equal(reductions[0].stage, "SAFETY");
    assert.deepEqual(Object.keys(reductions[0]).sort(), [
      "at",
      "origin",
      "outcome",
      "stage",
    ]);
    assert.doesNotMatch(JSON.stringify(turn), /fixture@example\.invalid/);
    assert.ok(
      turn.events.findIndex((e) => e.outcome === "HISTORY_REDUCED") <
        turn.events.findIndex((e) => e.stage === "COURSE"),
    );
    assert.equal(
      turn.events.filter((e) => e.outcome === "CONTEXT_REDUCED").length,
      scenario === "safety then budget" ? 1 : 0,
    );
    if (scenario === "still impossible") {
      assert.deepEqual(afterSafety.input.history, []);
      assert.ok(budget(afterSafety.input) > 3584);
      assert.equal(calls, beforeCalls);
      assert.equal(turn.outcome, "NO_ANSWER");
      assert.ok(turn.events.some((e) => e.outcome === "EVIDENCE_INPUT_LIMIT"));
      assert.ok(!turn.events.some((e) => e.outcome === "STARTED"));
      assert.deepEqual(turn.sources, []);
    } else {
      assert.equal(c.phase, "success");
      assert.equal(calls, beforeCalls + 1);
      const used = seen.at(-1);
      const removed = scenario === "safety then budget" ? 2 : 0;
      assert.deepEqual(
        used.req.input.history,
        afterSafety.input.history.slice(removed),
      );
      assert.equal(used.req.input.text, text);
      assert.equal(used.req.clientRequestId, original.clientRequestId);
      assert.deepEqual(c.messages.at(-1).sources, sources.slice(0, 2));
      assert.equal(
        used.evidence.prompt,
        courseEvidencePrompt(c.messages.at(-1).sources),
      );
      assert.deepEqual(used.evidence.refs, [
        "course-source-1",
        "course-source-2",
      ]);
      assert.deepEqual(
        turn.sources,
        sources.slice(0, 2).map(({ course, commit, path, section, url }) => ({
          course,
          commit,
          path,
          section,
          url,
        })),
      );
      for (const outcome of ["PROVIDER_RESERVED", "STARTED", "RETURNED"])
        assert.equal(
          turn.events.filter((e) => e.outcome === outcome).length,
          1,
        );
      if (scenario === "safety then budget")
        assert.ok(budget(afterSafety.input) > 3584);
      console.log(
        JSON.stringify({
          scenario,
          beforeSafetyFirstSource: budget(original.input),
          afterSafetyFirstSource: budget(afterSafety.input),
          afterBudgetFirstSource: budget(used.req.input),
          finalSelectedSources: reservedProviderInput(
            providerMessages(used.req.input, "LOCAL", used.evidence),
          ),
          providerCalls: calls - beforeCalls,
        }),
      );
    }
    assert.equal(
      calls,
      beforeCalls + (scenario === "still impossible" ? 0 : 1),
      "History browsing adds no provider usage",
    );
    assert.doesNotMatch(
      JSON.stringify(f.logs),
      /fixture@example\.invalid|COURSE EVIDENCE/,
    );
  });
}
