import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import type { Database, Queryable } from "../db/client";
import { verificationJobs, type JobReason } from "../db/schema";

/**
 * Claiming and leasing verification jobs.
 *
 * A claim is one statement: lock ready pending jobs with FOR UPDATE SKIP LOCKED
 * and mark them running in the same UPDATE, so two workers (or connections)
 * can never claim the same job. The LEASE is (job id, worker id, attempt
 * number). Every later write is fenced on all three: a worker whose lease was
 * reaped, even if the same process later re-claims the job, can no longer
 * change anything.
 */

export interface Lease {
  jobId: string;
  eventId: string;
  reason: JobReason;
  workerId: string;
  /** The fencing token: attempts after this claim. */
  attempt: number;
  maxAttempts: number;
  claimedAt: Date;
}

export async function claimJobs(db: Queryable, input: { workerId: string; limit: number; now: Date }): Promise<Lease[]> {
  if (input.limit <= 0) return [];
  const ready = db
    .select({ id: verificationJobs.id })
    .from(verificationJobs)
    .where(
      and(
        eq(verificationJobs.status, "pending"),
        lte(verificationJobs.availableAt, input.now),
        lt(verificationJobs.attempts, verificationJobs.maxAttempts),
      ),
    )
    .orderBy(asc(verificationJobs.availableAt), asc(verificationJobs.createdAt))
    .limit(input.limit)
    .for("update", { skipLocked: true });

  const claimed = await db
    .update(verificationJobs)
    .set({
      status: "running",
      attempts: sql`${verificationJobs.attempts} + 1`,
      lockedBy: input.workerId,
      lockedAt: input.now,
      updatedAt: input.now,
    })
    .where(and(inArray(verificationJobs.id, ready), eq(verificationJobs.status, "pending")))
    .returning({
      id: verificationJobs.id,
      eventId: verificationJobs.eventId,
      reason: verificationJobs.reason,
      attempts: verificationJobs.attempts,
      maxAttempts: verificationJobs.maxAttempts,
    });

  return claimed.map((j) => ({
    jobId: j.id,
    eventId: j.eventId,
    reason: j.reason as JobReason,
    workerId: input.workerId,
    attempt: j.attempts,
    maxAttempts: j.maxAttempts,
    claimedAt: input.now,
  }));
}

/** SQL condition: this lease still owns the job. */
export function ownedBy(lease: Lease) {
  return and(
    eq(verificationJobs.id, lease.jobId),
    eq(verificationJobs.status, "running"),
    eq(verificationJobs.lockedBy, lease.workerId),
    eq(verificationJobs.attempts, lease.attempt),
  );
}

/** Lock the job row if (and only if) this lease still owns it. Use inside a transaction before any write. */
export async function lockOwnedJob(tx: Queryable, lease: Lease): Promise<boolean> {
  const rows = await tx.select({ id: verificationJobs.id }).from(verificationJobs).where(ownedBy(lease)).for("update");
  return rows.length === 1;
}

/** Extend the lease during long external work. False means the lease is lost: stop and change nothing. */
export async function heartbeat(db: Queryable, lease: Lease, now: Date): Promise<boolean> {
  const rows = await db
    .update(verificationJobs)
    .set({ lockedAt: now, updatedAt: now })
    .where(ownedBy(lease))
    .returning({ id: verificationJobs.id });
  return rows.length === 1;
}

/** Running jobs whose lease expired (crashed or stuck worker). */
export async function expiredLeases(db: Database, input: { now: Date; leaseSeconds: number; limit: number }) {
  const cutoff = new Date(input.now.getTime() - input.leaseSeconds * 1000);
  return db
    .select({
      id: verificationJobs.id,
      eventId: verificationJobs.eventId,
      reason: verificationJobs.reason,
      lockedBy: verificationJobs.lockedBy,
      attempts: verificationJobs.attempts,
      maxAttempts: verificationJobs.maxAttempts,
      lockedAt: verificationJobs.lockedAt,
    })
    .from(verificationJobs)
    .where(and(eq(verificationJobs.status, "running"), lt(verificationJobs.lockedAt, cutoff)))
    .limit(input.limit);
}
