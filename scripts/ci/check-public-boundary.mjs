import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function publicBoundaryViolations(file, bytes) {
  const violations = [];
  if (
    /(^|\/)AGENTS\.md$|(^|\/)(?:logs|backups|recordings|student-data|exports)\//u.test(
      file,
    )
  )
    violations.push("private/local path");
  if (/\.(?:sqlite(?:3)?|db|wav|mp3|mp4|pem|key)$/iu.test(file))
    violations.push("runtime/secret/media artifact");
  const isImage = /\.(?:png|jpe?g|webp|gif)$/iu.test(file);
  const reviewedImages = new Set(
    [
      "laita-main-chat.png",
      "laita-course-grounding.png",
      "laita-pi-client.jpg",
      "laita-mac-mini.jpg",
    ].map((name) => `docs/assets/screenshots/${name}`),
  );
  if (isImage && !reviewedImages.has(file))
    violations.push("unreviewed image location");
  if (!isImage) {
    const text = bytes.toString("utf8");
    // Assemble forbidden values so this guard does not itself contain private identifiers.
    const markers = [
      "jmu" + "-teaching-dev",
      "jmu" + "-teaching-plan",
      "JMU" + "_",
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
