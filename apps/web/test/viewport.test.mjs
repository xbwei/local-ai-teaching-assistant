import assert from "node:assert/strict";
import test from "node:test";
import {
  isVirtualKeyboardOpen,
  isTouchCapable,
  shouldAutofocusQuestion,
} from "../src/client/viewport.ts";

const fineOnly = {
  primaryFine: true,
  primaryCoarse: false,
  anyCoarse: false,
  maxTouchPoints: 0,
};
const coarseOnly = {
  primaryFine: false,
  primaryCoarse: true,
  anyCoarse: true,
  maxTouchPoints: 1,
};
const mixedAnyCoarse = {
  primaryFine: true,
  primaryCoarse: false,
  anyCoarse: true,
  maxTouchPoints: 1,
};
const mixedTouchPoints = {
  primaryFine: true,
  primaryCoarse: false,
  anyCoarse: false,
  maxTouchPoints: 1,
};

test("touch capability includes coarse-only and both mixed-input signals", () => {
  assert.equal(isTouchCapable(fineOnly), false);
  assert.equal(isTouchCapable(coarseOnly), true);
  assert.equal(isTouchCapable(mixedAnyCoarse), true);
  assert.equal(isTouchCapable(mixedTouchPoints), true);
});

test("autofocus is retained only for an idle connected fine-only client", () => {
  assert.equal(shouldAutofocusQuestion(true, false, true, fineOnly), true);
  assert.equal(shouldAutofocusQuestion(true, false, true, coarseOnly), false);
  assert.equal(
    shouldAutofocusQuestion(true, false, true, mixedAnyCoarse),
    false,
  );
  assert.equal(
    shouldAutofocusQuestion(true, false, true, mixedTouchPoints),
    false,
  );
  assert.equal(shouldAutofocusQuestion(false, false, true, fineOnly), false);
  assert.equal(shouldAutofocusQuestion(true, true, true, fineOnly), false);
  assert.equal(shouldAutofocusQuestion(true, false, false, fineOnly), false);
});

test("virtual keyboard state requires focus and a meaningful visual reduction", () => {
  assert.equal(isVirtualKeyboardOpen(480, 250, true), true);
  assert.equal(isVirtualKeyboardOpen(480, 400, true), false);
  assert.equal(isVirtualKeyboardOpen(480, 250, false), false);
  assert.equal(isVirtualKeyboardOpen(480, 250, false, true), true);
  assert.equal(isVirtualKeyboardOpen(480, 480, false, true), false);
  assert.equal(isVirtualKeyboardOpen(480, 240, true, false, 2), false);
  assert.equal(isVirtualKeyboardOpen(480, 150, true, false, 2), true);
  assert.equal(isVirtualKeyboardOpen(480, 480, true, false, 0.5), false);
  assert.equal(isVirtualKeyboardOpen(480, 300, true, false, 0.5), true);
});
