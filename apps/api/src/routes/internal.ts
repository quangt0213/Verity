import { createHash, timingSafeEqual } from "node:crypto";
import { eventStatusSchema } from "@verity/contracts";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app";
import { eventStateTransitions, verificationJobs } from "../db/schema";
import { TransitionError, transitionEvent } from "../domain/transitions";
import { ApiError, parseInput } from "../security/errors";
import { parseEventId } from "./public";

const transitionInput = z.strictObject({
  to: eventStatusSchema,
  reason: z.string().trim().min(3).max(500),
  expected_from: eventStatusSchema.optional(),
});

function tokenMatches(expected: string, provided: string): boolean {
  // Compare fixed-length digests so neither length nor content leaks through timing.
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

/**
 * Operator/worker endpoints. Disabled unless INTERNAL_API_TOKEN is set; never
 * reachable from browsers (requests carrying an Origin header are refused, and
 * the token is not a user session).
 */
export async function internalRoutes(app: FastifyInstance, { db, config }: AppDeps) {
  const token = config.internalApiToken;

  function guard(request: FastifyRequest) {
    if (!token) throw new ApiError(404, "not_found", "Not found.");
    if (request.headers.origin !== undefined) throw new ApiError(403, "forbidden", "Not available to browsers.");
    const header = request.headers.authorization;
    const provided = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!tokenMatches(token, provided)) throw new ApiError(401, "auth_required", "Invalid internal token.");
  }

  app.post("/internal/v1/events/:id/transition", async (request) => {
    guard(request);
    const eventId = parseEventId(request.params);
    const input = parseInput(transitionInput, request.body);
    try {
      const result = await db.transaction((tx) =>
        transitionEvent(tx, { eventId, to: input.to, reason: input.reason, actor: { type: "admin" }, expectedFrom: input.expected_from }),
      );
      request.log.info({ audit: "manual_transition", eventId, ...result }, "manual status transition");
      return result;
    } catch (error) {
      if (error instanceof TransitionError) {
        if (error.kind === "not_found") throw new ApiError(404, "not_found", "Event not found.");
        throw new ApiError(409, "conflict", error.message);
      }
      throw error;
    }
  });

  app.get("/internal/v1/events/:id/verification-jobs", async (request) => {
    guard(request);
    const eventId = parseEventId(request.params);
    const jobs = await db
      .select({ id: verificationJobs.id, reason: verificationJobs.reason, status: verificationJobs.status, createdAt: verificationJobs.createdAt })
      .from(verificationJobs)
      .where(eq(verificationJobs.eventId, eventId))
      .orderBy(desc(verificationJobs.createdAt));
    return { jobs };
  });

  app.get("/internal/v1/events/:id/transitions", async (request) => {
    guard(request);
    const eventId = parseEventId(request.params);
    const transitions = await db
      .select({
        from: eventStateTransitions.fromStatus,
        to: eventStateTransitions.toStatus,
        reason: eventStateTransitions.reason,
        actorType: eventStateTransitions.actorType,
        createdAt: eventStateTransitions.createdAt,
      })
      .from(eventStateTransitions)
      .where(eq(eventStateTransitions.eventId, eventId))
      .orderBy(eventStateTransitions.createdAt);
    return { transitions };
  });
}
