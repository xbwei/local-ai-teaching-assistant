import test from "node:test";
import assert from "node:assert/strict";
import { publicBoundaryViolations } from "./check-public-boundary.mjs";

test("public gate rejects runtime/private paths and private identifiers while permitting referenced public courses", () => {
  for (const file of [
    "AGENTS.md",
    "logs/debug.txt",
    "recordings/voice.wav",
    "history.sqlite",
    "secret.pem",
    "private.png",
    "docs/screenshots/synthetic.png",
    "docs/assets/screenshots/unreviewed.jpg",
  ])
    assert.ok(
      publicBoundaryViolations(file, Buffer.from("synthetic")).length,
      file,
    );
  for (const text of [
    "JMU" + "_CONFIG",
    "S" + "CHOOL",
    "/Us" + "ers/operator",
    "jmu" + "-teaching-dev",
  ])
    assert.ok(publicBoundaryViolations("example.ts", Buffer.from(text)).length);
  assert.deepEqual(
    publicBoundaryViolations(
      "example.ts",
      Buffer.from("https://github.com/JMU-Data/IA340"),
    ),
    [],
  );
  assert.deepEqual(
    publicBoundaryViolations(
      "docs/assets/screenshots/laita-main-chat.png",
      Buffer.from([0, 1]),
    ),
    [],
  );
});
