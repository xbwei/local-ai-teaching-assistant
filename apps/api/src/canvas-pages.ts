import { createHash, randomBytes } from "node:crypto";
import express, {
  type Request,
  type Response,
  type RequestHandler,
} from "express";
import {
  canvasPageId,
  canvasPagePlanId,
  canvasPageTitle,
  readCanvasAssignmentDraft,
  readCanvasAssignmentScope,
  readCanvasFeedbackDraft,
  readCanvasModuleDraft,
  readCanvasModuleScope,
  readCanvasPageDraft,
  readCanvasTestStudentScope,
  type CanvasPageDraft,
  type CanvasAssignmentDraft,
  type CanvasAssignmentScope,
  type CanvasAssignmentSubject,
  type CanvasFeedbackDraft,
  type CanvasTestStudentScope,
  type CanvasModuleDraft,
  type CanvasModuleScope,
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
import {
  createCanvasVerificationHandler,
  type CanvasVerificationOptions,
} from "./canvas-verification.ts";

interface CanvasPageSettings {
  origin: string;
  courseId: string;
  teacherId: string;
  expiresAt: string;
  canvasToken: string;
  assignments?: CanvasAssignmentScope;
  modules?: CanvasModuleScope;
  chat?: CanvasTestStudentScope;
  feedback?: CanvasTestStudentScope;
}

export interface CanvasPageOptions {
  settings: () => unknown;
  fetcher?: typeof fetch;
  verification?: CanvasVerificationOptions;
}

export function readCanvasPageSettings(file: string | undefined): unknown {
  return readProtectedOwnerJson(file, 4096);
}

export function readCanvasVerificationSettings(
  file: string | undefined,
): unknown {
  return readProtectedOwnerJson(file, 64 * 1024);
}

function connection(
  value: unknown,
  canvas: CanvasConfiguration | undefined,
  now: number,
): CanvasPageSettings | undefined {
  if (!canvas || !value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  const permitted = "canvasToken,courseId,expiresAt,origin,teacherId";
  const keys = Object.keys(v)
    .filter(
      (key) => !["assignments", "modules", "chat", "feedback"].includes(key),
    )
    .sort()
    .join(",");
  if (
    keys !== permitted ||
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
  const chat = Object.hasOwn(v, "chat")
    ? readCanvasTestStudentScope(v.chat)
    : undefined;
  const feedback = Object.hasOwn(v, "feedback")
    ? readCanvasTestStudentScope(v.feedback)
    : undefined;
  if (
    chat?.testStudentId === v.teacherId ||
    feedback?.testStudentId === v.teacherId ||
    (chat && feedback && chat.testStudentId !== feedback.testStudentId)
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
    ...(Object.hasOwn(v, "modules") && {
      modules: readCanvasModuleScope(v.modules),
    }),
    ...(chat && { chat }),
    ...(feedback && { feedback }),
  };
}

type Resource = "page" | "assignment" | "module" | "feedback";
type Draft =
  | (CanvasPageDraft & { kind?: never })
  | CanvasAssignmentDraft
  | CanvasModuleDraft
  | CanvasFeedbackDraft;

function readIntent(
  value: unknown,
  action: "preview" | "confirm",
  resource: Resource,
): { draft: Draft; planId?: string } {
  if (!value || typeof value !== "object") throw new Error("INVALID_DRAFT");
  const { draft, confirm, planId } = value as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  const parse = {
    page: readCanvasPageDraft,
    assignment: readCanvasAssignmentDraft,
    module: readCanvasModuleDraft,
    feedback: readCanvasFeedbackDraft,
  };
  const checked = parse[resource](draft);
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

export function createCanvasPageParser(limit = 128 * 1024): RequestHandler {
  const parse = express.json({
    limit,
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
  // Share the current preview and single in-flight operation across authoring tools.
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

  function authorizeTeacher(req: Request, res: Response) {
    const actor = sessions.authorize(req, res);
    if (!actor) return;
    if (actor.role !== "teacher" || actor.source !== "canvas") {
      res.status(403).json({ code: "FORBIDDEN" });
      return;
    }
    return actor;
  }

  function currentAccess(
    req: Request,
    actor: NonNullable<ReturnType<typeof authorizeTeacher>>,
    resource: Resource | "chat" | "verification",
    draft?: Draft,
  ) {
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
    if (
      !settings ||
      (resource === "assignment" && !settings.assignments) ||
      (resource === "module" && !settings.modules) ||
      (resource === "chat" && !settings.chat) ||
      (resource === "feedback" && !settings.feedback)
    )
      throw new Error("CANVAS_UNAVAILABLE");
    const { assignments, modules, chat, feedback, ...rest } = settings;
    const launchKeys = [canvas.consumerKey, canvas.sharedSecret];
    if (
      (draft &&
        launchKeys.some(
          (secret) =>
            ("title" in draft && draft.title.includes(secret)) ||
            ("body" in draft && draft.body.includes(secret)),
        )) ||
      (draft?.kind === "FEEDBACK" &&
        [...launchKeys, rest.canvasToken].some((secret) =>
          draft.text.includes(secret),
        ))
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
            modules?.moduleIds ?? null,
            modules?.pageIds ?? null,
            modules?.assignmentIds ?? null,
            chat?.testStudentId ?? null,
            chat?.assignmentIds ?? null,
            feedback ?? null,
          ]),
        )
        .digest("hex"),
    };
  }

  function handler(
    resource: Resource,
    action: "status" | "preview" | "confirm",
  ): RequestHandler {
    return async (req, res) => {
      if (resource === "feedback") res.setHeader("Cache-Control", "no-store");
      const actor = authorizeTeacher(req, res);
      if (!actor) return;
      const unavailable = () =>
        res.status(503).json({ code: "SERVICE_UNAVAILABLE" });
      const stale = () => res.status(409).json({ code: "PREVIEW_REQUIRED" });
      const get = (draft?: Draft) => currentAccess(req, actor, resource, draft);
      let initial: ReturnType<typeof get>;
      try {
        initial = get();
      } catch {
        unavailable();
        return;
      }
      if (action === "status") {
        res.json(
          {
            page: { enabled: true },
            assignment: initial.settings.assignments,
            module: initial.settings.modules,
            feedback: initial.settings.feedback,
          }[resource],
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
      const { origin, courseId, teacherId, assignments, modules, feedback } =
        initial.settings;
      if (
        (draft.kind === "TITLE" &&
          !assignments?.editableIds.includes(draft.assignmentId)) ||
        (draft.kind === "FEEDBACK" &&
          !feedback?.assignmentIds.includes(draft.assignmentId))
      ) {
        res.status(403).json({ code: "FORBIDDEN" });
        return;
      }
      if (
        "moduleId" in draft &&
        (!modules?.moduleIds.includes(draft.moduleId) ||
          !(
            draft.kind === "LINK_PAGE" ? modules.pageIds : modules.assignmentIds
          ).includes(draft.contentId))
      ) {
        res.status(403).json({ code: "FORBIDDEN" });
        return;
      }
      const plan = saved;
      const draftKey = createHash("sha256")
        .update(JSON.stringify(draft))
        .digest("hex");
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
                  [{
                    page: "pageId",
                    assignment: "assignmentId",
                    module: "resourceId",
                    feedback: "commentId",
                  }[resource]]: id,
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
        const current = await client.readTarget(
          "title" in draft ? draft : undefined,
        );
        const link =
          "moduleId" in draft ? await client.modules.preview(draft) : undefined;
        const sample =
          draft.kind === "FEEDBACK" && feedback
            ? await client.feedback.preview(
                draft.assignmentId,
                feedback.testStudentId,
              )
            : undefined;
        let subject: CanvasAssignmentSubject | undefined;
        if (draft.kind === "CREATE" || draft.kind === "TITLE") {
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
              subject?.name.includes(secret) ||
              sample?.subject.assignmentName.includes(secret) ||
              link?.subject.moduleName.includes(secret) ||
              link?.resource.name.includes(secret) ||
              link?.resource.reference.includes(secret),
          )
        )
          throw new Error("INVALID_CANVAS_TARGET");
        const snapshot = JSON.stringify({
          target: current,
          subject,
          link,
          sample,
        });
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
            ...(link && { moduleSubject: link.subject }),
            ...(sample && { feedbackSubject: sample.subject }),
          });
          return;
        }

        if (
          !checkPlan() ||
          plan?.snapshot !== snapshot ||
          (subject?.kind === "TITLE" &&
            "title" in draft &&
            subject.name === draft.title)
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
        if (draft.kind === undefined) {
          resourceId = await client.create(draft, beforeDispatch);
          verified = await client.readBack(resourceId, draft);
        } else if (draft.kind === "CREATE" || draft.kind === "TITLE") {
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
        } else if (draft.kind === "FEEDBACK") {
          if (!sample) throw new Error("INVALID_CANVAS_TARGET");
          resourceId = await client.feedback.post(
            draft,
            sample.subject,
            sample.commentIds,
            beforeDispatch,
          );
          verified = await client.feedback.readBack(
            resourceId,
            draft,
            sample.subject,
            sample.digest,
          );
        } else {
          resourceId = await client.modules.write(draft, link, beforeDispatch);
          verified = await client.modules.readBack(resourceId, draft, link);
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

  const chatHandler: RequestHandler = async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const actor = authorizeTeacher(req, res);
    if (!actor) return;
    const unavailable = () =>
      res.status(503).json({ code: "CANVAS_CHAT_UNAVAILABLE" });
    const get = () => currentAccess(req, actor, "chat");
    let initial: ReturnType<typeof get>;
    try {
      initial = get();
    } catch {
      unavailable();
      return;
    }
    if (Object.keys(req.query).length) {
      res.status(400).json({ code: "INVALID_REQUEST" });
      return;
    }
    if (req.method === "GET") {
      res.json({ enabled: true });
      return;
    }
    const { body } = req;
    if (
      !req.is("json") ||
      !body ||
      Object.keys(body).join(",") !== "question" ||
      typeof body.question !== "string" ||
      body.question.length > 280 ||
      Buffer.byteLength(body.question) > 1024
    ) {
      res.status(400).json({ code: "INVALID_REQUEST" });
      return;
    }
    const query =
      /^(how many submissions|what is the score) for (.{1,250}?)\??$/iu.exec(
        body.question.trim(),
      );
    if (!query || !canvasPageTitle(query[2])) {
      res.json({
        text: "Ask how many submissions or what score the configured Test Student has for one approved assignment. Use its full title.",
      });
      return;
    }
    const { origin, courseId, teacherId, chat } = initial.settings;
    if (!chat) {
      unavailable();
      return;
    }
    if (busy) {
      res.status(409).json({ code: "BUSY" });
      return;
    }
    const kind =
      query[1]!.toLowerCase() === "how many submissions" ? "count" : "score";
    busy = true;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15_000),
    ]);
    const disconnect = () => controller.abort();
    res.once("close", disconnect);
    const assertCurrent = () => {
      signal.throwIfAborted();
      const value = get();
      if (value.key !== initial.key) throw new Error("INVALID_CANVAS_TARGET");
      return value;
    };
    try {
      const client = createCanvasPageClient(
        {
          origin,
          courseId,
          teacherId,
          refresh: () =>
            createSecretHandleForProvider(assertCurrent().settings.canvasToken),
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        },
        signal,
      );
      await client.readTarget();
      const observation = await client.chat({ title: query[2], kind }, chat);
      const { launchKeys, settings } = assertCurrent();
      if (
        observation &&
        [...launchKeys, settings.canvasToken].some((secret) =>
          observation.name.includes(secret),
        )
      )
        throw new Error("INVALID_CANVAS_TARGET");
      res.json({ text: canvasChatText(observation, kind) });
    } catch {
      if (!res.destroyed) unavailable();
    } finally {
      busy = false;
      res.off("close", disconnect);
    }
  };

  const verification = createCanvasVerificationHandler(
    options.verification,
    (req, res) => {
      const actor = authorizeTeacher(req, res);
      if (!actor) return;
      return () => {
        const { settings, key, launchKeys } = currentAccess(
          req,
          actor,
          "verification",
        );
        return {
          origin: settings.origin,
          courseId: settings.courseId,
          teacherId: settings.teacherId,
          canvasToken: settings.canvasToken,
          binding: key,
          launchKeys,
        };
      };
    },
    () => {
      if (busy) return;
      busy = true;
      return () => {
        busy = false;
      };
    },
    now,
    options.fetcher,
  );

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
    modules: {
      status: handler("module", "status"),
      preview: handler("module", "preview"),
      save: handler("module", "confirm"),
    },
    feedback: {
      status: handler("feedback", "status"),
      preview: handler("feedback", "preview"),
      post: handler("feedback", "confirm"),
    },
    chat: chatHandler,
    verification,
    close: clearPreview,
  };
}

function canvasChatText(
  result: Awaited<
    ReturnType<ReturnType<typeof createCanvasPageClient>["chat"]>
  >,
  kind: "count" | "score",
) {
  const sample = "Canvas checked only the configured Test Student.";
  if (!result)
    return "I couldn’t identify one approved assignment. Use its full title. Canvas Chat covers only one configured Test Student.";
  const { name, state } = result;
  if (state === "EXCUSED")
    return `The Test Student is excused for ${name}. ${sample}`;
  const missing = result.missing
    ? " Canvas marks this assignment missing."
    : "";
  if (kind === "count")
    return `${state === "SUBMITTED" ? "1 submission" : "0 submissions"} for ${name}. ${sample}${missing}`;
  if (state === "SUBMITTED") {
    if ("score" in result)
      return `Score for ${name} is ${result.score}${result.pointsPossible === undefined ? "" : ` of ${result.pointsPossible}`} points. ${sample}`;
    if ("ungraded" in result)
      return `The submission for ${name} is ungraded. ${sample}`;
  }
  return `Score unavailable for ${name}. ${sample}${missing}`;
}
