import assert from "node:assert/strict";
import test from "node:test";
import { courseEvidencePrompt } from "@laita/course-grounding";
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
function request(text, history = []) {
  return {
    contractVersion: "provider-run-request.v1",
    clientRequestId: "123e4567-e89b-42d3-a456-426614174000",
    mode: "LOCAL",
    input: { text, history },
    capabilityIdentity: identity,
    localModel: "gemma4:12b-mlx",
  };
}
function reply() {
  return {
    contractVersion: "provider-run-result.v1",
    interactionRef: "interaction-123e4567-e89b-42d3-a456-426614174001",
    mode: "LOCAL",
    legs: [
      {
        runRef: "run-123e4567-e89b-42d3-a456-426614174003",
        provider: "LOCAL",
        model: "gemma4:12b-mlx",
        status: "COMPLETED",
        output: {
          text: "Synthetic answer; wording is outside this regression contract.",
        },
        provenance: {
          actualProvider: "LOCAL",
          actualModel: "gemma4:12b-mlx",
          adapter: "synthetic.v1",
        },
        metrics: { latencyMs: 1 },
      },
    ],
  };
}
const history = [
  { role: "USER", content: "Earlier unrelated synthetic question." },
  {
    role: "ASSISTANT",
    provider: "LOCAL",
    content: "Earlier synthetic answer.",
  },
];

test("synthetic Golden Q&A: bilingual whole-course paraphrases select course overview with exact provider sources", async (t) => {
  const { grounder } = await createGoldenGrounder(t);
  const forms = [
    "what do we learn in COURSE",
    "What will I learn in COURSE?",
    "What is COURSE about?",
    "Give me an overview of COURSE",
    "COURSE主要学什么？",
    "COURSE这门课学什么？",
    "请介绍一下COURSE这门课",
    "COURSE主要有哪些内容？",
    "COURSE究竟教些什么？",
    "能说说COURSE整门课的学习重点吗？",
    "COURSE课程会涵盖哪些方向？",
    "请概括COURSE的学习范围。",
    "在COURSE中总体会接触什么？",
    "COURSE的课程大纲介绍了什么？",
    "COURSE主要安排了哪些主题？",
    "COURSE是讲什么的？",
  ];
  let count = 0;
  for (const course of Object.keys(publicCourses))
    for (const form of forms)
      for (const previous of [[], history]) {
        const question = form.replace("COURSE", course);
        const calls = [];
        const execute = createCourseAwareExecution({
          grounder,
          async executeProvider(value, _signal, _session, evidence) {
            calls.push({ value, evidence });
            return reply();
          },
        });
        const result = await execute(
          request(question, previous),
          new AbortController().signal,
          "session-123e4567-e89b-42d3-a456-426614174005",
        );
        assert.equal(result.grounding?.status, "GROUNDED", question);
        assert.equal(result.grounding.course, course, question);
        assert.equal(
          result.grounding.snapshot,
          publicCourses[course].commit,
          question,
        );
        assert.equal(result.grounding.sources[0].path, "README.md", question);
        assert.equal(
          result.grounding.sources[0].section,
          "Course Overview",
          question,
        );
        assert.ok(
          result.grounding.sources.every(
            (source) =>
              source.course === course &&
              source.commit === publicCourses[course].commit &&
              !/assignments|modules/u.test(source.path),
          ),
          question,
        );
        assert.equal(calls.length, 1, question);
        assert.equal(calls[0].value.input.text, question);
        assert.deepEqual(calls[0].value.input.history, previous);
        assert.equal(
          calls[0].evidence.prompt,
          courseEvidencePrompt(result.grounding.sources),
        );
        assert.deepEqual(
          calls[0].evidence.refs,
          result.grounding.sources.map(
            (_, index) => `course-source-${index + 1}`,
          ),
        );
        count++;
      }
  assert.equal(count, 64);
});

test("synthetic Golden Q&A: specific unsupported claims and dual-course requests stop before fake provider", async (t) => {
  const { grounder } = await createGoldenGrounder(t);
  let providerCalls = 0;
  const execute = createCourseAwareExecution({
    grounder,
    async executeProvider() {
      providerCalls++;
      return reply();
    },
  });
  for (const question of [
    "Does IA340 teach TensorFlow?",
    "IA340会教TensorFlow吗？",
    "IA340会不会要求12页PDF？",
    "Does IA342 require a twelve-page PDF?",
    "IA342会教TensorFlow吗？",
    "Compare the whole courses IA340 and IA342.",
  ]) {
    const result = await execute(
      request(question),
      new AbortController().signal,
      "session-123e4567-e89b-42d3-a456-426614174005",
    );
    assert.notEqual(result.grounding?.status, "GROUNDED", question);
    assert.equal(result.legs.length, 0, question);
  }
  assert.equal(providerCalls, 0);
});

test("synthetic Golden Q&A: Lab and Week locators stay precise, including verified transcript aliases", async (t) => {
  const { grounder } = await createGoldenGrounder(t);
  for (const course of Object.keys(publicCourses))
    for (const [question, expectedPath, source] of [
      [
        `What must I submit for ${course} Lab 4?`,
        "docs/assignments/lab-4/index.md",
        "TYPED",
      ],
      [
        `What must I submit for ${course} Lab 5?`,
        "docs/assignments/lab-5/index.md",
        "TYPED",
      ],
      [`${course} Week 1`, "docs/modules/module-1/index.md", "TYPED"],
      [
        `What must I submit for ${course.replace("IA", "RA")} Lab 5?`,
        "docs/assignments/lab-5/index.md",
        "TRANSCRIPT",
      ],
      [`${course.replace("IA", "RA")}主要学什么？`, "README.md", "TRANSCRIPT"],
    ]) {
      const calls = [];
      const execute = createCourseAwareExecution({
        grounder,
        async executeProvider(value, _signal, _session, evidence) {
          calls.push({ value, evidence });
          return reply();
        },
      });
      const result = await execute(
        request(question),
        new AbortController().signal,
        "session-123e4567-e89b-42d3-a456-426614174005",
        undefined,
        source,
      );
      assert.equal(result.grounding?.status, "GROUNDED", question);
      assert.equal(result.grounding.course, course, question);
      assert.equal(result.grounding.sources[0].path, expectedPath, question);
      assert.equal(calls.length, 1, question);
      assert.equal(
        calls[0].evidence.prompt,
        courseEvidencePrompt(result.grounding.sources),
        question,
      );
    }
});
