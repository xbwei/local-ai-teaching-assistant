import test from "node:test";
import assert from "node:assert/strict";
import { runInputAcceptance } from "./input-acceptance.mjs";
test("bounded acceptance confirms after cleanup, makes exactly two fake inferences and resets", async () => {
  let inferences = 0,
    reset = false;
  const calls = [];
  const result = await runInputAcceptance(
    async (route, init) => {
      calls.push(route);
      if (route === "/sessions") return { sessionRef: "a".repeat(64) };
      if (route === "/choices")
        return {
          providers: {
            identity: {},
            providers: [{ id: "LOCAL", models: [{ id: "synthetic" }] }],
          },
        };
      if (route === "/interactions") {
        inferences++;
        return { jobRef: "answer" };
      }
      if (route === "/transcriptions") {
        assert.equal(inferences, 1);
        return { jobRef: "speech" };
      }
      if (route === "/jobs/speech")
        return {
          state: "REVIEW",
          cleanup: "DELETED",
          transcript: {
            text: "Synthetic speech.",
            transcriptRef: "b".repeat(64),
          },
        };
      if (route === "/jobs/answer")
        return {
          state: "COMPLETED",
          result: {
            legs: [
              { status: "COMPLETED", output: { text: "Synthetic answer." } },
            ],
          },
        };
      if (route === "/session") {
        reset = true;
        return {};
      }
      throw new Error();
    },
    Buffer.alloc(0),
    async () => {},
  );
  assert.equal(result.inferenceRequests, 2);
  assert.equal(inferences, 2);
  assert.equal(reset, true);
  assert.ok(calls.indexOf("/jobs/speech") < calls.lastIndexOf("/interactions"));
});

test("runtime build mismatch fails before inference and still resets", async () => {
  let calls = 0,
    reset = false;
  await assert.rejects(
    runInputAcceptance(
      async (route) => {
        if (route === "/sessions") return { sessionRef: "a".repeat(64) };
        if (route === "/build")
          return {
            commit: "b".repeat(40),
            profileVersion: "demo-profile.v4",
            sttIdentity: "synthetic",
          };
        if (route === "/session") {
          reset = true;
          return {};
        }
        calls++;
        throw new Error();
      },
      Buffer.alloc(0),
      async () => {},
      { commit: "a".repeat(40), sttIdentity: "synthetic" },
    ),
  );
  assert.equal(calls, 0);
  assert.equal(reset, true);
});

test("small acceptance refuses historical tiny and English-only runtime identities before inference", async () => {
  for (const identity of [
    "whisper.cpp/1.8.3/tiny-multilingual/ggml-f16",
    "whisper.cpp/1.8.3/small.en/ggml-f16",
  ]) {
    const calls = [];
    await assert.rejects(
      runInputAcceptance(
        async (route) => {
          calls.push(route);
          if (route === "/sessions") return { sessionRef: "a".repeat(64) };
          if (route === "/build")
            return {
              commit: "a".repeat(40),
              profileVersion: "demo-profile.v4",
              sttIdentity: identity,
            };
          if (route === "/session") return {};
          throw new Error("Unexpected inference or upload");
        },
        Buffer.alloc(0),
        async () => {},
        {
          commit: "a".repeat(40),
          sttIdentity: "whisper.cpp/1.8.3/small-multilingual/ggml-f16",
        },
      ),
    );
    assert.deepEqual(calls, ["/sessions", "/build", "/session"]);
  }
});
