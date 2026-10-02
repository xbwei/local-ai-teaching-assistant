import { initializeRuntimePaths } from "@laita/runtime";
import { refreshCourseSources } from "./index.ts";

const configuredRoot = process.argv[2];
if (!configuredRoot || process.argv.length !== 3) {
  process.stderr.write(
    "Usage: npm run course-sources:refresh -- /absolute/runtime/root\n",
  );
  process.exitCode = 64;
} else {
  const paths = initializeRuntimePaths(configuredRoot);
  if (!paths.ok) {
    process.stderr.write(
      "Course source refresh failed: invalid runtime root.\n",
    );
    process.exitCode = 1;
  } else {
    const result = await refreshCourseSources(
      paths.value.courseSourceDirectory(),
      {
        signal: AbortSignal.timeout(60_000),
      },
    );
    for (const course of ["IA340", "IA342"] as const) {
      const entry = result.courses[course];
      process.stdout.write(
        `${course}\t${entry.status}${entry.commit ? `\t${entry.commit}` : ""}\n`,
      );
    }
    if (!result.ok) process.exitCode = 1;
  }
}
