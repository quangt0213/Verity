import helmet from "@fastify/helmet";
import Fastify, { type FastifyInstance } from "fastify";
import { createAuth, type Auth } from "./auth/auth";
import { createMailer, type Mailer } from "./auth/mailer";
import type { AppConfig } from "./config";
import type { Database } from "./db/client";
import { genReqId, loggerOptions } from "./logging";
import { authRoutes } from "./routes/auth";
import { contributionRoutes } from "./routes/contributions";
import { internalRoutes } from "./routes/internal";
import { publicRoutes } from "./routes/public";
import { registerErrorHandling } from "./security/errors";
import { registerCors } from "./security/origin";
import { RateLimiter } from "./security/rate-limit";

export interface AppDeps {
  config: AppConfig;
  db: Database;
  auth: Auth;
  limiter: RateLimiter;
}

/** Small JSON payloads only: the largest legitimate body is a report (~3 KB). */
export const BODY_LIMIT_BYTES = 16 * 1024;

export async function buildApp(options: { config: AppConfig; db: Database; mailer?: Mailer }): Promise<FastifyInstance> {
  const { config, db } = options;
  const app = Fastify({
    logger: loggerOptions(config.logLevel),
    genReqId,
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: config.trustProxy,
    // Reject __proto__/constructor payloads outright.
    onProtoPoisoning: "error",
    onConstructorPoisoning: "error",
  });

  await app.register(helmet, {
    // JSON API: nothing may be framed, scripted or embedded from these responses.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] },
    },
    frameguard: { action: "deny" },
    crossOriginResourcePolicy: { policy: "cross-origin" },
    referrerPolicy: { policy: "no-referrer" },
    hsts: config.env === "production" ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });
  app.addHook("onSend", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
    reply.header("Cache-Control", "no-store");
    reply.header("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=()");
  });

  registerErrorHandling(app);
  await registerCors(app, config.allowedOrigins);

  const mailer = options.mailer ?? createMailer(config);
  const deps: AppDeps = {
    config,
    db,
    auth: createAuth({ db, config, mailer, log: app.log }),
    limiter: new RateLimiter(db, config.sessionSecret),
  };

  await app.register(async (scope) => publicRoutes(scope, deps));
  await app.register(async (scope) => authRoutes(scope, deps));
  await app.register(async (scope) => contributionRoutes(scope, deps));
  await app.register(async (scope) => internalRoutes(scope, deps));
  return app;
}
