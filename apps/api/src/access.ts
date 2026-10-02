import { createHash, timingSafeEqual } from "node:crypto";
import type {
  AccessAudience,
  AccessConfiguration,
} from "@laita/contracts/server";
import type { PublicErrorCode } from "@laita/contracts";

export interface AccessRequest {
  authorization?: string;
  origin?: string;
  forwardedHost?: string;
  forwardedProto?: string;
}
export type AccessDecision =
  | { ok: true; actorRole?: "ADMIN" | "INSTRUCTOR" }
  | { ok: false; code: PublicErrorCode; status: number };
export interface AccessController {
  authorize(request: AccessRequest, audience: AccessAudience): AccessDecision;
  binding(
    request: AccessRequest,
  ): { courseScopes: string[]; expires: number } | undefined;
  isReady(): boolean;
  status(): {
    contractVersion: "access-status.v1";
    mode: AccessConfiguration["mode"];
    status: "enabled" | "maintenance";
  };
}

interface WindowState {
  startedAt: number;
  count: number;
}
export const bearerPattern = /^Bearer ([A-Za-z0-9_-]{43,256})$/u;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function equalDigest(candidate: Buffer, expected: string): boolean {
  const expectedBuffer = Buffer.from(expected, "hex");
  return (
    expectedBuffer.length === candidate.length &&
    timingSafeEqual(candidate, expectedBuffer)
  );
}

export function createAccessController(
  configuration: Readonly<AccessConfiguration>,
  now: () => number = Date.now,
): AccessController {
  let authenticationWindow: WindowState = { startedAt: now(), count: 0 };
  const credentialWindows = new Map<string, WindowState>();
  const origin = new URL(configuration.publicOrigin);
  const adminCredentials = configuration.adminCredentials.map((credential) => ({
    ...credential,
    role: "admin" as const,
  }));

  function consume(
    current: WindowState | undefined,
    windowSeconds: number,
    maxRequests: number,
  ): { allowed: boolean; state: WindowState } {
    const timestamp = now();
    const duration = windowSeconds * 1000;
    const state =
      current === undefined || timestamp - current.startedAt >= duration
        ? { startedAt: timestamp, count: 0 }
        : current;
    if (state.count >= maxRequests) return { allowed: false, state };
    state.count += 1;
    return { allowed: true, state };
  }

  function denied(code: PublicErrorCode, status: number): AccessDecision {
    return { ok: false, code, status };
  }

  function authorize(
    request: AccessRequest,
    audience: AccessAudience,
  ): AccessDecision {
    if (configuration.mode === "localhost-validation")
      return audience === "student" ? { ok: true } : denied("NOT_FOUND", 404);
    if (
      configuration.requireForwardedHttps &&
      (request.forwardedProto !== "https" ||
        request.forwardedHost !== origin.host)
    )
      return denied("FORBIDDEN", 403);
    if (request.origin !== undefined && request.origin !== origin.origin)
      return denied("FORBIDDEN", 403);

    const match = request.authorization?.match(bearerPattern);
    const rejectAuthentication = () => {
      const authentication = consume(
        authenticationWindow,
        configuration.authenticationRateLimit.windowSeconds,
        configuration.authenticationRateLimit.maxRequests,
      );
      authenticationWindow = authentication.state;
      return authentication.allowed
        ? denied("UNAUTHENTICATED", 401)
        : denied("RATE_LIMITED", 429);
    };
    if (!match) return rejectAuthentication();
    const candidate = digest(match[1]!);
    const credentials =
      audience === "admin"
        ? adminCredentials
        : audience === "control"
          ? [
              ...configuration.credentials.filter(
                (candidate) => candidate.role === "instructor",
              ),
              ...adminCredentials,
            ]
          : configuration.credentials;
    let credential: (typeof credentials)[number] | undefined;
    for (const configured of credentials) {
      if (equalDigest(candidate, configured.tokenSha256)) {
        if (credential) return rejectAuthentication();
        credential = configured;
      }
    }
    if (
      !credential ||
      credential.revoked ||
      credential.expiresAtEpochSeconds * 1000 <= now()
    )
      return rejectAuthentication();
    if (
      audience !== "control" &&
      credential.role !== audience &&
      audience !== "student"
    )
      return denied("FORBIDDEN", 403);
    if (audience === "student" && credential.role === "admin")
      return denied("FORBIDDEN", 403);
    if (!configuration.enabled) return denied("ACCESS_DISABLED", 503);
    if (
      configuration.maintenanceMode &&
      audience !== "admin" &&
      !(audience === "control" && credential.role === "admin")
    )
      return denied("MAINTENANCE", 503);

    const limited = consume(
      credentialWindows.get(credential.id),
      configuration.credentialRateLimit.windowSeconds,
      configuration.credentialRateLimit.maxRequests,
    );
    credentialWindows.set(credential.id, limited.state);
    return limited.allowed
      ? audience === "control"
        ? {
            ok: true,
            actorRole:
              credential.role === "admin"
                ? ("ADMIN" as const)
                : ("INSTRUCTOR" as const),
          }
        : { ok: true }
      : denied("RATE_LIMITED", 429);
  }

  return Object.freeze({
    authorize,
    binding(request: AccessRequest) {
      const match = request.authorization?.match(bearerPattern);
      if (!match || !configuration.enabled || configuration.maintenanceMode)
        return;
      const matches = configuration.credentials.filter((c) =>
        equalDigest(digest(match[1]!), c.tokenSha256),
      );
      const c = matches.length === 1 ? matches[0] : undefined;
      if (
        !c ||
        c.role !== "instructor" ||
        c.revoked ||
        c.expiresAtEpochSeconds * 1000 <= now()
      )
        return;
      return {
        courseScopes: [...c.courseScopes],
        expires: c.expiresAtEpochSeconds * 1000,
      };
    },
    isReady: () =>
      configuration.mode !== "institution-approved" &&
      configuration.enabled &&
      !configuration.maintenanceMode,
    status: () =>
      ({
        contractVersion: "access-status.v1",
        mode: configuration.mode,
        status: configuration.maintenanceMode ? "maintenance" : "enabled",
      }) as const,
  });
}
