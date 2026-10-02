import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createCourseGrounder,
  refreshCourseSources,
} from "@laita/course-grounding";

// Entirely synthetic teaching text. No upstream course content is bundled.
// Commit identities below are synthetic and must never be presented as live evidence.
const texts = {
  IA340: "Data mining, databases, Python analysis and communicating results.",
  IA342:
    "Data visualization, Tableau worksheets, dashboards and visual analysis.",
};
const syntheticFiles = (course) => ({
  "README.md": `# ${course} synthetic fixture\n\n## Course Overview\n${texts[course]}\n`,
  "docs/index.md": `# ${course} synthetic navigation\nCourse overview and assignment navigation.\n`,
  "docs/assignments/lab-4/index.md": `# ${course} Lab 4\n\n## Submission\nSubmit a synthetic report describing the analysis.\n`,
  "docs/assignments/lab-5/index.md": `# ${course} Lab 5\n\n## Submission\nSubmit a synthetic notebook and explain the results.\n`,
  "docs/modules/module-1/index.md": `# ${course} Week 1\n\n## Learning objectives\nIntroduction to analysis and public course tools.\n`,
});
export const publicCourses = Object.fromEntries(
  Object.keys(texts).map((course, i) => [
    course,
    {
      commit: (i ? "b" : "a").repeat(40),
      files: Object.fromEntries(
        Object.entries(syntheticFiles(course)).map(([file, text]) => {
          const bytes = Buffer.from(text);
          return [
            file,
            createHash("sha1")
              .update(`blob ${bytes.length}\0`)
              .update(bytes)
              .digest("hex"),
          ];
        }),
      ),
    },
  ]),
);

export async function createGoldenGrounder(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "course-golden-")));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const blobs = Object.fromEntries(
    Object.entries(publicCourses).map(([course, details]) => [
      course,
      Object.entries(details.files).map(([file, sha]) => {
        const bytes = Buffer.from(syntheticFiles(course)[file]);
        const actual = createHash("sha1")
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex");
        assert.equal(
          actual,
          sha,
          `${course}/${file} changed from its synthetic Git blob`,
        );
        return { file, sha, bytes };
      }),
    ]),
  );
  const fetcher = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com");
    const match = /^\/repos\/JMU-Data\/(IA340|IA342)(.*)$/u.exec(url.pathname);
    assert.ok(match, `unexpected fixture request: ${url.pathname}`);
    const [, course, suffix] = match;
    const details = publicCourses[course];
    const courseBlobs = blobs[course];
    let value;
    if (suffix === "")
      value = {
        full_name: `JMU-Data/${course}`,
        private: false,
        visibility: "public",
        default_branch: "main",
      };
    else if (suffix === "/commits/main") value = { sha: details.commit };
    else if (suffix === `/git/trees/${details.commit}`)
      value = {
        sha: details.commit,
        url: "https://api.github.test/tree",
        tree: courseBlobs.map(({ file, sha, bytes }) => ({
          path: file,
          mode: "100644",
          type: "blob",
          sha,
          size: bytes.length,
          url: "https://api.github.test/blob",
        })),
        truncated: false,
      };
    else if (suffix.startsWith("/git/blobs/")) {
      const blob = courseBlobs.find(
        ({ sha }) => suffix === `/git/blobs/${sha}`,
      );
      assert.ok(blob, `unexpected public blob: ${suffix}`);
      value = {
        sha: blob.sha,
        size: blob.bytes.length,
        content: blob.bytes.toString("base64"),
        encoding: "base64",
      };
    } else assert.fail(`unexpected fixture route: ${suffix}`);
    return Response.json(value);
  };
  const now = () => new Date("2026-09-27T12:00:00.000Z");
  assert.equal((await refreshCourseSources(root, { fetcher, now })).ok, true);
  return {
    root,
    grounder: createCourseGrounder(root, { fetcher, now }),
    now,
    fetcher,
  };
}
