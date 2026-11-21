import {
  canvasFeedbackSubmittedAt,
  canvasPageId,
  verificationClassSize,
} from "@laita/contracts";
import {
  validGitHubExpectation,
  validMongoExpectation,
  type GitHubExpectation,
  type MongoExpectation,
} from "@laita/providers";

type GitHubAssignment = {
  provider: "GITHUB";
  assignmentId: string;
  students: GitHubExpectation[];
};
type MongoAssignment = {
  provider: "MONGODB";
  assignmentId: string;
  students: MongoExpectation[];
};
export type VerifierAssignment = GitHubAssignment | MongoAssignment;
interface Target {
  origin: string;
  courseId: string;
  teacherId: string;
}

function exact(value: unknown, keys: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys
  )
    throw new Error("INVALID_SCOPE");
  return value as Record<string, unknown>;
}

export function readVerifierSettings(
  value: unknown,
  target: Target,
  now: number,
  deniedTokens: string[],
) {
  const v = exact(value, "assignments,courseId,github,origin,teacherId");
  if (
    v.origin !== target.origin ||
    v.courseId !== target.courseId ||
    v.teacherId !== target.teacherId ||
    !Array.isArray(v.assignments) ||
    v.assignments.length < 1 ||
    v.assignments.length > 4
  )
    throw new Error("INVALID_SCOPE");
  const github = v.github === null ? null : exact(v.github, "expiresAt,token");
  const githubToken = github?.token;
  if (
    github &&
    (!canvasFeedbackSubmittedAt(github.expiresAt) ||
      Date.parse(github.expiresAt) <= now ||
      typeof githubToken !== "string" ||
      !/^[A-Za-z0-9_]{20,512}$/u.test(githubToken) ||
      deniedTokens.includes(githubToken))
  )
    throw new Error("INVALID_SCOPE");

  const bound = {
    canvasOrigin: target.origin,
    courseId: target.courseId,
    teacherId: target.teacherId,
  };
  const assignments: VerifierAssignment[] = [];
  for (const entry of v.assignments as unknown[]) {
    const provider = (entry as { provider?: unknown } | null)?.provider;
    if (provider !== "GITHUB" && provider !== "MONGODB")
      throw new Error("INVALID_SCOPE");
    const a = exact(
      entry,
      provider === "GITHUB"
        ? "assignmentId,paths,provider,readerGitHubId,ref,students"
        : "assignmentId,collections,provider,students",
    );
    if (
      !canvasPageId(a.assignmentId) ||
      !Array.isArray(a.students) ||
      a.students.length < 1 ||
      a.students.length > verificationClassSize ||
      assignments.some(
        (x) => x.provider === provider && x.assignmentId === a.assignmentId,
      )
    )
      throw new Error("INVALID_SCOPE");
    const assignmentId = a.assignmentId;
    const students = a.students as unknown[];
    if (provider === "GITHUB") {
      if (typeof githubToken !== "string") throw new Error("INVALID_SCOPE");
      const expectations = students.map((entry) => {
        const student = exact(
          entry,
          "githubId,githubLogin,id,pullRequest,repository,repositoryId",
        );
        const expectation = {
          ...bound,
          assignmentId,
          studentId: student.id,
          studentGitHubId: student.githubId,
          studentGitHubLogin: student.githubLogin,
          repository: student.repository,
          repositoryId: student.repositoryId,
          pullRequest: student.pullRequest,
          ref: a.ref,
          paths: a.paths,
          readerGitHubId: a.readerGitHubId,
        } as GitHubExpectation;
        if (!validGitHubExpectation(expectation))
          throw new Error("INVALID_SCOPE");
        return expectation;
      });
      if (
        new Set(expectations.map((x) => x.studentId)).size !==
          expectations.length ||
        new Set(expectations.map((x) => x.studentGitHubId)).size !==
          expectations.length ||
        new Set(expectations.map((x) => x.repositoryId)).size !==
          expectations.length
      )
        throw new Error("INVALID_SCOPE");
      assignments.push({ provider, assignmentId, students: expectations });
    } else {
      const expectations = students.map((entry) => {
        const student = exact(entry, "database,host,id");
        const expectation = {
          ...bound,
          assignmentId,
          studentId: student.id,
          host: student.host,
          database: student.database,
          collections: a.collections,
        } as MongoExpectation;
        if (!validMongoExpectation(expectation))
          throw new Error("INVALID_SCOPE");
        return expectation;
      });
      if (
        new Set(expectations.map((x) => x.studentId)).size !==
          expectations.length ||
        new Set(expectations.map((x) => x.host + "/" + x.database)).size !==
          expectations.length
      )
        throw new Error("INVALID_SCOPE");
      assignments.push({ provider, assignmentId, students: expectations });
    }
  }
  return {
    assignments,
    githubToken: typeof githubToken === "string" ? githubToken : undefined,
    githubExpiresAt: github?.expiresAt,
  };
}
