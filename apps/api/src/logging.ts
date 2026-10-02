import { randomUUID } from "node:crypto";
import type { FastifyServerOptions } from "fastify";

/**
 * Structured JSON logs with a request id on every line. Secrets and personal
 * data are redacted or never logged: no Authorization headers, no tokens or
 * sign-in codes, no request bodies, no raw IP addresses, no coordinates.
 *
 * Phase 3 can ship these logs (and OpenTelemetry spans) to RawTree without
 * changing call sites.
 */
export function loggerOptions(level: string): FastifyServerOptions["logger"] {
  return {
    level,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
        'res.headers["set-auth-token"]',
        "*.token",
        "*.code",
        "*.otp",
        "*.email",
        "*.password",
        "*.secret",
      ],
      censor: "[redacted]",
    },
    serializers: {
      // Only method, path and request id: no query strings (may contain locations), no IPs.
      req: (req: { id: string; method: string; url: string }) => ({
        id: req.id,
        method: req.method,
        path: req.url.split("?")[0],
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  };
}

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Accept a caller's correlation id only if it's well-formed; otherwise mint one. */
export function genReqId(req: { headers: Record<string, string | string[] | undefined> }): string {
  const incoming = req.headers["x-request-id"];
  return typeof incoming === "string" && REQUEST_ID.test(incoming) ? incoming : randomUUID();
}
