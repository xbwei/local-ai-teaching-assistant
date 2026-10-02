import { installHistoryRoutes } from "./history.ts";
import path from "node:path";
import { createOwnerTransport } from "./browser.ts";
import type { AccessConfiguration } from "@laita/contracts/server";
import { installInputRoutes, type InputPorts } from "./input.ts";
import express from "express";
import type { ErrorRequestHandler, Request, Response } from "express";
import {
  isCapabilityAvailability,
  isInstructorPolicyEmergencyDisable,
  isInstructorPolicyMutation,
  isInstructorPolicyPreviewRequest,
  isInstructorPolicyRollback,
  isProviderUsageSummary,
  isProviderHealthSnapshot,
  healthStatus,
  type PublicError,
} from "@laita/contracts";
import {
  createCorrelationId,
  createWorkGate,
  defaultConfiguration,
  type WorkGate,
  createOperationalLogger,
  createPublicError,
  mapUnexpectedFailure,
  type OperationalLogger,
  type Operation,
  type OutcomeCode,
} from "@laita/runtime";
import { createAccessController, type AccessController } from "./access.ts";

import type { Persistence } from "@laita/persistence";

interface RequestContext {
  correlationId: string;
  operation: Operation;
  code: OutcomeCode;
  recorded: boolean;
}
interface AppOptions {
  browserAccess?: AccessConfiguration;
  browserNow?: () => number;
  webRoot?: string;
  input?: InputPorts;
  logger?: OperationalLogger;
  workGate?: WorkGate;
  persistence?: Pick<Persistence, "isReady">;
  history?: import("@laita/persistence").HistoryRepository;
  access?: AccessController;
  capabilities?: {
    read(audience: "instructor"): unknown;
  };
  policyControls?: {
    readState(): unknown;
    history(): unknown;
    preview(expectedVersion: number, policy: unknown): unknown;
    activate(
      expectedVersion: number,
      previewDigest: unknown,
      policy: unknown,
      actorRole: "ADMIN" | "INSTRUCTOR",
    ): unknown;
    emergencyDisable(
      expectedVersion: number,
      actorRole: "ADMIN" | "INSTRUCTOR",
    ): unknown;
    rollback(
      expectedVersion: number,
      actorRole: "ADMIN" | "INSTRUCTOR",
    ): unknown;
  };
  usageControls?: { summary(): unknown };
  providerControls?: {
    health(): unknown;
  };
}

export function createApp(options: AppOptions = {}) {
  const logger = options.logger ?? createOperationalLogger();
  const workGate =
    options.workGate ?? createWorkGate(defaultConfiguration().runtime);
  const access =
    options.access ?? createAccessController(defaultConfiguration().access);
  const contexts = new WeakMap<Response, RequestContext>();
  const app = express();
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    const context: RequestContext = {
      correlationId: createCorrelationId(),
      operation: "UNMATCHED",
      code: "INTERNAL_FAILURE",
      recorded: false,
    };
    contexts.set(response, context);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    response.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    // Incoming headers/IDs are never used as identity or correlation authority.
    response.setHeader("X-Correlation-ID", context.correlationId);
    response.once("finish", () => {
      if (
        context.operation === "INPUT" &&
        response.statusCode >= 400 &&
        context.code === "OK"
      )
        context.code =
          response.statusCode === 404
            ? "NOT_FOUND"
            : response.statusCode === 503
              ? "SERVICE_UNAVAILABLE"
              : "INVALID_REQUEST";
      record(context);
    });
    next();
  });
  function record(context: RequestContext) {
    if (context.recorded) return;
    context.recorded = true;
    logger.write(context);
  }
  function sendError(response: Response, error: PublicError, status: number) {
    const context = contexts.get(response)!;
    context.code = error.code;
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) {
      // Do not forward a raw exception to Express's default stack-printing handler.
      record(context);
      response.destroy();
      return;
    }
    response.status(status).json(error);
  }
  function authorize(
    request: Request,
    response: Response,
    audience: "student" | "kiosk" | "instructor" | "admin" | "control",
  ): false | { actorRole?: "ADMIN" | "INSTRUCTOR" } {
    const accessRequest: Parameters<AccessController["authorize"]>[0] = {};
    const authorization = request.get("authorization");
    const origin = request.get("origin");
    const forwardedHost = request.get("x-forwarded-host");
    const forwardedProto = request.get("x-forwarded-proto");
    if (authorization !== undefined)
      accessRequest.authorization = authorization;
    if (origin !== undefined) accessRequest.origin = origin;
    if (forwardedHost !== undefined)
      accessRequest.forwardedHost = forwardedHost;
    if (forwardedProto !== undefined)
      accessRequest.forwardedProto = forwardedProto;
    const decision = access.authorize(accessRequest, audience);
    if (decision.ok) {
      if (forwardedProto === "https")
        response.setHeader(
          "Strict-Transport-Security",
          "max-age=31536000; includeSubDomains",
        );
      return decision;
    }
    if (decision.status === 401)
      response.setHeader("WWW-Authenticate", "Bearer");
    sendError(
      response,
      createPublicError(decision.code, contexts.get(response)!.correlationId),
      decision.status,
    );
    return false;
  }
  const browser = options.browserAccess
    ? createOwnerTransport(options.browserAccess, options.browserNow)
    : undefined;
  if (options.history && browser) {
    app.use("/api/v1/history", (_req, res, next) => {
      const context = contexts.get(res)!;
      context.operation = "INPUT";
      context.code = "OK";
      next();
    });
    installHistoryRoutes(app, options.history, browser.authenticate);
  }
  if (options.input) {
    app.use("/api/v1/input", (_req, res, next) => {
      const context = contexts.get(res)!;
      context.operation = "INPUT";
      context.code = "OK";
      next();
    });
    const input = installInputRoutes(app, options.input, (request, response) =>
      browser
        ? browser.authenticate(request, response)
        : (response.sendStatus(403), false),
    );
    app.locals.closeInput = () => {
      browser?.close();
      input.close();
    };
  }
  app.get("/health", (_request, response) => {
    const context = contexts.get(response)!;
    context.operation = "HEALTH";
    context.code = "OK";
    response.json(healthStatus);
  });
  app.get("/ready", (_request, response) => {
    const context = contexts.get(response)!;
    context.operation = "READINESS";
    if (
      options.persistence?.isReady() !== true ||
      !workGate.isReady() ||
      !access.isReady()
    ) {
      context.code = "SERVICE_UNAVAILABLE";
      response.status(503).json({
        contractVersion: "readiness.v1",
        status: "not-ready",
        error: createPublicError(context.code, context.correlationId),
      });
      return;
    }
    context.code = "OK";
    response.json({ contractVersion: "readiness.v1", status: "ready" });
  });
  function capabilityRoute(audience: "instructor") {
    return async (request: Request, response: Response) => {
      const context = contexts.get(response)!;
      context.operation = "CAPABILITY";
      if (!authorize(request, response, audience)) return;
      if (
        Object.keys(request.query).length !== 0 ||
        (request.get("content-length") !== undefined &&
          request.get("content-length") !== "0") ||
        request.get("transfer-encoding") !== undefined
      ) {
        sendError(
          response,
          createPublicError("INVALID_REQUEST", context.correlationId),
          400,
        );
        return;
      }
      try {
        const value = await options.capabilities?.read(audience);
        if (request.aborted || response.destroyed) return;
        if (!isCapabilityAvailability(value)) {
          sendError(
            response,
            createPublicError("SERVICE_UNAVAILABLE", context.correlationId),
            503,
          );
          return;
        }
        context.code = "OK";
        response.json(value);
      } catch (failure) {
        sendError(
          response,
          mapUnexpectedFailure(failure, context.correlationId),
          500,
        );
      }
    };
  }
  app.get("/api/instructor/capabilities", capabilityRoute("instructor"));
  function providerHealthRoute(audience: "instructor") {
    return (request: Request, response: Response) => {
      const context = contexts.get(response)!;
      context.operation = "PROVIDER_HEALTH";
      if (!authorize(request, response, audience)) return;
      if (!validPolicyRequest(request)) {
        sendError(
          response,
          createPublicError("INVALID_REQUEST", context.correlationId),
          400,
        );
        return;
      }
      const value = options.providerControls?.health();
      if (!isProviderHealthSnapshot(value)) {
        sendError(
          response,
          createPublicError("SERVICE_UNAVAILABLE", context.correlationId),
          503,
        );
        return;
      }
      context.code = "OK";
      response.json(value);
    };
  }
  app.get("/api/instructor/provider-health", providerHealthRoute("instructor"));
  const policyJson = express.json({
    inflate: false,
    limit: 16_384,
    strict: true,
    type: "application/json",
  });
  const policyActors = new WeakMap<Request, "ADMIN" | "INSTRUCTOR">();
  app.use("/api/admin/provider-policy", (request, response, next) => {
    const context = contexts.get(response)!;
    context.operation = "POLICY_CONTROL";
    const decision = authorize(request, response, "control");
    if (!decision) return;
    if (!decision.actorRole) {
      sendError(
        response,
        createPublicError("SERVICE_UNAVAILABLE", context.correlationId),
        503,
      );
      return;
    }
    policyActors.set(request, decision.actorRole);
    next();
  });
  app.use("/api/admin/provider-policy", (request, response, next) => {
    policyJson(request, response, (failure) => {
      if (!failure) {
        next();
        return;
      }
      const context = contexts.get(response)!;
      context.operation = "POLICY_CONTROL";
      sendError(
        response,
        createPublicError("INVALID_REQUEST", context.correlationId),
        400,
      );
    });
  });
  function policyActor(request: Request, response: Response) {
    const actorRole = policyActors.get(request);
    if (actorRole) return actorRole;
    const context = contexts.get(response)!;
    sendError(
      response,
      createPublicError("SERVICE_UNAVAILABLE", context.correlationId),
      503,
    );
    return false;
  }
  function validPolicyRequest(request: Request, bodyExpected = false): boolean {
    return (
      Object.keys(request.query).length === 0 &&
      (bodyExpected ||
        ((request.get("content-length") === undefined ||
          request.get("content-length") === "0") &&
          request.get("transfer-encoding") === undefined))
    );
  }
  function sendPolicyResult(response: Response, result: unknown) {
    const context = contexts.get(response)!;
    // Service results are own data properties. Do not invoke accessors or trust
    // inherited success/error fields at this control boundary.
    if (
      result !== null &&
      typeof result === "object" &&
      Object.getOwnPropertyDescriptor(result, "ok")?.value === true
    ) {
      const value = Object.getOwnPropertyDescriptor(result, "value")?.value;
      context.code = "OK";
      response.json(value);
      return;
    }
    const code =
      result !== null && typeof result === "object"
        ? Object.getOwnPropertyDescriptor(result, "code")?.value
        : undefined;
    if (code === "CONFLICT") {
      sendError(
        response,
        createPublicError("CONFLICT", context.correlationId),
        409,
      );
      return;
    }
    if (code === "NOT_FOUND") {
      sendError(
        response,
        createPublicError("NOT_FOUND", context.correlationId),
        404,
      );
      return;
    }
    if (code === "INVALID_POLICY") {
      sendError(
        response,
        createPublicError("INVALID_REQUEST", context.correlationId),
        400,
      );
      return;
    }
    sendError(
      response,
      createPublicError("SERVICE_UNAVAILABLE", context.correlationId),
      503,
    );
  }
  app.get("/api/admin/provider-policy", (request, response) => {
    const context = contexts.get(response)!;
    context.operation = "POLICY_CONTROL";
    if (!policyActor(request, response)) return;
    if (!validPolicyRequest(request)) {
      sendError(
        response,
        createPublicError("INVALID_REQUEST", context.correlationId),
        400,
      );
      return;
    }
    sendPolicyResult(response, options.policyControls?.readState());
  });
  app.get("/api/admin/provider-policy/history", (request, response) => {
    const context = contexts.get(response)!;
    context.operation = "POLICY_CONTROL";
    if (!policyActor(request, response)) return;
    if (!validPolicyRequest(request)) {
      sendError(
        response,
        createPublicError("INVALID_REQUEST", context.correlationId),
        400,
      );
      return;
    }
    sendPolicyResult(response, options.policyControls?.history());
  });
  app.post("/api/admin/provider-policy/preview", (request, response) => {
    const context = contexts.get(response)!;
    context.operation = "POLICY_CONTROL";
    if (!policyActor(request, response)) return;
    if (
      !validPolicyRequest(request, true) ||
      !isInstructorPolicyPreviewRequest(request.body)
    ) {
      sendError(
        response,
        createPublicError("INVALID_REQUEST", context.correlationId),
        400,
      );
      return;
    }
    sendPolicyResult(
      response,
      options.policyControls?.preview(
        request.body.expectedVersion,
        request.body.policy,
      ),
    );
  });
  app.put("/api/admin/provider-policy", (request, response) => {
    const context = contexts.get(response)!;
    context.operation = "POLICY_CONTROL";
    const actorRole = policyActor(request, response);
    if (!actorRole) return;
    if (
      !validPolicyRequest(request, true) ||
      !isInstructorPolicyMutation(request.body)
    ) {
      sendError(
        response,
        createPublicError("INVALID_REQUEST", context.correlationId),
        400,
      );
      return;
    }
    sendPolicyResult(
      response,
      options.policyControls?.activate(
        request.body.expectedVersion,
        request.body.previewDigest,
        request.body.policy,
        actorRole,
      ),
    );
  });
  app.post(
    "/api/admin/provider-policy/emergency-cloud-disable",
    (request, response) => {
      const context = contexts.get(response)!;
      context.operation = "POLICY_CONTROL";
      const actorRole = policyActor(request, response);
      if (!actorRole) return;
      if (
        !validPolicyRequest(request, true) ||
        !isInstructorPolicyEmergencyDisable(request.body)
      ) {
        sendError(
          response,
          createPublicError("INVALID_REQUEST", context.correlationId),
          400,
        );
        return;
      }
      sendPolicyResult(
        response,
        options.policyControls?.emergencyDisable(
          request.body.expectedVersion,
          actorRole,
        ),
      );
    },
  );
  app.post("/api/admin/provider-policy/rollback", (request, response) => {
    const context = contexts.get(response)!;
    context.operation = "POLICY_CONTROL";
    const actorRole = policyActor(request, response);
    if (!actorRole) return;
    if (
      !validPolicyRequest(request, true) ||
      !isInstructorPolicyRollback(request.body)
    ) {
      sendError(
        response,
        createPublicError("INVALID_REQUEST", context.correlationId),
        400,
      );
      return;
    }
    sendPolicyResult(
      response,
      options.policyControls?.rollback(request.body.expectedVersion, actorRole),
    );
  });
  app.get("/api/admin/provider-usage/summary", (request, response) => {
    const context = contexts.get(response)!;
    context.operation = "USAGE_CONTROL";
    if (!authorize(request, response, "control")) return;
    if (!validPolicyRequest(request)) {
      sendError(
        response,
        createPublicError("INVALID_REQUEST", context.correlationId),
        400,
      );
      return;
    }
    const result = options.usageControls?.summary();
    // Keep the same own-data-property boundary before validating usage output.
    if (
      result !== null &&
      typeof result === "object" &&
      Object.getOwnPropertyDescriptor(result, "ok")?.value === true &&
      !isProviderUsageSummary(
        Object.getOwnPropertyDescriptor(result, "value")?.value,
      )
    ) {
      sendPolicyResult(response, undefined);
      return;
    }
    sendPolicyResult(response, result);
  });
  app.get("/api/admin/access", (request, response) => {
    const context = contexts.get(response)!;
    context.operation = "ADMIN_ACCESS";
    if (!authorize(request, response, "admin")) return;
    context.code = "OK";
    response.json(access.status());
  });
  if (options.webRoot) {
    const now = options.browserNow ?? (() => performance.now());
    let staticWindow = now();
    let staticRequests = 0;
    const webHeaders = (req: Request, res: Response, next: () => void) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        next();
        return;
      }
      const currentTime = now();
      if (currentTime - staticWindow >= 60_000) {
        staticWindow = currentTime;
        staticRequests = 0;
      }
      if (++staticRequests > 600) {
        sendError(
          res,
          createPublicError("RATE_LIMITED", contexts.get(res)!.correlationId),
          429,
        );
        return;
      }
      contexts.get(res)!.code = "OK";
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; media-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      res.setHeader(
        "Permissions-Policy",
        "microphone=(self), camera=(), geolocation=()",
      );
      next();
    };
    app.get(["/", "/history"], webHeaders, (_req, res) =>
      res.sendFile(path.join(options.webRoot!, "index.html")),
    );
    app.get("/capture-worklet.js", webHeaders, (_req, res) =>
      res.sendFile(path.join(options.webRoot!, "capture-worklet.js")),
    );
    app.use(
      "/assets",
      webHeaders,
      express.static(path.join(options.webRoot, "assets"), {
        dotfiles: "deny",
        redirect: false,
        index: false,
      }),
    );
  }
  app.use((_request, response) => {
    sendError(
      response,
      createPublicError("NOT_FOUND", contexts.get(response)!.correlationId),
      404,
    );
  });
  const onError: ErrorRequestHandler = (
    failure: unknown,
    _request,
    response,
    _next,
  ) => {
    sendError(
      response,
      mapUnexpectedFailure(failure, contexts.get(response)!.correlationId),
      500,
    );
  };
  app.use(onError);
  return app;
}
