import { SIGNAL_GROUP, type SignalResult, type SignalType } from "@verity/contracts";
import { and, eq } from "drizzle-orm";
import type { Database, Queryable } from "../db/client";
import { communitySignals, eventFollows, events } from "../db/schema";
import { ApiError, notFound } from "../security/errors";
import { enqueueVerification } from "./outbox";

const ENDED = new Set(["RESOLVED", "REJECTED"]);
const TRIGGERS_REVERIFICATION = new Set<SignalType>(["DISPUTE", "NO_LONGER_HAPPENING"]);

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth++) {
    if (typeof current === "object" && "code" in current && (current as { code?: unknown }).code === "23505") return true;
    current = typeof current === "object" && "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/**
 * Record one person's answer. A newer answer to the same question supersedes
 * their older one (history kept, only one active). Repeating the same answer
 * is a no-op, so counts can't be inflated. Signals NEVER change the event's
 * status; disputes and "no longer happening" only queue re-verification.
 */
export async function recordSignal(db: Database, userId: string, eventId: string, type: SignalType, now = new Date()): Promise<SignalResult> {
  const attempt = () =>
    db.transaction(async (tx) => {
      const [event] = await tx.select({ status: events.status }).from(events).where(eq(events.id, eventId)).limit(1);
      if (!event) throw notFound("Event not found.");
      if (ENDED.has(event.status)) throw new ApiError(409, "conflict", "This event has ended, so it no longer takes answers.");

      const group = SIGNAL_GROUP[type];
      const [existing] = await tx
        .select({ id: communitySignals.id, type: communitySignals.type })
        .from(communitySignals)
        .where(
          and(
            eq(communitySignals.eventId, eventId),
            eq(communitySignals.userId, userId),
            eq(communitySignals.signalGroup, group),
            eq(communitySignals.active, true),
          ),
        )
        .for("update");
      if (existing?.type === type) return { type, changed: false };

      if (existing) {
        await tx.update(communitySignals).set({ active: false, supersededAt: now }).where(eq(communitySignals.id, existing.id));
      }
      const [inserted] = await tx
        .insert(communitySignals)
        .values({ eventId, userId, type, signalGroup: group, active: true, createdAt: now })
        .returning({ id: communitySignals.id });

      if (TRIGGERS_REVERIFICATION.has(type)) {
        await enqueueVerification(tx, { eventId, reason: "COMMUNITY_DISPUTE", idempotencyKey: `verify:signal:${inserted!.id}` });
      }
      return { type, changed: true };
    });

  try {
    return await attempt();
  } catch (error) {
    // Two simultaneous first answers from the same person: the unique index
    // keeps one; retrying sees it and supersedes or no-ops correctly.
    if (isUniqueViolation(error)) return attempt();
    throw error;
  }
}

export async function mySignals(db: Queryable, userId: string, eventId: string) {
  const rows = await db
    .select({ type: communitySignals.type, createdAt: communitySignals.createdAt })
    .from(communitySignals)
    .where(and(eq(communitySignals.eventId, eventId), eq(communitySignals.userId, userId), eq(communitySignals.active, true)));
  return rows.map((r) => ({ type: r.type as SignalType, created_at: r.createdAt.toISOString() }));
}

export async function follow(db: Queryable, userId: string, eventId: string): Promise<void> {
  await db.insert(eventFollows).values({ userId, eventId }).onConflictDoNothing();
}

export async function unfollow(db: Queryable, userId: string, eventId: string): Promise<void> {
  await db.delete(eventFollows).where(and(eq(eventFollows.userId, userId), eq(eventFollows.eventId, eventId)));
}
