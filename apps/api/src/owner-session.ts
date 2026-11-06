import { createHash, randomBytes } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import type { AccessConfiguration } from "@laita/contracts/server";
import type { HistoryScope, OwnerAuthRepository } from "@laita/persistence";
import { verifyOwnerCredential } from "./owner-credential.ts";
import {
  canvasContext,
  canvasFingerprint,
  type CanvasConfiguration,
  verifyCanvasLaunch,
} from "./canvas.ts";

export interface OwnerSession extends HistoryScope {
  source: "local" | "canvas";
  revision: string;
  expires: number;
  canvasRevision?: string;
}
const cookieName = "__Host-laita-session";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export function createOwnerSessions(options: {
  access: AccessConfiguration;
  store?: OwnerAuthRepository;
  canvas?: () => CanvasConfiguration | undefined;
  now?: () => number;
}) {
  const { access, store } = options;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, OwnerSession>();
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
      req.get("x-forwarded-proto") === "https" &&
      req.get("x-forwarded-host") === publicOrigin.host &&
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
    const session = raw ? sessions.get(sha(raw)) : undefined;
    if (!session) return;
    const credential = store?.credential();
    const canvas = session.source === "canvas" ? options.canvas?.() : undefined;
    if (
      !credential ||
      session.revision !== credential.revision ||
      session.expires <= now() ||
      (session.source === "canvas" &&
        (!canvas || session.canvasRevision !== canvasFingerprint(canvas)))
    ) {
      sessions.delete(sha(raw!));
      return;
    }
    return { ...session, binding: sha(raw!) };
  };
  const forget = (req: Request) => {
    const raw = token(req);
    if (raw) sessions.delete(sha(raw));
  };
  function establish(
    req: Request,
    res: Response,
    value: Pick<OwnerSession, "role" | "source" | "context" | "canvasRevision">,
    revision: string,
  ) {
    for (const [key, s] of sessions)
      if (s.expires <= now() || s.revision !== revision) sessions.delete(key);
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
  return {
    authorize,
    install(app: Express) {
      app.get("/api/v1/auth/session", (req, res) => {
        const s = authorize(req, res);
        if (s) res.json({ role: s.role, source: s.source });
      });
      const json = express.json({
        inflate: false,
        limit: 2048,
        strict: true,
        type: "application/json",
      });
      app.post(
        "/api/v1/auth/login",
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
          json(req, res, (error) => {
            if (error) res.status(400).json({ code: "INVALID_REQUEST" });
            else next();
          });
        },
        async (req, res) => {
          if (
            !req.is("application/json") ||
            !req.body ||
            Object.keys(req.body).sort().join(",") !== "passphrase,role" ||
            !["admin", "teacher", "student"].includes(req.body.role) ||
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
            const credential = store?.credential();
            if (!credential) {
              deny(res, 503);
              return;
            }
            const valid = await verifyOwnerCredential(
              req.body.passphrase,
              credential,
            );
            if (!valid) {
              deny(res, 401);
              return;
            }
            if (store?.credential()?.revision !== credential.revision) {
              deny(res, 401);
              return;
            }
            if (
              establish(
                req,
                res,
                { role: req.body.role, source: "local" },
                credential.revision,
              )
            )
              res.json({ role: req.body.role, source: "local" });
          } catch {
            deny(res, 503);
          } finally {
            req.body.passphrase = "";
            verifying = false;
            let launches = 0,
              launchWindow = now();
          }
        },
      );
      app.post("/api/v1/auth/logout", (req, res) => {
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
      const form = express.text({
        inflate: false,
        limit: 16384,
        type: "application/x-www-form-urlencoded",
      });
      app.post(
        "/api/v1/canvas/launch",
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
            if (
              establish(
                req,
                res,
                {
                  role: "teacher",
                  source: "canvas",
                  context: canvasContext(c),
                  canvasRevision: canvasFingerprint(c),
                },
                credential.revision,
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
    },
    close() {
      sessions.clear();
    },
  };
}
export type OwnerSessions = ReturnType<typeof createOwnerSessions>;
