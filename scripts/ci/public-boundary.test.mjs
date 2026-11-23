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
    "docs/assets/demo/laita-v020-canvas.gif",
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

test("public gate permits the ten exact v0.3.0 gallery paths with synthetic bytes", () => {
  for (const file of [
    "docs/assets/demo/v030-dev/01-Website-Roles.gif",
    "docs/assets/demo/v030-dev/02-Student-in-Canvas.gif",
    "docs/assets/demo/v030-dev/03-Teacher-Chat.gif",
    "docs/assets/demo/v030-dev/04-Teacher-Generate-excerpt.gif",
    "docs/assets/demo/v030-dev/05-Teacher-Verify.gif",
    "docs/assets/demo/v030-dev/06-Mobile-PWA-excerpt.gif",
    "docs/assets/screenshots/v030-dev/02h-Complete-course-answer.png",
    "docs/assets/screenshots/v030-dev/04d-Generated-assignment-suggestion.png",
    "docs/assets/screenshots/v030-dev/04k-Canvas-module-with-ordered-items.png",
    "docs/assets/screenshots/v030-dev/05e-MongoDB-count-and-sampled-fields.png",
  ])
    assert.deepEqual(
      publicBoundaryViolations(file, Buffer.from([0, 1])),
      [],
      file,
    );
});

test("public gate rejects adjacent and arbitrary media paths", () => {
  for (const file of [
    "docs/assets/demo/v030-dev/07-Unreviewed.gif",
    "docs/assets/demo/v030-dev/01-Website-Roles.GIF",
    "docs/assets/demo/v030-dev/02-Student-in-Canvas.png",
    "docs/assets/screenshots/v030-dev/06-Unreviewed.png",
    "docs/assets/screenshots/v030-dev/02h-Complete-course-answer-copy.png",
    "docs/assets/screenshots/v030-other/02h-Complete-course-answer.png",
    "assets/01-Website-Roles.gif",
  ])
    assert.deepEqual(
      publicBoundaryViolations(file, Buffer.from([0, 1])),
      ["unreviewed image location"],
      file,
    );
  assert.deepEqual(
    publicBoundaryViolations(
      "docs/assets/demo/v030-dev/01-Website-Roles.mp4",
      Buffer.from([0, 1]),
    ),
    ["runtime/secret/media artifact"],
  );
});
