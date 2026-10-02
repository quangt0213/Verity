import cors from "@fastify/cors";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "./errors";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CORS: an exact-origin allowlist, never "*". Authentication uses bearer tokens
 * (no cookies), so credentials are not enabled and browsers never attach
 * ambient credentials to cross-site requests.
 *
 * CORS is not authentication; it only tells browsers which pages may read
 * responses. Every protected route still requires a valid Verity session.
 */
export async function registerCors(app: FastifyInstance, allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins);
  await app.register(cors, {
    origin: (origin, callback) => callback(null, origin !== undefined && allowed.has(origin)),
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id", "Retry-After"],
    credentials: false,
    maxAge: 600,
    strictPreflight: true,
  });

  // Defense in depth for state-changing requests: a browser request from an
  // origin that isn't allowlisted is refused outright, even if it somehow
  // avoided a preflight. Requests without an Origin header (curl, servers) are
  // not browsers acting on a user's behalf and still need a bearer token.
  app.addHook("onRequest", async (request: FastifyRequest) => {
    if (!MUTATING.has(request.method)) return;
    const origin = request.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) {
      request.log.warn({ security: "origin_rejected", origin: origin.slice(0, 200) }, "rejected request from disallowed origin");
      throw new ApiError(403, "forbidden", "This origin is not allowed.");
    }
  });
}
