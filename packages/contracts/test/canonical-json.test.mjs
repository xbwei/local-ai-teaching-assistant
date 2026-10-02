import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../dist/index.js";

test("canonical JSON is key-order independent and rejects cycles or accessors", () => {
  assert.equal(
    canonicalJson({ b: [2, { z: false }], a: 1 }),
    canonicalJson({ a: 1, b: [2, { z: false }] }),
  );
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /cyclic canonical value/);
  let accessed = false;
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      accessed = true;
      return "unsafe";
    },
  });
  assert.throws(() => canonicalJson(accessor), /unsupported canonical value/);
  assert.equal(accessed, false);
});

test("canonical JSON bounds deeply nested input without recursive stack overflow", () => {
  let deeplyNested = null;
  for (let index = 0; index < 10_001; index++)
    deeplyNested = { value: deeplyNested };
  assert.throws(() => canonicalJson(deeplyNested), /too complex/);
});
