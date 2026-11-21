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
  submissionLinkText,
  verifyGitHub,
} from "@laita/providers";
import { createSecretHandleForProvider } from "@laita/runtime";
import {
  readVerifierSettings,
  type VerifierAssignment,
} from "./canvas-verifier-settings.ts";

export interface CanvasVerificationOptions {
  settings: () => unknown;
  githubFetcher?: typeof fetch;
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
    let failure: "SOURCE_UNAVAILABLE" | "PROVIDER_UNAVAILABLE" =
      "SOURCE_UNAVAILABLE";
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
              return {
                status: "RESOLVED",
                secret: createSecretHandleForProvider(value),
              } as const;
            },
          },
        };
      };
      failure = "PROVIDER_UNAVAILABLE";
      const evidence = await verifyGitHub(get, signal, options?.githubFetcher);
      const observation = {
        state: evidence.status,
        checks: [
          ...evidence.files.map((entry) => entry.status),
          evidence.pullRequest.status,
        ],
      };
      await client.readTarget();
      const latest = await client.verificationSource(assignmentId, studentId);
      if (!latest || before.digest !== latest.digest) {
        send({ state: "UNKNOWN", reason: "ATTEMPT_CHANGED" });
        return;
      }
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
        reason: signal.aborted ? "PROVIDER_UNAVAILABLE" : failure,
      });
    } finally {
      res.off("close", disconnect);
      leave();
    }
  };
}
