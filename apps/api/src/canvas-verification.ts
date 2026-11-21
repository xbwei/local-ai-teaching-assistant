import { createHmac, randomBytes } from "node:crypto";
import type { Request, Response, RequestHandler } from "express";
import {
  canvasPageId,
  canvasPagePlanId,
  isAssignmentVerifier,
  readAssignmentVerificationResult,
  type AssignmentVerificationResult,
} from "@laita/contracts";
import {
  createCanvasPageClient,
  mongoSubmission,
  submissionLinkText,
  verifyGitHub,
  verifyMongoDB,
} from "@laita/providers";
import { createSecretHandleForProvider } from "@laita/runtime";
import {
  readVerifierSettings,
  type VerifierAssignment,
} from "./canvas-verifier-settings.ts";

export interface CanvasVerificationOptions {
  settings: () => unknown;
  githubFetcher?: typeof fetch;
  mongoDependencies?: Parameters<typeof verifyMongoDB>[2];
}
interface Access {
  origin: string;
  courseId: string;
  teacherId: string;
  canvasToken: string;
  binding: string;
  launchKeys: string[];
}

export function createCanvasVerificationHandler(
  options: CanvasVerificationOptions | undefined,
  authorize: (req: Request, res: Response) => (() => Access) | undefined,
  enter: () => (() => void) | undefined,
  now: () => number,
  canvasFetcher?: typeof fetch,
): RequestHandler {
  const scopeKey = randomBytes(32);
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const access = authorize(req, res);
    if (!access) return;

    function load() {
      if (!options || !access) throw new Error("UNAVAILABLE");
      const target = access();
      const configuration = readVerifierSettings(
        options.settings(),
        target,
        now(),
        [target.canvasToken, ...target.launchKeys],
      );
      const scope = createHmac("sha256", scopeKey)
        .update(JSON.stringify([target.binding, configuration]))
        .digest("hex");
      return { target, configuration, scope };
    }
    let initial: ReturnType<typeof load>;
    try {
      initial = load();
    } catch {
      res.status(503).json({ code: "SERVICE_UNAVAILABLE" });
      return;
    }
    let selection:
      | {
          assignment: VerifierAssignment;
          assignmentId: string;
          studentId: string;
        }
      | undefined;
    if (req.method !== "GET") {
      if (
        !req.is("json") ||
        !req.body ||
        typeof req.body !== "object" ||
        Object.keys(req.body).sort().join(",") !==
          "assignmentId,provider,scope,studentId"
      ) {
        res.status(400).json({ code: "INVALID_REQUEST" });
        return;
      }
      const { assignmentId, provider, scope, studentId } = req.body as Record<
        string,
        unknown
      >;
      if (
        !canvasPageId(assignmentId) ||
        !canvasPageId(studentId) ||
        !isAssignmentVerifier(provider) ||
        !canvasPagePlanId(scope)
      ) {
        res.status(400).json({ code: "INVALID_REQUEST" });
        return;
      }
      if (scope !== initial.scope) {
        res.status(409).json({ code: "SCOPE_CHANGED" });
        return;
      }
      const assignment = initial.configuration.assignments.find(
        (entry) =>
          entry.assignmentId === assignmentId && entry.provider === provider,
      );
      if (
        !assignment ||
        !assignment.students.some((student) => student.studentId === studentId)
      ) {
        res.status(403).json({ code: "FORBIDDEN" });
        return;
      }
      selection = { assignment, assignmentId, studentId };
    }
    const leave = enter();
    if (!leave) {
      res.status(409).json({ code: "BUSY" });
      return;
    }

    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(40_000),
    ]);
    const disconnect = () => controller.abort();
    res.once("close", disconnect);
    function current() {
      const fresh = load();
      if (fresh.scope !== initial.scope) throw new Error("SCOPE_CHANGED");
      return fresh;
    }
    function createClient(operation: AbortSignal) {
      return createCanvasPageClient(
        {
          origin: initial.target.origin,
          courseId: initial.target.courseId,
          teacherId: initial.target.teacherId,
          refresh: () => {
            operation.throwIfAborted();
            return createSecretHandleForProvider(current().target.canvasToken);
          },
          ...(canvasFetcher && { fetcher: canvasFetcher }),
        },
        operation,
      );
    }
    function send(value: AssignmentVerificationResult) {
      if (res.destroyed) return;
      try {
        current();
      } catch {
        res.status(409).json({ code: "SCOPE_CHANGED" });
        return;
      }
      res.json(readAssignmentVerificationResult(value));
    }
    const failure: {
      reason: Extract<
        AssignmentVerificationResult,
        { state: "UNKNOWN" }
      >["reason"];
    } = { reason: "SOURCE_UNAVAILABLE" };
    try {
      const client = createClient(signal);
      await client.readTarget();
      if (!selection) {
        current();
        if (!res.destroyed)
          res.json({
            scope: initial.scope,
            assignments: initial.configuration.assignments.map(
              ({ assignmentId, provider, students }) => ({
                assignmentId,
                provider,
                studentIds: students.map((student) => student.studentId),
              }),
            ),
          });
        return;
      }
      const { assignment, assignmentId, studentId } = selection;
      const before = await client.verificationSource(assignmentId, studentId);
      if (!before) {
        send({ state: "UNKNOWN", reason: "NOT_SUBMITTED" });
        return;
      }
      const recheck = async (operation: AbortSignal) => {
        const observer = createClient(operation);
        const latest = await observer.verificationSource(
          assignmentId,
          studentId,
        );
        if (!latest || before.digest !== latest.digest) {
          failure.reason = "ATTEMPT_CHANGED";
          throw new Error("ATTEMPT_CHANGED");
        }
        current();
        return latest;
      };
      let observation: Pick<
        Extract<AssignmentVerificationResult, { checks: unknown }>,
        "state" | "checks"
      >;
      if (assignment.provider === "GITHUB") {
        const expectation = assignment.students.find(
          (e) => e.studentId === studentId,
        )!;
        const { text, href } = submissionLinkText(before.source);
        const urls = [
          expectation.repository,
          expectation.studentGitHubLogin,
        ].flatMap((path) => [
          `https://github.com/${path}`,
          `https://github.com/${path}/`,
        ]);
        if (
          !urls.includes(text.trim()) ||
          (href !== undefined && href !== text.trim())
        )
          throw new Error("SOURCE_UNAVAILABLE");
        const tokenReference = {
          kind: "opaque",
          id: "canvas-verifier",
        } as const;
        const get = () => {
          signal.throwIfAborted();
          current();
          return {
            expectation,
            revision: initial.scope,
            tokenReference,
            secretProvider: {
              async resolve() {
                const value = current().configuration.githubToken;
                if (!value)
                  return {
                    status: "UNAVAILABLE",
                    code: "SECRET_MISSING",
                  } as const;
                return {
                  status: "RESOLVED",
                  secret: createSecretHandleForProvider(value),
                } as const;
              },
            },
          };
        };
        failure.reason = "PROVIDER_UNAVAILABLE";
        const evidence = await verifyGitHub(
          get,
          signal,
          options?.githubFetcher,
        );
        observation = {
          state: evidence.status === "PARTIAL" ? "PARTIAL" : "OBSERVED",
          checks: [
            ...evidence.files.map((entry) => entry.status),
            evidence.pullRequest.status,
          ],
        };
      } else {
        const expectation = assignment.students.find(
          (e) => e.studentId === studentId,
        )!;
        const evidence = await verifyMongoDB(
          () => {
            current();
            return {
              expectation,
              revision: initial.scope,
              async source(operation: AbortSignal) {
                const latest = await recheck(operation);
                const source = mongoSubmission(latest.source, expectation);
                const { username, password } = JSON.parse(
                  source.credential,
                ) as { username: string; password: string };
                const { target, configuration } = current();
                if (
                  [
                    ...target.launchKeys,
                    target.canvasToken,
                    configuration.githubToken,
                  ].some(
                    (secret) =>
                      secret &&
                      (username.includes(secret) || password.includes(secret)),
                  )
                )
                  throw new Error("SOURCE_UNAVAILABLE");
                failure.reason = "PROVIDER_UNAVAILABLE";
                return source;
              },
            };
          },
          signal,
          options?.mongoDependencies,
        );
        if (
          evidence.cleanup !== "COMPLETE" ||
          evidence.connection.status !== "PRESENT"
        )
          throw new Error("PROVIDER_UNAVAILABLE");
        const checks = evidence.collections.flatMap((entry) => [
          entry.status,
          ...entry.fields.map((field) => field.status),
        ]);
        observation = {
          state:
            evidence.collections.some(
              (entry) =>
                entry.countMode === "CAPPED" ||
                entry.fields.some((field) => field.mode === "SAMPLED"),
            ) ||
            checks.some((step) =>
              [
                "PARTIAL",
                "DENIED",
                "UNAVAILABLE",
                "UNSUPPORTED",
                "UNCHECKED",
              ].includes(step),
            )
              ? "PARTIAL"
              : "OBSERVED",
          checks,
        };
      }
      failure.reason = "PROVIDER_UNAVAILABLE";
      await client.readTarget();
      await recheck(signal);
      signal.throwIfAborted();
      send({
        ...observation,
        attempt: before.attempt,
        submittedAt: before.submittedAt,
      });
    } catch {
      if (!selection) {
        if (!res.destroyed)
          res.status(503).json({ code: "SERVICE_UNAVAILABLE" });
        return;
      }
      // Errors, provider bodies, and authorization inputs never become response text.
      send({
        state: "UNKNOWN",
        reason:
          signal.aborted && failure.reason !== "ATTEMPT_CHANGED"
            ? "PROVIDER_UNAVAILABLE"
            : failure.reason,
      });
    } finally {
      res.off("close", disconnect);
      leave();
    }
  };
}
