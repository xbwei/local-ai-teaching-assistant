import type { Request, Response } from "express";
import type { AccessConfiguration } from "@laita/contracts/server";

/** Transport protection for the restricted Owner entry, not an identity service.
 * The loopback proxy and actual Owner-only network policy are deployment gates.
 */
export function createOwnerTransport(
  configuration: AccessConfiguration,
  now = Date.now,
) {
  const origin = new URL(configuration.publicOrigin);
  let closed = false,
    count = 0,
    window = now();
  return {
    authenticate(req: Request, res: Response) {
      const mutation = req.method !== "GET";
      if (
        closed ||
        !configuration.enabled ||
        configuration.maintenanceMode ||
        configuration.mode !== "single-operator" ||
        req.get("x-forwarded-proto") !== "https" ||
        req.get("x-forwarded-host") !== origin.host ||
        (req.get("origin") !== undefined &&
          req.get("origin") !== origin.origin) ||
        (mutation && req.get("origin") !== origin.origin) ||
        (req.get("sec-fetch-site") &&
          req.get("sec-fetch-site") !== "same-origin") ||
        req.get("authorization") ||
        req.get("content-encoding") ||
        Object.keys(req.query).length
      ) {
        res.status(403).json({ code: "FORBIDDEN" });
        return false as const;
      }
      if (now() - window >= 60_000) {
        count = 0;
        window = now();
      }
      if (++count > 600) {
        res.status(429).json({ code: "RATE_LIMITED" });
        return false as const;
      }
      const owner = req.get("x-owner-client");
      if (!owner || !/^[a-f0-9]{64}$/u.test(owner)) {
        res.status(403).json({ code: "FORBIDDEN" });
        return false as const;
      }
      return { owner };
    },
    close() {
      closed = true;
    },
  };
}
