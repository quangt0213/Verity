import type { TimelineKind, VerificationState } from "@verity/contracts";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { events, eventTimeline, verificationJobs, type JobReason } from "../db/schema";
import { DEFAULT_POLICY, type VerificationPolicy } from "../verification/policy";

/**
 * Event-side effects of verification that are NOT status changes: the
 * public verification state, quiet timeline entries and follow-up jobs.
 * Status changes go only through transitionEvent.
 */

export async function setVerificationState(tx: Tx, eventId: string, state: VerificationState, now: Date): Promise<void> {
  await tx.update(events).set({ verificationState: state, updatedAt: now }).where(eq(events.id, eventId));
}

/**
 * Add a timeline entry unless one of the same kind was added within the quiet
 * period. Verification history stays complete in verification_runs; the
 * user-facing timeline only shows what is worth reading.
 */
export async function addTimelineEntry(
  tx: Tx,
  entry: { eventId: string; kind: TimelineKind; label: string; detail?: string | null; sourceRecordId?: string | null; now: Date; quietMinutes?: number },
): Promise<boolean> {
  if (entry.quietMinutes && entry.quietMinutes > 0) {
    const since = new Date(entry.now.getTime() - entry.quietMinutes * 60_000);
    const [recent] = await tx
      .select({ id: eventTimeline.id })
      .from(eventTimeline)
      .where(and(eq(eventTimeline.eventId, entry.eventId), eq(eventTimeline.kind, entry.kind), gt(eventTimeline.at, since)))
      .orderBy(desc(eventTimeline.at))
      .limit(1);
    if (recent) return false;
  }
  await tx.insert(eventTimeline).values({
    eventId: entry.eventId,
    at: entry.now,
    kind: entry.kind,
    label: entry.label.slice(0, 300),
    detail: entry.detail ? entry.detail.slice(0, 1000) : null,
    sourceRecordId: entry.sourceRecordId ?? null,
    actorType: "system",
    createdAt: entry.now,
  });
  return true;
}

export async function recordUnavailable(tx: Tx, eventId: string, now: Date, policy: VerificationPolicy = DEFAULT_POLICY): Promise<void> {
  await setVerificationState(tx, eventId, "unavailable", now);
  await addTimelineEntry(tx, {
    eventId,
    kind: "verification_unavailable",
    label: "Verification temporarily unavailable",
    detail: "Live sources couldn't be checked. The evidence shown is unchanged and nothing new was inferred.",
    now,
    quietMinutes: policy.timeline.unavailableQuietMinutes,
  });
}

/**
 * Enqueue a worker-created job (follow-up or scheduled recheck). Idempotent,
 * and at most one open job per event (the partial unique index). Returns
 * whether a job was created.
 */
export async function enqueueWorkerJob(
  tx: Tx,
  input: { eventId: string; reason: JobReason; idempotencyKey: string; availableAt: Date; now: Date },
): Promise<boolean> {
  const inserted = await tx
    .insert(verificationJobs)
    .values({
      kind: "VERIFY_EVENT",
      eventId: input.eventId,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      availableAt: input.availableAt,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: verificationJobs.id });
  if (inserted.length === 0) {
    // An open job already exists: make sure it runs no later than requested.
    await tx
      .update(verificationJobs)
      .set({ availableAt: sql`least(${verificationJobs.availableAt}, ${input.availableAt})`, updatedAt: input.now })
      .where(and(eq(verificationJobs.eventId, input.eventId), eq(verificationJobs.status, "pending")));
  }
  return inserted.length === 1;
}
