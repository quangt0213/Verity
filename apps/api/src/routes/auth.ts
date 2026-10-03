import { authStartInputSchema, authVerifyInputSchema, maskEmail } from "@verity/contracts";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app";
import { bearerToken, requireIdentity } from "../auth/identity";
import { users } from "../db/schema";
import { ApiError, parseInput } from "../security/errors";
import { RATE_LIMITS } from "../security/rate-limit";

function authErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const body = (error as { body?: { code?: unknown } }).body;
  return typeof body?.code === "string" ? body.code : null;
}

/**
 * Passwordless sign-in: email → 6-digit code → bearer session token.
 * The response never reveals whether an email already has an account.
 */
export async function authRoutes(app: FastifyInstance, { db, auth, limiter }: AppDeps) {
  app.post("/api/v1/auth/email/start", async (request, reply) => {
    const { email } = parseInput(authStartInputSchema, request.body);
    await limiter.enforce([
      [RATE_LIMITS.authStartPerEmail, email],
      [RATE_LIMITS.authStartPerEmailDaily, email],
      [RATE_LIMITS.authStartPerIp, request.ip],
    ]);
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    request.log.info({ security: "auth_code_requested" }, "sign-in code requested");
    return reply.status(202).send({ sent: true });
  });

  app.post("/api/v1/auth/email/verify", async (request) => {
    const { email, code } = parseInput(authVerifyInputSchema, request.body);
    await limiter.enforce([
      [RATE_LIMITS.authVerifyPerEmail, email],
      [RATE_LIMITS.authVerifyPerIp, request.ip],
    ]);

    let result;
    try {
      result = await auth.api.signInEmailOTP({ body: { email, otp: code }, returnHeaders: true });
    } catch (error) {
      const code = authErrorCode(error);
      request.log.warn({ security: "auth_code_rejected", reason: code ?? "unknown" }, "sign-in code rejected");
      if (code === "TOO_MANY_ATTEMPTS") {
        throw new ApiError(400, "validation_failed", "Too many incorrect tries. Request a new code.", { fields: { code: "Request a new code" } });
      }
      throw new ApiError(400, "validation_failed", "That code is incorrect or has expired.", { fields: { code: "Incorrect or expired code" } });
    }

    // Signed token from the bearer plugin; the raw session token never leaves the server unsigned.
    const token = result.headers.get("set-auth-token");
    if (!token) throw new Error("Better Auth did not return a bearer token");
    const session = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
    if (!session) throw new Error("New session could not be read back");

    request.log.info({ security: "auth_signed_in" }, "signed in");
    return {
      token,
      expires_at: new Date(session.session.expiresAt).toISOString(),
      user: { email_masked: maskEmail(session.user.email), created_at: new Date(session.user.createdAt).toISOString() },
    };
  });

  app.post("/api/v1/auth/sign-out", async (request, reply) => {
    const token = bearerToken(request);
    if (token) {
      try {
        await auth.api.signOut({ headers: new Headers({ authorization: `Bearer ${token}` }) });
      } catch {
        // Already invalid: signing out is idempotent.
      }
    }
    return reply.status(204).send();
  });

  app.get("/api/v1/me", async (request) => {
    const identity = await requireIdentity(auth, request);
    const [user] = await db.select({ email: users.email, createdAt: users.createdAt }).from(users).where(eq(users.id, identity.userId));
    if (!user) throw new ApiError(401, "auth_required", "Sign in to contribute.");
    return { user: { email_masked: maskEmail(user.email), created_at: user.createdAt.toISOString() } };
  });
}
