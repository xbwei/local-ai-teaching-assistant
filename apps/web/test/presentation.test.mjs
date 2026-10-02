import test from "node:test";
import assert from "node:assert/strict";
import {
  courseGroundingNoticeText,
  providerFailureText,
  localResidencyText,
} from "../src/client/presentation.ts";

test("course grounding failures have fixed explicit non-fallback copy", () => {
  const copy = {
    LOCAL_ONLY: /only in Local mode.*No course excerpts were sent to OpenAI/,
    SOURCES_UNAVAILABLE:
      /snapshot is unavailable.*did not answer from model memory/,
    EVIDENCE_NOT_FOUND:
      /did not find reliable support.*did not generate.*citation/,
    EVIDENCE_AMBIGUOUS: /ambiguous.*no course answer or citation/,
    EVIDENCE_CONFLICTING: /conflicting.*did not choose one version/,
  };
  for (const [status, expected] of Object.entries(copy))
    assert.match(courseGroundingNoticeText(status), expected);
});

test("affected course notices follow the current question language without echoing it", () => {
  for (const status of [
    "LOCAL_ONLY",
    "SOURCES_UNAVAILABLE",
    "EVIDENCE_INPUT_LIMIT",
    "EVIDENCE_NOT_FOUND",
    "EVIDENCE_AMBIGUOUS",
    "EVIDENCE_CONFLICTING",
  ]) {
    const chinese = courseGroundingNoticeText(status, "请介绍 IA340 私有标记");
    assert.match(chinese, /[\u4e00-\u9fff]/u);
    assert.doesNotMatch(chinese, /私有标记/u);
    const english = courseGroundingNoticeText(status, "What is IA340 about?");
    assert.doesNotMatch(english, /[\u4e00-\u9fff]/u);
  }
});

const messages = {
  TIMEOUT: /took too long/,
  MODEL_LOADING: /loading or busy/,
  MODEL_SWITCHING: /loading or busy/,
  PROVIDER_BUSY: /loading or busy/,
  SELECTED_MODEL_UNAVAILABLE: /Selected Local model is currently unavailable/,
  SELECTED_PROVIDER_UNAVAILABLE:
    /Selected Local model is currently unavailable/,
  TEMPORARY_PROVIDER_FAILURE: /temporary problem/,
  POLICY_DENIED: /current policy/,
  PROVIDER_DISABLED: /current policy/,
  OVER_BUDGET: /usage limit/,
  OVER_QUOTA: /usage limit/,
  AUTHENTICATION_FAILED: /access could not be verified/,
  STALE_AUTHORIZATION: /choices changed/,
  INVALID_REQUEST: /revise it/,
  CANCELLED: /cancelled/,
  INTERNAL_FAILURE: /could not finish/,
};
test("public failure copy is code-specific, provider-labelled and respects retryability", () => {
  for (const [code, expected] of Object.entries(messages)) {
    assert.match(providerFailureText("LOCAL", code, true), expected);
    assert.doesNotMatch(providerFailureText("OPENAI", code, true), /Local/);
  }
  for (const code of [
    "TIMEOUT",
    "MODEL_LOADING",
    "PROVIDER_BUSY",
    "TEMPORARY_PROVIDER_FAILURE",
    "INTERNAL_FAILURE",
  ])
    assert.doesNotMatch(
      providerFailureText("LOCAL", code, false),
      /try again/i,
    );
  assert.doesNotMatch(
    providerFailureText("LOCAL", "private raw exception", false),
    /private raw exception/,
  );
});
test("residency copy distinguishes installed/unloaded from warm, loading and unavailable", () => {
  const c = {
    providers: {
      providers: [
        { id: "LOCAL", state: "READY", models: [{ id: "llama3.1:8b" }] },
      ],
    },
    local: { selectedModel: "llama3.1:8b", residency: "UNLOADED" },
  };
  for (const [state, expected] of Object.entries({
    UNLOADED: /installed, currently not in memory.*automatically/,
    WARM: /ready, in memory/,
    LOADING: /loading/,
    UNAVAILABLE: /currently unavailable/,
    BUSY: /busy/,
    SWITCHING: /switching/,
    UNKNOWN: /not known/,
  })) {
    c.local.residency = state;
    const text = localResidencyText("llama3.1:8b", c);
    assert.match(text, expected);
    assert.match(text, /^Llama 8B/);
    assert.doesNotMatch(text, new RegExp(state));
  }
  c.local.residency = "WARM";
  c.local.selectedModel = "gemma4:12b-mlx";
  assert.match(localResidencyText("llama3.1:8b", c), /not known/);
  c.providers.providers[0].models = [];
  assert.match(
    localResidencyText("llama3.1:8b", c),
    /unavailable under current policy/,
  );
});
