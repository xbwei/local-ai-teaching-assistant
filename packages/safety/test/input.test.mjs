import test from "node:test";
import assert from "node:assert/strict";
import { classifyInput } from "../dist/index.js";
import { reviewedPolicyRuntimeContract } from "@laita/contracts";
test("Owner text classification is independent of synthetic seeds; prohibited data rejected", () => {
  const text =
    reviewedPolicyRuntimeContract.successor.seed.cases[0].messages.at(
      -1,
    ).content;
  assert.equal(classifyInput(text).dataClass, "IDENTITY_MINIMIZED_USER_TEXT");
  assert.equal(
    classifyInput(text + " Please explain.").dataClass,
    "IDENTITY_MINIMIZED_USER_TEXT",
  );
  for (const v of [
    null,
    "",
    "x".repeat(8193),
    "fake@example.invalid",
    "password = synthetic",
    "student id 123456789",
    "my name is Synthetic Person",
    "\u0000",
    "active assessment answers",
    "学生成绩是八十分",
    "密码是 synthetic",
  ])
    assert.equal(classifyInput(v), undefined);
});
