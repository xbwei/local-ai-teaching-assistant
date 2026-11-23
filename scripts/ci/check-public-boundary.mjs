import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function publicBoundaryViolations(file, bytes) {
  const violations = [];
  if (
    (file !== "AGENTS.md" && /(^|\/)AGENTS\.md$/iu.test(file)) ||
    /(^|\/)(?:logs|backups|recordings|student-data|exports)\//u.test(file)
  )
    violations.push("private/local path");
  const reviewedVideo = "docs/assets/demo/laita-pi-demo.mp4";
  if (
    /\.(?:sqlite(?:3)?|db|wav|mp3|mp4|pem|key)$/iu.test(file) &&
    file !== reviewedVideo
  )
    violations.push("runtime/secret/media artifact");
  const isImage = /\.(?:png|jpe?g|webp|gif)$/iu.test(file);
  const reviewedImages = new Set(
    [
      "laita-main-chat.png",
      "laita-course-grounding.png",
      "laita-pi-client.jpg",
      "laita-mac-mini.jpg",
      "laita-history-review.png",
      "laita-phone-entry.png",
      "laita-phone-chat.png",
    ].map((name) => `docs/assets/screenshots/${name}`),
  );
  reviewedImages.add("docs/assets/demo/laita-demo.gif");
  // Owner-authorized sandbox derivative; provenance/privacy: docs/SCREENSHOTS.md.
  reviewedImages.add("docs/assets/demo/laita-v020-canvas.gif");
  // v0.3.0 gallery locations. Each asset still requires manual provenance and privacy review.
  for (const imagePath of [
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
    reviewedImages.add(imagePath);
  // Same-origin raster renders of the repository wordmark for online installation.
  for (const size of [180, 192, 512])
    reviewedImages.add(`apps/web/public/assets/pwa/icon-${size}.png`);
  if (isImage && !reviewedImages.has(file))
    violations.push("unreviewed image location");
  if (!isImage && file !== reviewedVideo) {
    const text = bytes.toString("utf8");
    // Assemble forbidden values so this guard does not itself contain private identifiers.
    const markers = [
      "jmu" + "-teaching-dev",
      "jmu" + "-teaching-plan",
      "JMU" + "_",
      "canvas." + "jmu.edu",
      "S" + "CHOOL",
      "/Us" + "ers/",
    ];
    if (markers.some((marker) => text.includes(marker)))
      violations.push("private source/host/config identifier");
    if (
      /github\.com\/[^\s/]+\/[^\s/]+\/(?:issues|pull)\/\d+/u.test(text) &&
      !text.includes("local-ai-teaching-assistant")
    )
      violations.push("external issue/handoff reference");
  }
  return violations;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  let failed = false;
  for (const file of files) {
    const issues = publicBoundaryViolations(file, readFileSync(file));
    if (issues.length) {
      console.error(`${file}: ${issues.join(", ")}`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
  else
    console.log(
      `Public boundary passed: ${files.length} tracked files; images require manual Owner-authorized provenance/privacy review.`,
    );
}
