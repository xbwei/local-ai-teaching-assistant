/** Opt-in, read-only current public-source retrieval. No model or credential use. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createCourseGrounder,
  refreshCourseSources,
} from "@laita/course-grounding";

const githubCli = process.env.PUBLIC_COURSE_GITHUB_CLI === "1";
const fetcher = githubCli
  ? async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.github.com");
      assert.match(url.pathname, /^\/repos\/JMU-Data\/(IA340|IA342)(?:\/|$)/u);
      const { stdout } = await promisify(execFile)(
        "gh",
        ["api", url.pathname + url.search],
        { signal: init?.signal, timeout: 10000, maxBuffer: 8 * 1024 * 1024 },
      );
      return new Response(stdout, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
  : undefined;
const root = realpathSync(
  mkdtempSync(path.join(tmpdir(), "laita-public-course-check-")),
);
chmodSync(root, 0o700);
try {
  const refresh = await refreshCourseSources(root, {
    signal: AbortSignal.timeout(60000),
    ...(fetcher ? { fetcher } : {}),
  });
  assert.equal(
    refresh.ok,
    true,
    "Public-source refresh unavailable; do not infer a live retrieval PASS.",
  );
  const grounder = createCourseGrounder(root, fetcher ? { fetcher } : {});
  const results = [];
  for (const course of ["IA340", "IA342"]) {
    for (const question of [
      `What will I learn in ${course}?`,
      `${course}这门课学什么？`,
      `What must I submit for ${course} Lab 5?`,
      `${course} Week 1`,
    ]) {
      const result = await grounder.ground(
        question,
        AbortSignal.timeout(10000),
      );
      assert.equal(result.status, "FOUND", question);
      assert.ok(result.sources.length);
      for (const source of result.sources) {
        assert.equal(source.course, course);
        assert.equal(source.commit, refresh.courses[course].commit);
        assert.ok(
          source.url.startsWith(
            `https://github.com/JMU-Data/${course}/blob/${source.commit}/`,
          ),
        );
      }
      results.push({
        course,
        question,
        status: result.status,
        commit: result.snapshot,
        paths: result.sources.map((s) => s.path),
      });
    }
  }
  const unsupported = await grounder.ground(
    "Compare the whole courses IA340 and IA342.",
    AbortSignal.timeout(10000),
  );
  assert.notEqual(unsupported.status, "FOUND");
  results.push({
    question: "dual-course comparison",
    status: unsupported.status,
  });
  console.log(
    JSON.stringify(
      {
        modelCalls: 0,
        publicReadTransport: githubCli ? "GitHub CLI" : "anonymous GitHub API",
        results,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
