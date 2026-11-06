import test from "node:test";
import assert from "node:assert/strict";
import { publicBoundaryViolations } from "./check-public-boundary.mjs";

test("public gate rejects runtime/private paths and private identifiers while permitting sanitized repository instructions and referenced public courses", () => {
  for (const file of [
    "logs/debug.txt",
    "logs/AGENTS.md",
    "sub/AGENTS.md",
    "sub/agents.md",
    "sub/Agents.md",
    "agents.md",
    "Agents.md",
    "docs/nested/AGENTS.md",
    "docs/nested/AGENTS.MD",
    "recordings/voice.wav",
    "history.sqlite",
    "secret.pem",
    "private.png",
    "docs/screenshots/synthetic.png",
    "docs/assets/screenshots/unreviewed.jpg",
    "docs/assets/demo/unreviewed.mp4",
    "docs/assets/demo/unreviewed.gif",
  ])
    assert.ok(
      publicBoundaryViolations(file, Buffer.from("synthetic")).length,
      file,
    );
  for (const text of [
    "JMU" + "_CONFIG",
    "canvas." + "jmu.edu",
    "S" + "CHOOL",
    "/Us" + "ers/operator",
    "jmu" + "-teaching-dev",
  ])
    for (const file of ["example.ts", "AGENTS.md"])
      assert.ok(publicBoundaryViolations(file, Buffer.from(text)).length, file);
  assert.ok(
    publicBoundaryViolations(
      "AGENTS.md",
      Buffer.from("https://github.com/example/synthetic-repo/" + "issues/1"),
    ).includes("external issue/handoff reference"),
  );
  assert.deepEqual(
    publicBoundaryViolations(
      "AGENTS.md",
      Buffer.from("public-safe instructions"),
    ),
    [],
  );
  assert.deepEqual(
    publicBoundaryViolations(
      "example.ts",
      Buffer.from("https://github.com/JMU-Data/IA340"),
    ),
    [],
  );
  for (const file of [
    "docs/assets/screenshots/laita-history-review.png",
    "docs/assets/demo/laita-demo.gif",
    "docs/assets/demo/laita-pi-demo.mp4",
  ])
    assert.deepEqual(publicBoundaryViolations(file, Buffer.from([0, 1])), []);
  assert.deepEqual(
    publicBoundaryViolations(
      "docs/assets/screenshots/laita-main-chat.png",
      Buffer.from([0, 1]),
    ),
    [],
  );
});
