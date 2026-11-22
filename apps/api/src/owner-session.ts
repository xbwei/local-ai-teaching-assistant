import { rateLimit, MemoryStore } from "express-rate-limit";
import { createHash, randomBytes } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import type { AccessConfiguration } from "@laita/contracts/server";
import { courseIds, type CourseId } from "@laita/course-grounding";
import {
  demoUsernames,
  type DemoUsername,
  type HistoryScope,
  type OwnerAuthRepository,
} from "@laita/persistence";
import { verifyOwnerCredential } from "./owner-credential.ts";
import {
  createTeacherDraftHandler,
  createTeacherDraftParser,
  type TeacherDraft,
} from "./teacher-draft.ts";
import {
  createTeacherHistoryParser,
  createTeacherHistoryQueryHandler,
  createTeacherHistoryStatusHandler,
  type TeacherHistoryOptions,
} from "./teacher-history.ts";
import {
  createCanvasAuthoringHandlers,
  createCanvasPageParser,
  type CanvasPageOptions,
} from "./canvas-pages.ts";
import {
  canvasFingerprint,
  type CanvasConfiguration,
  verifyCanvasLaunch,
} from "./canvas.ts";

export interface OwnerSession extends HistoryScope {
  source: "local" | "canvas";
  revision: string;
  expires: number;
  canvasRevision?: string;
  demo?: { username: DemoUsername; course: CourseId };
}
const cookieName = "__Host-laita-session";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export function createOwnerSessions(options: {
  access: AccessConfiguration;
  store?: OwnerAuthRepository;
  canvas?: () => CanvasConfiguration | undefined;
  sampleHistoryContext?: string;
  canvasPages?: CanvasPageOptions;
  now?: () => number;
}) {
  const { access, store } = options;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, OwnerSession>();
  // One protected entry, deliberately no per-person/IP profiling. The shared
  // Express limiter also bounds status/logout and control requests.
  const entryStore = new MemoryStore();
  const entryLimit = rateLimit({
    windowMs: 60_000,
    limit: 600,
    keyGenerator: () => "single-owner-entry",
    store: entryStore,
    standardHeaders: false,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ code: "RATE_LIMITED" });
    },
  });
  const publicOrigin = new URL(access.publicOrigin);
  let attempts = 0,
    window = now(),
    verifying = false;
  let launches = 0,
    launchWindow = now();
  const token = (req: Request) => {
    const values = (req.get("cookie") ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.startsWith(`${cookieName}=`));
    const value =
      values.length === 1 ? values[0]!.slice(cookieName.length + 1) : "";
    return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : undefined;
  };
  const transport = (req: Request, canvas = false) => {
    const c = canvas ? options.canvas?.() : undefined;
    return (
      access.enabled &&
      !access.maintenanceMode &&
      access.mode === "single-operator" &&
      req.get("x-forwarded-proto")?.toLowerCase() === "https" &&
      req.get("x-forwarded-host")?.toLowerCase() === publicOrigin.host &&
      !req.get("authorization") &&
      !req.get("content-encoding") &&
      !Object.keys(req.query).length &&
      (canvas
        ? !!c && req.get("origin") === c.canvasOrigin
        : (req.get("origin") === undefined ||
            req.get("origin") === publicOrigin.origin) &&
          (req.method === "GET" || req.get("origin") === publicOrigin.origin) &&
          (!req.get("sec-fetch-site") ||
            req.get("sec-fetch-site") === "same-origin"))
    );
  };
  const lookup = (req: Request) => {
    const raw = token(req);
    if (!raw) return;
    const binding = sha(raw);
    const session = sessions.get(binding);
    if (!session) return;
    const membership =
      session.demo && store?.demoMembership(session.demo.username);
    const revision = session.demo
      ? membership?.active &&
        membership.course === session.demo.course &&
        membership.role === session.role
        ? membership.credential.revision
        : undefined
      : store?.credential()?.revision;
    const canvas = session.source === "canvas" ? options.canvas?.() : undefined;
    if (
      session.revision !== revision ||
      session.expires <= now() ||
      (session.source === "canvas" &&
        (!canvas || session.canvasRevision !== canvasFingerprint(canvas)))
    ) {
      sessions.delete(binding);
      return;
    }
    return { ...session, binding };
  };
  const forget = (req: Request) => {
    const raw = token(req);
    if (raw) sessions.delete(sha(raw));
  };
  function establish(
    req: Request,
    res: Response,
    value: Pick<
      OwnerSession,
      "role" | "source" | "context" | "canvasRevision" | "demo"
    >,
    revision: string,
  ) {
    for (const [key, s] of sessions)
      if (
        s.expires <= now() ||
        (s.demo?.username === value.demo?.username && s.revision !== revision)
      )
        sessions.delete(key);
    const current = token(req);
    if (sessions.size - (current && sessions.has(sha(current)) ? 1 : 0) >= 64) {
      res.status(503).json({ code: "SERVICE_UNAVAILABLE" });
      return false;
    }
    forget(req);
    const raw = randomBytes(32).toString("base64url");
    sessions.set(sha(raw), {
      ...value,
      revision,
      expires: now() + 8 * 3600000,
    });
    res.setHeader(
      "Set-Cookie",
      `${cookieName}=${raw}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`,
    );
    return true;
  }
  const deny = (res: Response, status = 403) => {
    res.status(status).json({
      code:
        status === 401
          ? "UNAUTHENTICATED"
          : status === 503
            ? "SERVICE_UNAVAILABLE"
            : "FORBIDDEN",
    });
    return false as const;
  };
  function authorize(req: Request, res: Response) {
    if (!transport(req)) return deny(res);
    try {
      const session = lookup(req);
      if (!session) return deny(res, 401);
      return session;
    } catch {
      return deny(res, 503);
    }
  }
  function isCurrent(req: Request, binding: string) {
    try {
      return transport(req) && lookup(req)?.binding === binding;
    } catch {
      return false;
    }
  }
  const authority = { authorize, isCurrent };
  const authoring =
    options.canvasPages && options.canvas
      ? createCanvasAuthoringHandlers(
          authority,
          options.canvasPages,
          options.canvas,
          now,
        )
      : undefined;
  return {
    ...authority,
    entryLimit,
    install(
      app: Express,
      teacherDraft?: TeacherDraft,
      teacherHistory?: TeacherHistoryOptions,
    ): void {
      app.get("/api/v1/auth/session", entryLimit, (req, res) => {
        const s = authorize(req, res);
        if (s)
          res.json({
            role: s.role,
            source: s.source,
            ...(s.demo ? { course: s.demo.course } : {}),
            ...(s.source === "local" &&
            !s.demo &&
            s.role === "student" &&
            s.context === options.sampleHistoryContext &&
            options.sampleHistoryContext
              ? { sample: true }
              : {}),
          });
      });
      const json = express.json({
        inflate: false,
        limit: 2048,
        strict: true,
        type: "application/json",
      });
      const parseJson: express.RequestHandler = (req, res, next) => {
        json(req, res, (error) => {
          if (error) res.status(400).json({ code: "INVALID_REQUEST" });
          else next();
        });
      };
      app.post(
        "/api/v1/auth/login",
        entryLimit,
        (req, res, next) => {
          if (!transport(req)) {
            deny(res);
            return;
          }
          if (now() - window >= 60000) {
            window = now();
            attempts = 0;
          }
          if (++attempts > 20 || verifying) {
            res.status(429).json({ code: "RATE_LIMITED" });
            return;
          }
          parseJson(req, res, next);
        },
        async (req, res) => {
          const keys = req.body && Object.keys(req.body).sort().join(",");
          const named = keys === "passphrase,username";
          const username = demoUsernames.find(
            (value) => value === req.body?.username,
          );
          const sample =
            keys === "passphrase,role,sample" &&
            req.body.role === "student" &&
            req.body.sample === true &&
            options.sampleHistoryContext;
          if (
            !req.is("application/json") ||
            !req.body ||
            (named
              ? req.body.username !== "admin" && !username
              : (keys !== "passphrase,role" && !sample) ||
                !["admin", "teacher", "student"].includes(req.body.role)) ||
            typeof req.body.passphrase !== "string" ||
            Buffer.byteLength(req.body.passphrase) > 1024
          ) {
            res.status(400).json({ code: "INVALID_REQUEST" });
            return;
          }
          // One KDF at a time, bounded attempts, no passwords in logs or persistence.
          if (verifying) {
            res.status(429).json({ code: "RATE_LIMITED" });
            req.body.passphrase = "";
            return;
          }
          verifying = true;
          try {
            const membership = username && store?.demoMembership(username);
            const credential = username
              ? membership?.credential
              : store?.credential();
            if (!credential) {
              deny(res, username ? 401 : 503);
              return;
            }
            const valid = await verifyOwnerCredential(
              req.body.passphrase,
              credential,
            );
            const current = username && store?.demoMembership(username);
            const course = courseIds.find((value) => value === current?.course);
            if (
              !valid ||
              (username
                ? !current?.active ||
                  !course ||
                  current.credential.revision !== credential.revision
                : store?.credential()?.revision !== credential.revision)
            ) {
              deny(res, 401);
              return;
            }
            const role = current
              ? current.role
              : named
                ? "admin"
                : req.body.role;
            if (
              establish(
                req,
                res,
                {
                  role,
                  source: "local",
                  ...(current && course
                    ? {
                        demo: { username: current.username, course },
                        context: course,
                      }
                    : role === "student"
                      ? { context: sample || "" }
                      : {}),
                },
                credential.revision,
              )
            )
              res.json({
                role,
                source: "local",
                ...(course ? { course } : {}),
              });
          } catch {
            deny(res, 503);
          } finally {
            req.body.passphrase = "";
            verifying = false;
          }
        },
      );
      app.post("/api/v1/auth/logout", entryLimit, (req, res) => {
        if (!transport(req)) {
          deny(res);
          return;
        }
        forget(req);
        res.setHeader(
          "Set-Cookie",
          `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
        );
        res.json({ signedOut: true });
      });
      const demoMemberships = "/api/v1/auth/demo-memberships";
      const requireAdmin: express.RequestHandler = (req, res, next) => {
        const session = authorize(req, res);
        if (!session) return;
        if (session.role !== "admin" || session.source !== "local") {
          deny(res);
          return;
        }
        next();
      };
      app.use(demoMemberships, entryLimit, requireAdmin);
      app.get(demoMemberships, (_req, res) => {
        res.json({ memberships: store!.listDemoMemberships() });
      });
      app.post(demoMemberships, parseJson, requireAdmin, (req, res) => {
        const value = req.body;
        const username = demoUsernames.find((name) => name === value?.username);
        if (
          !req.is("json") ||
          !username ||
          !courseIds.some((course) => course === value.course) ||
          typeof value.active !== "boolean" ||
          Object.keys(value).sort().join(",") !== "active,course,username"
        ) {
          res.status(400).json({ code: "INVALID_REQUEST" });
          return;
        }
        const updated = store!.setDemoMembershipActive(
          username,
          value.course,
          value.active,
        );
        if (!updated) {
          res.status(404).json({ code: "NOT_FOUND" });
          return;
        }
        if (!updated.active)
          for (const [key, session] of sessions)
            if (session.demo?.username === username) sessions.delete(key);
        res.json(updated);
      });
      const form = express.text({
        inflate: false,
        limit: 16384,
        type: "application/x-www-form-urlencoded",
      });
      app.post(
        "/api/v1/canvas/launch",
        entryLimit,
        (req, res, next) => {
          if (now() - launchWindow >= 60000) {
            launches = 0;
            launchWindow = now();
          }
          if (++launches > 120) {
            res.status(429).json({ code: "RATE_LIMITED" });
            return;
          }
          if (!options.canvas?.()) {
            deny(res, 503);
            return;
          }
          if (
            req.originalUrl !== "/api/v1/canvas/launch" ||
            !transport(req, true)
          ) {
            deny(res);
            return;
          }
          form(req, res, (error) => {
            if (error) deny(res);
            else next();
          });
        },
        (req, res) => {
          try {
            const c = options.canvas?.(),
              credential = store?.credential();
            if (!c || !credential) {
              deny(res, 503);
              return;
            }
            if (
              req.get("origin") !== c.canvasOrigin ||
              !req.is("application/x-www-form-urlencoded") ||
              typeof req.body !== "string"
            ) {
              deny(res);
              return;
            }
            const verified = verifyCanvasLaunch(
              req.body,
              c,
              `${publicOrigin.origin}/api/v1/canvas/launch`,
              Math.floor(now() / 1000),
            );
            if (
              !verified ||
              !store!.consumeNonce(
                verified.digest,
                verified.expires,
                Math.floor(now() / 1000),
              )
            ) {
              deny(res);
              return;
            }
            const membership =
              c.demo &&
              store!.demoMembership(
                verified.role === "teacher" ? "demo-teacher" : "demo-student",
              );
            if (
              c.demo &&
              (!membership?.active ||
                membership.course !== c.demo.course ||
                membership.role !== verified.role)
            ) {
              deny(res);
              return;
            }
            if (
              establish(
                req,
                res,
                {
                  role: verified.role,
                  source: "canvas",
                  context: verified.context,
                  canvasRevision: canvasFingerprint(c),
                  ...(c.demo && membership
                    ? {
                        demo: {
                          username: membership.username,
                          course: c.demo.course,
                        },
                      }
                    : {}),
                },
                membership?.credential.revision ?? credential.revision,
              )
            )
              res.redirect(303, "/");
          } catch {
            deny(res);
          } finally {
            req.body = "";
          }
        },
      );
      if (authoring) {
        const { pages, assignments, modules, feedback, chat, verification } =
          authoring;
        const parser = createCanvasPageParser();
        const pagesPath = "/api/v1/canvas/pages";
        app.use(pagesPath, entryLimit);
        app.get(pagesPath, pages.status);
        app.post(pagesPath + "/preview", parser, pages.preview);
        app.post(pagesPath + "/create", parser, pages.create);
        const assignmentsPath = "/api/v1/canvas/assignments";
        app.use(assignmentsPath, entryLimit);
        app.get(assignmentsPath, assignments.status);
        app.post(assignmentsPath + "/preview", parser, assignments.preview);
        app.post(assignmentsPath + "/save", parser, assignments.save);
        const modulesPath = "/api/v1/canvas/modules";
        app.use(modulesPath, entryLimit);
        app.get(modulesPath, modules.status);
        app.post(modulesPath + "/preview", parser, modules.preview);
        app.post(modulesPath + "/save", parser, modules.save);
        const feedbackPath = "/api/v1/canvas/feedback";
        app.use(feedbackPath, entryLimit);
        app.get(feedbackPath, feedback.status);
        const feedbackParser = createCanvasPageParser(8192);
        app.post(feedbackPath + "/preview", feedbackParser, feedback.preview);
        app.post(feedbackPath + "/post", feedbackParser, feedback.post);
        const chatPath = "/api/v1/canvas/chat";
        app.use(chatPath, entryLimit);
        app.get(chatPath, chat);
        app.post(chatPath, createCanvasPageParser(2048), chat);
        const verificationPath = "/api/v1/canvas/verification";
        app.use(verificationPath, entryLimit);
        app.get(verificationPath, verification);
        app.post(verificationPath, createCanvasPageParser(2048), verification);
      }
      if (teacherDraft)
        app.post(
          "/api/v1/teacher-draft",
          entryLimit,
          createTeacherDraftParser(),
          createTeacherDraftHandler(authority, teacherDraft),
        );
      if (teacherHistory) {
        const historyPath = "/api/v1/teacher-tools/history";
        app.use(historyPath, entryLimit);
        app.get(historyPath, createTeacherHistoryStatusHandler(authority));
        app.post(
          historyPath,
          createTeacherHistoryParser(),
          createTeacherHistoryQueryHandler(authority, teacherHistory),
        );
      }
    },
    close() {
      authoring?.close();
      sessions.clear();
      entryStore.shutdown();
    },
  };
}
export type OwnerSessions = ReturnType<typeof createOwnerSessions>;
