import { createHash, randomBytes } from "node:crypto";
import express, {
  type Request,
  type Response,
  type RequestHandler,
} from "express";
import {
  canvasInventoryKinds,
  canvasPageId,
  canvasPagePlanId,
  canvasPageTitle,
  isCanvasInventoryKind,
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
  type CanvasInventory,
  type CanvasInventoryKind,
  type CanvasTestStudentScope,
  type CanvasModuleDraft,
  type CanvasModuleScope,
  type CanvasModuleStep,
} from "@laita/contracts";
import { createCanvasPageClient } from "@laita/providers";
import { createSecretHandleForProvider } from "@laita/runtime";
import { selectCanvasChatCall } from "./canvas-chat-tools.ts";
import {
  canvasContext,
  canvasFingerprint,
  readProtectedOwnerJson,
  type CanvasConfiguration,
} from "./canvas.ts";
import type { OwnerSessions } from "./owner-session.ts";
import {
  createCanvasVerificationHandlers,
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
  selectChatTool?: (question: string, signal: AbortSignal) => Promise<unknown>;
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
    resource: Resource | "chat" | "inventory" | "verification",
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
            modules?.organizeSavedResources ?? false,
            chat?.testStudentId ?? null,
            chat?.assignmentIds ?? null,
            feedback ?? null,
          ]),
        )
        .digest("hex"),
    };
  }

  async function describeAssignmentGroups(
    res: Response,
    initial: ReturnType<typeof currentAccess>,
    get: () => ReturnType<typeof currentAccess>,
    catalog: boolean,
  ) {
    if (busy) {
      res.status(409).json({ code: "BUSY" });
      return;
    }
    busy = true;
    if (
      catalog &&
      saved?.resource === "assignment" &&
      saved.key === initial.key
    )
      clearPreview();
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(catalog ? 15_000 : 5000),
    ]);
    const disconnect = () => controller.abort();
    res.once("close", disconnect);
    const assertCurrent = () => {
      signal.throwIfAborted();
      const current = get();
      if (current.key !== initial.key) throw new Error("INVALID_CANVAS_TARGET");
      return current;
    };
    try {
      const { origin, courseId, teacherId, assignments } = initial.settings;
      if (!assignments) throw new Error("CANVAS_UNAVAILABLE");
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
      const groupId = assignments.groupId;
      if (!catalog && !groupId) throw new Error("CANVAS_UNAVAILABLE");
      const groups = catalog
        ? await client.assignments.groups()
        : [await client.assignments.describeGroup(groupId!)];
      if (catalog) await client.readTarget();
      const { settings, launchKeys } = assertCurrent();
      if (
        [...launchKeys, settings.canvasToken].some((secret) =>
          groups.some(({ name }) => name.includes(secret)),
        )
      )
        throw new Error("INVALID_CANVAS_TARGET");
      if (!res.destroyed) res.json(catalog ? { groups } : groups[0]);
    } catch {
      if (!res.destroyed) res.status(503).json({ code: "SERVICE_UNAVAILABLE" });
    } finally {
      res.off("close", disconnect);
      busy = false;
    }
  }

  async function describeModuleCatalog(
    res: Response,
    initial: ReturnType<typeof currentAccess>,
    get: () => ReturnType<typeof currentAccess>,
  ) {
    if (!initial.settings.modules?.organizeSavedResources) {
      res.status(403).json({ code: "FORBIDDEN" });
      return;
    }
    if (busy) {
      res.status(409).json({ code: "BUSY" });
      return;
    }
    busy = true;
    if (saved?.resource === "module" && saved.key === initial.key)
      clearPreview();
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(25_000),
    ]);
    const disconnect = () => controller.abort();
    res.once("close", disconnect);
    const assertCurrent = () => {
      signal.throwIfAborted();
      const current = get();
      if (current.key !== initial.key) throw new Error("INVALID_CANVAS_TARGET");
      return current;
    };
    try {
      const { origin, courseId, teacherId } = initial.settings;
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
      const target = await client.readTarget();
      const catalog = await client.modules.catalog();
      if (JSON.stringify(await client.readTarget()) !== JSON.stringify(target))
        throw new Error("INVALID_CANVAS_TARGET");
      const { settings, launchKeys } = assertCurrent();
      const entries = Object.values(catalog).flat();
      if (
        [...launchKeys, settings.canvasToken].some((secret) =>
          entries.some(
            ({ id, title }) => id.includes(secret) || title.includes(secret),
          ),
        )
      )
        throw new Error("INVALID_CANVAS_TARGET");
      if (!res.destroyed) res.json(catalog);
    } catch {
      if (!res.destroyed) res.status(503).json({ code: "SERVICE_UNAVAILABLE" });
    } finally {
      res.off("close", disconnect);
      busy = false;
    }
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
        if (resource === "module") {
          res.setHeader("Cache-Control", "no-store");
          res.vary("X-Laita-Module-Catalog");
          if (req.get("x-laita-module-catalog") === "1") {
            await describeModuleCatalog(res, initial, get);
            return;
          }
        }
        if (resource === "assignment") {
          res.setHeader("Cache-Control", "no-store");
          res.vary("X-Laita-Assignment-Group");
          const mode = req.get("x-laita-assignment-group");
          if (mode === "1" || mode === "catalog") {
            await describeAssignmentGroups(
              res,
              initial,
              get,
              mode === "catalog",
            );
            return;
          }
        }
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
      const organizeSavedResources = modules?.organizeSavedResources;
      if ("moduleId" in draft && !organizeSavedResources) {
        const items = draft.kind === "LINK_ORDERED" ? draft.items : [draft];
        if (
          !modules?.moduleIds.includes(draft.moduleId) ||
          !items.every(({ kind, contentId }) =>
            (kind === "LINK_PAGE"
              ? modules.pageIds
              : modules.assignmentIds
            ).includes(contentId),
          )
        ) {
          res.status(403).json({ code: "FORBIDDEN" });
          return;
        }
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
      const signal =
        draft.kind === "LINK_ORDERED" ||
        (organizeSavedResources && "moduleId" in draft)
          ? AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)])
          : controller.signal;
      const disconnect = () => controller.abort();
      res.once("close", disconnect);
      let dispatched = false;
      let resourceId: string | undefined;
      const orderSteps: CanvasModuleStep[] = [];
      let orderTargetChecked = false;
      const assertAccess = () => {
        const details = get(draft);
        if (details.key !== key) throw new Error("INVALID_CANVAS_TARGET");
        return details;
      };
      const assertCurrent = () => {
        signal.throwIfAborted();
        return assertAccess();
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
            ...(resource === "module" &&
              organizeSavedResources && { organizeSavedResources }),
            refresh: () =>
              createSecretHandleForProvider(
                assertCurrent().settings.canvasToken,
              ),
            ...(options.fetcher ? { fetcher: options.fetcher } : {}),
          },
          signal,
        );
        const current = await client.readTarget(
          "title" in draft ? draft : undefined,
        );
        const recheckTarget = async () => {
          const fresh = await client.readTarget();
          if (JSON.stringify(fresh) !== JSON.stringify(current))
            throw new Error("INVALID_CANVAS_TARGET");
        };
        if (
          organizeSavedResources &&
          action === "preview" &&
          "moduleId" in draft
        )
          await client.modules.assertCatalogTargets(draft);
        const link =
          draft.kind === "LINK_PAGE" || draft.kind === "LINK_ASSIGNMENT"
            ? await client.modules.preview(draft)
            : undefined;
        const order =
          draft.kind === "LINK_ORDERED"
            ? await client.modules.previewOrder(draft)
            : undefined;
        const links = link ? [link] : (order?.links ?? []);
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
            action === "preview",
          );
        }
        const { launchKeys, settings } = assertCurrent();
        if (
          [...launchKeys, settings.canvasToken].some(
            (secret) =>
              current.courseName.includes(secret) ||
              subject?.name.includes(secret) ||
              sample?.subject.assignmentName.includes(secret) ||
              links.some(
                ({ subject, resource }) =>
                  subject.moduleName.includes(secret) ||
                  resource.name.includes(secret) ||
                  resource.reference.includes(secret),
              ),
          )
        )
          throw new Error("INVALID_CANVAS_TARGET");
        const snapshot = JSON.stringify({
          target: current,
          subject,
          link,
          order,
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
            ...(order && {
              orderedSubjects: order.links.map(({ subject }) => subject),
            }),
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
        } else if (draft.kind === "LINK_ORDERED") {
          if (!order || !plan) throw new Error("INVALID_CANVAS_TARGET");
          await client.modules.applyOrder(
            draft,
            order,
            orderSteps,
            async () => {
              orderTargetChecked = false;
              await recheckTarget();
              orderTargetChecked = true;
            },
            () => {
              if (!dispatched) beforeDispatch();
              else {
                assertCurrent();
                if (plan.expires <= now()) throw new Error("PREVIEW_REQUIRED");
              }
            },
          );
          assertAccess();
          if (!res.destroyed)
            res.json({ status: "ORDERED", steps: orderSteps });
          return;
        } else {
          resourceId = await client.modules.write(
            draft,
            link,
            beforeDispatch,
            recheckTarget,
          );
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
          if (orderSteps.length && orderTargetChecked) {
            assertAccess();
            res.json({ status: "ORDERED", steps: orderSteps });
            return;
          }
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

  async function chatHandler(req: Request, res: Response, native = false) {
    res.setHeader("Cache-Control", "no-store");
    const actor = authorizeTeacher(req, res);
    if (!actor) return;
    const unavailable = () =>
      res.status(503).json({ code: "CANVAS_CHAT_UNAVAILABLE" });
    const select = native ? options.selectChatTool : undefined;
    if (native && !select) {
      unavailable();
      return;
    }
    const guide = () =>
      res.json({
        text: "Ask how many submissions or what score the configured Test Student has for one approved assignment. Use its full title.",
      });
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
    const question = body.question;
    if (
      select &&
      [...initial.launchKeys, initial.settings.canvasToken].some((secret) =>
        question.includes(secret),
      )
    ) {
      res.status(400).json({ code: "INVALID_REQUEST" });
      return;
    }
    const query = select
      ? undefined
      : /^(how many submissions|what is the score) for (.{1,250}?)\??$/iu.exec(
          question.trim(),
        );
    let selection =
      query && canvasPageTitle(query[2])
        ? {
            title: query[2],
            kind:
              query[1]!.toLowerCase() === "how many submissions"
                ? ("count" as const)
                : ("score" as const),
          }
        : undefined;
    if (!select && !selection) {
      guide();
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
    busy = true;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(select ? 35_000 : 15_000),
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
      if (select) {
        const proposed = await select(question, signal);
        assertCurrent();
        if (proposed === undefined) {
          res.json({
            text: "Canvas tools are unavailable on the selected Local model. Use Direct query mode for an exact question.",
          });
          return;
        }
        selection = selectCanvasChatCall(proposed, question);
      }
      if (!selection) {
        guide();
        return;
      }
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
      const observation = await client.chat(selection, chat);
      const { launchKeys, settings } = assertCurrent();
      if (
        observation &&
        [...launchKeys, settings.canvasToken].some((secret) =>
          observation.name.includes(secret),
        )
      )
        throw new Error("INVALID_CANVAS_TARGET");
      res.json({ text: canvasChatText(observation, selection.kind) });
    } catch {
      if (!res.destroyed) unavailable();
    } finally {
      busy = false;
      res.off("close", disconnect);
    }
  }

  const inventory: RequestHandler = async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const actor = authorizeTeacher(req, res);
    if (!actor) return;
    const kind = req.params.kind;
    if (kind !== undefined && !isCanvasInventoryKind(kind)) {
      res.status(400).json({ code: "INVALID_REQUEST" });
      return;
    }
    const unavailable = () =>
      res.status(503).json({ code: "SERVICE_UNAVAILABLE" });
    const get = () => currentAccess(req, actor, "inventory");
    let initial: ReturnType<typeof get>;
    try {
      initial = get();
    } catch {
      unavailable();
      return;
    }
    const { origin, courseId, teacherId, assignments, modules } =
      initial.settings;
    const ids = {
      pages: modules?.pageIds ?? [],
      "editable-assignments": assignments?.editableIds ?? [],
      "module-assignments": modules?.assignmentIds ?? [],
      modules: modules?.moduleIds ?? [],
    } satisfies Record<CanvasInventoryKind, string[]>;
    if (!kind) {
      res.json({
        kinds: canvasInventoryKinds.filter((key) => ids[key].length),
      });
      return;
    }
    if (!ids[kind].length) {
      res.status(403).json({ code: "FORBIDDEN" });
      return;
    }
    if (busy) {
      res.status(409).json({ code: "BUSY" });
      return;
    }
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
      const current = get();
      if (current.key !== initial.key) throw new Error("INVALID_CANVAS_TARGET");
      return current;
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
      const target = await client.readTarget();
      const read = {
        pages: (id: string) => client.modules.describeItem("LINK_PAGE", id),
        "editable-assignments": client.assignments.describe,
        "module-assignments": (id: string) =>
          client.modules.describeItem("LINK_ASSIGNMENT", id),
        modules: client.modules.describeDestination,
      }[kind];
      const entries: CanvasInventory["entries"] = [];
      for (const id of ids[kind]) entries.push(await read(id));
      entries.sort(
        (a, b) =>
          a.title.localeCompare(b.title, "en", {
            numeric: true,
            sensitivity: "base",
          }) || a.id.localeCompare(b.id, "en", { numeric: true }),
      );
      const result: CanvasInventory = { target, entries };
      const { launchKeys, settings } = assertCurrent();
      const fields = [
        ...Object.values(target),
        ...entries.flatMap(({ id, title }) => [id, title]),
      ];
      if (
        [...launchKeys, settings.canvasToken].some((secret) =>
          fields.some((field) => field.includes(secret)),
        )
      )
        throw new Error("INVALID_CANVAS_TARGET");
      res.json(result);
    } catch {
      if (!res.destroyed) unavailable();
    } finally {
      busy = false;
      res.off("close", disconnect);
    }
  };

  const verification = createCanvasVerificationHandlers(
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
    chat: (req: Request, res: Response) => chatHandler(req, res),
    chatTools: (req: Request, res: Response) => chatHandler(req, res, true),
    inventory,
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
