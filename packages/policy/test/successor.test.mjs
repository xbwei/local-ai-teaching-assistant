import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createCapabilityEvaluator,
  createDemoCapabilityContext,
} from "../dist/index.js";
const config = JSON.parse(
  readFileSync(
    new URL("../../runtime/examples/openai-demo.example.json", import.meta.url),
    "utf8",
  ),
);
const controls = {
  emergencyStop: false,
  local: {
    featureEnabled: true,
    scheduleOpen: true,
    withinBudget: true,
    quotaAvailable: true,
    state: "READY",
  },
  openai: {
    featureEnabled: true,
    scheduleOpen: true,
    withinBudget: true,
    quotaAvailable: true,
    state: "READY",
  },
};
test("v2 frozen, v4 Owner non-sensitive context is explicitly Cloud eligible; no role, privacy, model or control expansion", () => {
  for (const version of [2, 4]) {
    const evaluator = createCapabilityEvaluator({
      ...config,
      provenance: {
        demoProfileVersion: `demo-profile.v${version}`,
        policyVersion: `demo-policy.v${version}`,
      },
    });
    assert.ok(evaluator);
    for (const accessClass of ["INSTRUCTOR", "STUDENT", "ANONYMOUS_SESSION"])
      for (const dataClass of [
        "IDENTITY_FREE_USER_TEXT",
        "IDENTITY_MINIMIZED_USER_TEXT",
        "PRIVACY_SENSITIVE_STUDENT_CONTENT",
      ]) {
        const ctx = { ...createDemoCapabilityContext(accessClass), dataClass };
        const available = evaluator.availability(ctx, controls);
        const expected =
          accessClass === "INSTRUCTOR" &&
          (dataClass === "IDENTITY_FREE_USER_TEXT" ||
            (version === 4 && dataClass === "IDENTITY_MINIMIZED_USER_TEXT"));
        assert.equal(
          available.providers.some((p) => p.id === "LOCAL"),
          expected,
          JSON.stringify({ version, accessClass, dataClass }),
        );
        assert.equal(
          available.providers.some((p) => p.id === "OPENAI"),
          accessClass === "INSTRUCTOR" &&
            (dataClass === "IDENTITY_FREE_USER_TEXT" ||
              (version === 4 && dataClass === "IDENTITY_MINIMIZED_USER_TEXT")),
        );
        for (const field of [
          "featureEnabled",
          "scheduleOpen",
          "withinBudget",
          "quotaAvailable",
        ]) {
          const d = evaluator.authorizeSelection(
            ctx,
            { ...controls, local: { ...controls.local, [field]: false } },
            { provider: "LOCAL", model: config.providers.local.model },
            available.identity,
          );
          assert.equal(d.allowed, false);
        }
        assert.equal(
          evaluator.authorizeSelection(
            { ...ctx, activeAssessment: true },
            controls,
            { provider: "LOCAL", model: config.providers.local.model },
            available.identity,
          ).allowed,
          false,
        );
        assert.equal(
          evaluator.authorizeSelection(
            ctx,
            controls,
            { provider: "LOCAL", model: "unapproved" },
            available.identity,
          ).allowed,
          false,
        );
      }
  }
});
