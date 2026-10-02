import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, emailOTP } from "better-auth/plugins";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config";
import type { Database } from "../db/client";
import { authAccounts, authSessions, authVerifications, users } from "../db/schema";
import type { Mailer } from "./mailer";

export const SESSION_TTL_SECONDS = 30 * 24 * 3600;

/**
 * Verity's own authentication, built on Better Auth (a maintained TypeScript
 * auth library) rather than hand-rolled code:
 *  - passwordless email one-time codes (6 digits, 10 min, 5 attempts, stored hashed);
 *  - opaque, signed bearer session tokens (no cookies: the app runs in a
 *    third-party Maypop iframe, where cookies to another site are unreliable);
 *  - sessions in Postgres, 30-day sliding expiry, revocable.
 *
 * Better Auth's own HTTP router is NOT exposed. Verity calls it server-side
 * from its /api/v1/auth routes, which add validation and rate limits.
 * Maypop identity plays no part in any of this.
 */
export function createAuth(deps: { db: Database; config: AppConfig; mailer: Mailer; log: FastifyBaseLogger }) {
  const { db, config, mailer, log } = deps;
  return betterAuth({
    appName: "Verity",
    baseURL: config.publicUrl,
    basePath: "/api/v1/auth/_internal",
    secret: config.sessionSecret,
    database: drizzleAdapter(db as never, {
      provider: "pg",
      schema: { user: users, session: authSessions, account: authAccounts, verification: authVerifications },
    }),
    trustedOrigins: config.allowedOrigins,
    telemetry: { enabled: false },
    emailAndPassword: { enabled: false },
    session: { expiresIn: SESSION_TTL_SECONDS, updateAge: 24 * 3600 },
    // Verity's routes apply their own Postgres-backed limits per email and per network.
    rateLimit: { enabled: false },
    advanced: {
      ipAddress: { disableIpTracking: true },
      database: { generateId: "uuid" },
    },
    // Data minimization: sessions never store IP addresses or user agents.
    databaseHooks: {
      session: {
        create: { before: async (session) => ({ data: { ...session, ipAddress: null, userAgent: null } }) },
        update: { before: async (session) => ({ data: { ...session, ipAddress: null, userAgent: null } }) },
      },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 5,
        storeOTP: "hashed",
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== "sign-in") return;
          // Not awaited: response timing must not reveal delivery outcomes.
          void mailer.sendSignInCode({ to: email, code: otp }).catch((err: unknown) => {
            log.error({ err: err instanceof Error ? err.message : "unknown" }, "sign-in email delivery failed");
          });
        },
      }),
      bearer({ requireSignature: true }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
