import { createHash, randomBytes } from "node:crypto";
import express, { type RequestHandler } from "express";
import {
  canvasPageId,
  canvasPagePlanId,
  readCanvasAssignmentDraft,
  readCanvasAssignmentScope,
  readCanvasPageDraft,
  type CanvasPageDraft,
  type CanvasAssignmentDraft,
  type CanvasAssignmentScope,
  type CanvasAssignmentSubject,
} from "@laita/contracts";
import { createCanvasPageClient } from "@laita/providers";
import { createSecretHandleForProvider } from "@laita/runtime";
import {
  canvasContext,
  canvasFingerprint,
  readProtectedOwnerJson,
  type CanvasConfiguration,
} from "./canvas.ts";
import type { OwnerSessions } from "./owner-session.ts";

interface CanvasPageSettings {
  origin: string;
  courseId: string;
  teacherId: string;
  expiresAt: string;
  canvasToken: string;
  assignments?: CanvasAssignmentScope;
}

export interface CanvasPageOptions {
  settings: () => unknown;
  fetcher?: typeof fetch;
}

export function readCanvasPageSettings(file: string | undefined): unknown {
  return readProtectedOwnerJson(file, 4096);
}

function connection(
  value: unknown,
  canvas: CanvasConfiguration | undefined,
  now: number,
): CanvasPageSettings | undefined {
  if (!canvas || !value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  const permitted = "canvasToken,courseId,expiresAt,origin,teacherId";
  const keys = Object.keys(v).sort().join(",");
  if (
    (keys !== permitted && keys !== `assignments,${permitted}`) ||
    typeof v.origin !== "string" ||
    v.origin !== canvas.canvasOrigin ||
    !canvasPageId(v.courseId) ||
    v.courseId !== canvas.courseId ||
    !canvasPageId(v.teacherId) ||
    v.teacherId !== canvas.userId ||
    typeof v.expiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v.expiresAt) ||
    !Number.isFinite(Date.parse(v.expiresAt)) ||
    new Date(v.expiresAt).toISOString() !== v.expiresAt ||
    Date.parse(v.expiresAt) <= now ||
    typeof v.canvasToken !== "string" ||
    v.canvasToken.length > 512 ||
    !/^[A-Za-z0-9._~+/-]{20,}=*$/u.test(v.canvasToken) ||
    v.canvasToken === canvas.sharedSecret ||
    v.canvasToken === canvas.consumerKey
  )
    return;
  return {
    origin: v.origin,
    courseId: v.courseId,
    teacherId: v.teacherId,
    expiresAt: v.expiresAt,
    canvasToken: v.canvasToken,
    ...(Object.hasOwn(v, "assignments") && {
      assignments: readCanvasAssignmentScope(v.assignments),
    }),
  };
}

type Resource = "page" | "assignment";
type Draft = CanvasPageDraft | CanvasAssignmentDraft;

function readIntent(
  value: unknown,
  action: "preview" | "confirm",
  resource: Resource,
) {
  if (!value || typeof value !== "object") throw new Error("INVALID_DRAFT");
  const { draft, confirm, planId } = value as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  const checked =
    resource === "page"
      ? readCanvasPageDraft(draft)
      : readCanvasAssignmentDraft(draft);
  if (action === "preview" && keys === "draft") return { draft: checked };
  if (
    action !== "confirm" ||
    keys !== "confirm,draft,planId" ||
    confirm !== true ||
    !canvasPagePlanId(planId)
  )
    throw new Error("INVALID_DRAFT");

  // The browser confirms the draft exactly as returned by preview.
  const submitted = draft as Record<string, unknown>;
  if ("body" in checked && submitted.body !== checked.body)
    throw new Error("INVALID_DRAFT");
  if (
    "submissionTypes" in checked &&
    JSON.stringify(submitted.submissionTypes) !==
      JSON.stringify(checked.submissionTypes)
  )
    throw new Error("INVALID_DRAFT");
  return { draft: checked, planId };
}

export function createCanvasPageParser(): RequestHandler {
  const parse = express.json({
    limit: 128 * 1024,
    inflate: false,
    strict: true,
  });
  return (req, res, next) => {
    parse(req, res, (error: unknown) => {
      if (error) res.status(400).json({ code: "INVALID_REQUEST" });
      else next();
    });
  };
}

export function createCanvasAuthoringHandlers(
  sessions: Pick<OwnerSessions, "authorize" | "isCurrent">,
  options: CanvasPageOptions,
  launch: () => CanvasConfiguration | undefined,
  now: () => number,
) {
  // One current preview and one in-flight operation across both authoring tools.
  let saved:
    | {
        resource: Resource;
        planId: string;
        key: string;
        draftKey: string;
        snapshot: string;
        expires: number;
      }
    | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  function clearPreview() {
    clearTimeout(expiry);
    saved = undefined;
  }

  function handler(
    resource: Resource,
    action: "status" | "preview" | "confirm",
  ): RequestHandler {
    return async (req, res) => {
      const actor = sessions.authorize(req, res);
      if (!actor) return;
      if (actor.role !== "teacher" || actor.source !== "canvas") {
        res.status(403).json({ code: "FORBIDDEN" });
        return;
      }
      const unavailable = () =>
        res.status(503).json({ code: "SERVICE_UNAVAILABLE" });
      const stale = () => res.status(409).json({ code: "PREVIEW_REQUIRED" });
      const get = (draft?: Draft) => {
        if (!sessions.isCurrent(req, actor.binding))
          throw new Error("INVALID_CANVAS_TARGET");
        const canvas = launch();
        if (
          !canvas ||
          canvasContext(canvas) !== actor.context ||
          canvasFingerprint(canvas) !== actor.canvasRevision
        )
          throw new Error("INVALID_CANVAS_TARGET");
        const settings = connection(options.settings(), canvas, now());
        if (!settings || (resource === "assignment" && !settings.assignments))
          throw new Error("CANVAS_UNAVAILABLE");
        const { assignments, ...rest } = settings;
        const launchKeys = [canvas.consumerKey, canvas.sharedSecret];
        if (
          draft &&
          launchKeys.some(
            (secret) =>
              draft.title.includes(secret) ||
              ("body" in draft && draft.body.includes(secret)),
          )
        )
          throw new Error("INVALID_DRAFT");
        return {
          settings,
          launchKeys,
          key: createHash("sha256")
            .update(
              JSON.stringify([
                actor.binding,
                actor.canvasRevision,
                rest,
                assignments?.groupId ?? null,
                assignments?.editableIds ?? [],
              ]),
            )
            .digest("hex"),
        };
      };
      let initial: ReturnType<typeof get>;
      try {
        initial = get();
      } catch {
        unavailable();
        return;
      }
      if (action === "status") {
        res.json(
          resource === "page"
            ? { enabled: true }
            : initial.settings.assignments,
        );
        return;
      }
      let intent: ReturnType<typeof readIntent>;
      try {
        if (!req.is("json")) throw new Error("INVALID_DRAFT");
        intent = readIntent(req.body, action, resource);
      } catch {
        res.status(400).json({ code: "INVALID_REQUEST" });
        return;
      }
      const { draft, planId } = intent;
      const { origin, courseId, teacherId, assignments } = initial.settings;
      if (
        "kind" in draft &&
        draft.kind === "TITLE" &&
        !assignments?.editableIds.includes(draft.assignmentId)
      ) {
        res.status(403).json({ code: "FORBIDDEN" });
        return;
      }
      const plan = saved;
      const draftKey = JSON.stringify(draft);
      const key = initial.key;
      function checkPlan() {
        return (
          !!plan &&
          saved === plan &&
          plan.resource === resource &&
          plan.key === key &&
          plan.expires > now() &&
          plan.planId === planId &&
          plan.draftKey === draftKey
        );
      }
      if (action === "confirm" && !checkPlan()) {
        stale();
        return;
      }
      if (busy) {
        res.status(409).json({ code: "BUSY" });
        return;
      }
      busy = true;
      const controller = new AbortController();
      const disconnect = () => controller.abort();
      res.once("close", disconnect);
      let dispatched = false;
      let resourceId: string | undefined;
      const assertCurrent = () => {
        controller.signal.throwIfAborted();
        const details = get(draft);
        if (details.key !== key) throw new Error("INVALID_CANVAS_TARGET");
        return details;
      };
      const sendResult = (
        status: "VERIFIED" | "UNVERIFIED" | "UNCERTAIN",
        id?: string,
      ) => {
        if (!res.destroyed)
          res.json(
            id
              ? {
                  status,
                  [resource === "page" ? "pageId" : "assignmentId"]: id,
                }
              : { status },
          );
      };
      try {
        if (action === "preview") clearPreview();
        const client = createCanvasPageClient(
          {
            origin,
            courseId,
            teacherId,
            refresh: () =>
              createSecretHandleForProvider(
                assertCurrent().settings.canvasToken,
              ),
            ...(options.fetcher ? { fetcher: options.fetcher } : {}),
          },
          controller.signal,
        );
        const current = await client.readTarget(draft);
        let subject: CanvasAssignmentSubject | undefined;
        if ("kind" in draft) {
          if (!assignments) throw new Error("CANVAS_UNAVAILABLE");
          subject = await client.assignments.preview(
            draft,
            assignments.groupId,
          );
        }
        const { launchKeys, settings } = assertCurrent();
        if (
          [...launchKeys, settings.canvasToken].some(
            (secret) =>
              current.courseName.includes(secret) ||
              subject?.name.includes(secret),
          )
        )
          throw new Error("INVALID_CANVAS_TARGET");
        const snapshot = JSON.stringify({ target: current, subject });
        if (action === "preview") {
          const id = randomBytes(32).toString("hex");
          saved = {
            resource,
            planId: id,
            key,
            draftKey,
            snapshot,
            expires: now() + 300_000,
          };
          expiry = setTimeout(clearPreview, 300_000);
          expiry.unref();
          res.json({
            planId: id,
            target: current,
            draft,
            ...(subject && { subject }),
          });
          return;
        }

        if (
          !checkPlan() ||
          plan?.snapshot !== snapshot ||
          (subject?.kind === "TITLE" && subject.name === draft.title)
        ) {
          clearPreview();
          stale();
          return;
        }
        const beforeDispatch = () => {
          assertCurrent();
          if (!checkPlan()) throw new Error("PREVIEW_REQUIRED");
          clearPreview();
          dispatched = true;
        };
        let verified: boolean;
        if ("kind" in draft) {
          if (!subject) throw new Error("INVALID_CANVAS_TARGET");
          resourceId = await client.assignments.write(
            draft,
            subject,
            beforeDispatch,
          );
          verified = await client.assignments.readBack(
            resourceId,
            draft,
            subject,
          );
        } else {
          resourceId = await client.create(draft, beforeDispatch);
          verified = await client.readBack(resourceId, draft);
        }
        assertCurrent();
        sendResult(verified ? "VERIFIED" : "UNVERIFIED", resourceId);
      } catch {
        if (res.destroyed) return;
        if (!dispatched) {
          if (action === "confirm") {
            clearPreview();
            stale();
          } else unavailable();
          return;
        }
        try {
          assertCurrent();
          if (resourceId) {
            sendResult("UNVERIFIED", resourceId);
            return;
          }
        } catch {
          // A changed session or credential cannot receive a resource ID.
        }
        sendResult("UNCERTAIN");
      } finally {
        busy = false;
        res.off("close", disconnect);
      }
    };
  }

  return {
    pages: {
      status: handler("page", "status"),
      preview: handler("page", "preview"),
      create: handler("page", "confirm"),
    },
    assignments: {
      status: handler("assignment", "status"),
      preview: handler("assignment", "preview"),
      save: handler("assignment", "confirm"),
    },
    close: clearPreview,
  };
}
