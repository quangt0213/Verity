import { followingResponseSchema, reportEventInputSchema, signalInputSchema } from "@verity/contracts";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app";
import { requireIdentity } from "../auth/identity";
import { eventExists, listFollowing } from "../domain/read-model";
import { createReport } from "../domain/reports";
import { follow, mySignals, recordSignal, unfollow } from "../domain/signals";
import { notFound, parseInput } from "../security/errors";
import { RATE_LIMITS } from "../security/rate-limit";
import { parseEventId } from "./public";

/**
 * Authenticated writes. Identity always comes from the verified session; any
 * user id, role, Maypop id or name in the request is rejected by the strict
 * schemas and never read.
 */
export async function contributionRoutes(app: FastifyInstance, { db, auth, limiter }: AppDeps) {
  app.post("/api/v1/reports", async (request, reply) => {
    const identity = await requireIdentity(auth, request);
    const input = parseInput(reportEventInputSchema, request.body);
    await limiter.enforce([
      [RATE_LIMITS.reportPerUser, identity.userId],
      [RATE_LIMITS.reportPerUserDaily, identity.userId],
      [RATE_LIMITS.reportPerIp, request.ip],
    ]);
    const result = await createReport(db, identity.userId, input);
    request.log.info({ audit: "report_created", outcome: result.outcome, eventId: result.event_id }, "report stored");
    return reply.status(201).send(result);
  });

  app.post("/api/v1/events/:id/signals", async (request, reply) => {
    const identity = await requireIdentity(auth, request);
    const eventId = parseEventId(request.params);
    const { type } = parseInput(signalInputSchema, request.body);
    await limiter.enforce([
      [RATE_LIMITS.signalPerUser, identity.userId],
      [RATE_LIMITS.signalPerIp, request.ip],
    ]);
    const result = await recordSignal(db, identity.userId, eventId, type);
    return reply.status(result.changed ? 201 : 200).send(result);
  });

  app.get("/api/v1/events/:id/signals/mine", async (request) => {
    const identity = await requireIdentity(auth, request);
    const eventId = parseEventId(request.params);
    return { signals: await mySignals(db, identity.userId, eventId) };
  });

  app.post("/api/v1/events/:id/follow", async (request) => {
    const identity = await requireIdentity(auth, request);
    const eventId = parseEventId(request.params);
    await limiter.enforce([[RATE_LIMITS.followPerUser, identity.userId]]);
    if (!(await eventExists(db, eventId))) throw notFound("Event not found.");
    await follow(db, identity.userId, eventId);
    return { following: true };
  });

  app.delete("/api/v1/events/:id/follow", async (request) => {
    const identity = await requireIdentity(auth, request);
    const eventId = parseEventId(request.params);
    await limiter.enforce([[RATE_LIMITS.followPerUser, identity.userId]]);
    await unfollow(db, identity.userId, eventId);
    return { following: false };
  });

  app.get("/api/v1/me/following", async (request) => {
    const identity = await requireIdentity(auth, request);
    return followingResponseSchema.parse({ events: await listFollowing(db, identity.userId) });
  });
}
