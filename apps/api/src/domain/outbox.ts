import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { events, verificationJobs, type JobReason } from "../db/schema";

/**
 * Record that an event needs verification, inside the caller's transaction.
 * No external call happens here: a worker (Phase 3) picks up pending jobs
 * after commit. Duplicate work is avoided twice over: per-trigger idempotency
 * keys, and at most one open job per event (partial unique index).
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

  // Reflect "queued" publicly unless verification is already queued or running.
  await tx
    .update(events)
    .set({ verificationState: "queued", updatedAt: sql`now()` })
    .where(and(eq(events.id, input.eventId), inArray(events.verificationState, ["idle", "unavailable"])));

  return { enqueued: inserted.length > 0 };
}
