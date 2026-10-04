import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { events, verificationJobs, type JobReason } from "../db/schema";

/**
 * Record that an event needs verification, inside the caller's transaction.
 * No external call happens here: the worker picks up pending jobs after
 * commit. Duplicate work is avoided twice over: per-trigger idempotency keys,
 * and at most one open job per event (partial unique index). Cost therefore
 * scales with events, not reports.
 *
 * When the event already has a PENDING job (e.g. a recheck scheduled for later),
 * the new trigger pulls it forward to now instead of being lost. A trigger that
 * arrives while a job is RUNNING is caught by the worker, which enqueues a
 * follow-up when it finishes.
 */
export async function enqueueVerification(
  tx: Tx,
  input: { eventId: string; reason: JobReason; idempotencyKey: string },
): Promise<{ enqueued: boolean }> {
  const inserted = await tx
    .insert(verificationJobs)
    .values({ kind: "VERIFY_EVENT", eventId: input.eventId, reason: input.reason, idempotencyKey: input.idempotencyKey })
    .onConflictDoNothing()
    .returning({ id: verificationJobs.id });

  if (inserted.length === 0) {
    await tx
      .update(verificationJobs)
      .set({ availableAt: sql`least(${verificationJobs.availableAt}, now())`, updatedAt: sql`now()` })
      .where(and(eq(verificationJobs.eventId, input.eventId), eq(verificationJobs.status, "pending")));
  }

  // Reflect "queued" publicly unless verification is already queued or running.
  await tx
    .update(events)
    .set({ verificationState: "queued", updatedAt: sql`now()` })
    .where(and(eq(events.id, input.eventId), inArray(events.verificationState, ["idle", "unavailable"])));

  return { enqueued: inserted.length > 0 };
}
