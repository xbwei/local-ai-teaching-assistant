import { createHash, randomBytes } from "node:crypto";
import express, { type RequestHandler } from "express";
import {
  canvasPageId,
  canvasPagePlanId,
  readCanvasPageDraft,
  sameCanvasPageDraft,
  type CanvasPageDraft,
  type CanvasPagePreview,
  type CanvasPageResult,
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
  if (
    Object.keys(v).sort().join(",") !==
      "canvasToken,courseId,expiresAt,origin,teacherId" ||
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
  };
}

type PageIntent =
  | { action: "preview"; draft: CanvasPageDraft }
  | { action: "create"; draft: CanvasPageDraft; planId: string };

function readIntent(value: unknown, action: PageIntent["action"]): PageIntent {
  if (!value || typeof value !== "object") throw new Error("INVALID_DRAFT");
  const { draft, confirm, planId } = value as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  const checked = readCanvasPageDraft(draft);
  if (action === "preview" && keys === "draft")
    return { action, draft: checked };
  if (
    action === "create" &&
    keys === "confirm,draft,planId" &&
    confirm === true &&
    canvasPagePlanId(planId) &&
    (draft as CanvasPageDraft).body === checked.body
  )
    return { action, draft: checked, planId };
  throw new Error("INVALID_DRAFT");
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

export function createCanvasPageHandlers(
  sessions: Pick<OwnerSessions, "authorize" | "isCurrent">,
  options: CanvasPageOptions,
  launch: () => CanvasConfiguration | undefined,
  now: () => number,
) {
  // One current preview for the single operator. A new preview supersedes it.
  let saved:
    { preview: CanvasPagePreview; key: string; expires: number } | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  function clearPreview() {
    clearTimeout(expiry);
    saved = undefined;
  }

  function handler(action: "status" | PageIntent["action"]): RequestHandler {
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
      const get = (draft?: CanvasPageDraft) => {
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
        if (!settings) throw new Error("CANVAS_UNAVAILABLE");
        const launchKeys = [canvas.consumerKey, canvas.sharedSecret];
        if (
          draft &&
          launchKeys.some(
            (secret) =>
              draft.title.includes(secret) || draft.body.includes(secret),
          )
        )
          throw new Error("INVALID_DRAFT");
        return {
          settings,
          launchKeys,
          key: createHash("sha256")
            .update(
              JSON.stringify([actor.binding, actor.canvasRevision, settings]),
            )
            .digest("hex"),
        };
      };
      let key: string;
      let target: Pick<CanvasPageSettings, "origin" | "courseId" | "teacherId">;
      try {
        const { settings, key: revision } = get();
        key = revision;
        target = {
          origin: settings.origin,
          courseId: settings.courseId,
          teacherId: settings.teacherId,
        };
      } catch {
        unavailable();
        return;
      }
      if (action === "status") {
        res.json({ enabled: true });
        return;
      }
      let intent: PageIntent;
      try {
        if (!req.is("json")) throw new Error("INVALID_DRAFT");
        intent = readIntent(req.body, action);
      } catch {
        res.status(400).json({ code: "INVALID_REQUEST" });
        return;
      }
      const plan = saved;
      function checkPlan(planId: string, draft: CanvasPageDraft) {
        return (
          !!plan &&
          saved === plan &&
          plan.key === key &&
          plan.expires > now() &&
          plan.preview.planId === planId &&
          sameCanvasPageDraft(plan.preview.draft, draft)
        );
      }
      if (
        intent.action === "create" &&
        !checkPlan(intent.planId, intent.draft)
      ) {
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
      let pageId: string | undefined;
      const assertCurrent = () => {
        controller.signal.throwIfAborted();
        const details = get(intent.draft);
        if (details.key !== key) throw new Error("INVALID_CANVAS_TARGET");
        return details;
      };
      const sendResult = (result: CanvasPageResult) => {
        if (!res.destroyed) res.json(result);
      };
      try {
        if (intent.action === "preview") clearPreview();
        const client = createCanvasPageClient(
          {
            ...target,
            refresh: () =>
              createSecretHandleForProvider(
                assertCurrent().settings.canvasToken,
              ),
            ...(options.fetcher ? { fetcher: options.fetcher } : {}),
          },
          controller.signal,
        );
        const current = await client.readTarget(intent.draft);
        if (
          assertCurrent().launchKeys.some((secret) =>
            current.courseName.includes(secret),
          )
        )
          throw new Error("INVALID_CANVAS_TARGET");
        if (intent.action === "preview") {
          const preview: CanvasPagePreview = {
            planId: randomBytes(32).toString("hex"),
            target: current,
            draft: intent.draft,
          };
          saved = { preview, key, expires: now() + 300_000 };
          expiry = setTimeout(clearPreview, 300_000);
          expiry.unref();
          res.json(preview);
          return;
        }
        const { planId, draft } = intent;
        if (
          !checkPlan(planId, draft) ||
          plan?.preview.target.courseName !== current.courseName
        ) {
          clearPreview();
          stale();
          return;
        }
        pageId = await client.create(draft, () => {
          assertCurrent();
          if (!checkPlan(planId, draft)) throw new Error("PREVIEW_REQUIRED");
          clearPreview();
          dispatched = true;
        });
        const verified = await client.readBack(pageId, draft);
        assertCurrent();
        sendResult({ status: verified ? "VERIFIED" : "UNVERIFIED", pageId });
      } catch {
        if (res.destroyed) return;
        if (!dispatched) {
          if (intent.action === "create") {
            clearPreview();
            stale();
          } else unavailable();
          return;
        }
        try {
          assertCurrent();
          if (pageId) {
            sendResult({ status: "UNVERIFIED", pageId });
            return;
          }
        } catch {
          // A changed session or credential cannot receive a resource ID.
        }
        sendResult({ status: "UNCERTAIN" });
      } finally {
        busy = false;
        res.off("close", disconnect);
      }
    };
  }

  return {
    status: handler("status"),
    preview: handler("preview"),
    create: handler("create"),
    close: clearPreview,
  };
}
