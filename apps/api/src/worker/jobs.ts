import { and, eq, lt, sql } from "drizzle-orm";
import type { Database, Queryable } from "../db/client";
import { verificationJobs, type JobReason } from "../db/schema";

/**
 * Claiming and leasing verification jobs.
 *
 * A claim is one statement: lock at most N ready pending jobs with FOR UPDATE SKIP LOCKED
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

interface ClaimedRow {
  id: string;
  event_id: string;
  reason: string;
  attempts: number;
  max_attempts: number;
  /** Microseconds since the epoch, for ordering ties exactly (bigint arrives as a string). */
  available_us: string | number;
  created_us: string | number;
}

/**
 * Claim at most `limit` ready jobs, oldest first.
 *
 * The ready rows are locked ONCE in a MATERIALIZED CTE and then updated. The
 * earlier form, UPDATE … WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP
 * LOCKED), let the planner choose a nested-loop semi-join that re-scans the
 * locking subquery for every outer row. Each re-scan skipped the rows the same
 * statement had just updated, so one call claimed EVERY ready job whatever
 * the limit (test/worker/claim-limit.test.ts), and the worker's concurrency
 * limit was not enforced.
 */
export async function claimJobs(db: Queryable, input: { workerId: string; limit: number; now: Date }): Promise<Lease[]> {
  if (input.limit <= 0) return [];
  const now = input.now.toISOString();
  const result = (await db.execute(sql`
    with ready as materialized (
      select id from verification_jobs
      where status = 'pending' and available_at <= ${now}::timestamptz and attempts < max_attempts
      order by available_at, created_at
      limit ${Math.floor(input.limit)}
      for update skip locked
    )
    update verification_jobs j
       set status = 'running', attempts = j.attempts + 1, locked_by = ${input.workerId},
           locked_at = ${now}::timestamptz, updated_at = ${now}::timestamptz
      from ready
     where j.id = ready.id and j.status = 'pending'
    returning j.id, j.event_id, j.reason, j.attempts, j.max_attempts,
              (extract(epoch from j.available_at) * 1000000)::bigint as available_us,
              (extract(epoch from j.created_at) * 1000000)::bigint as created_us`)) as unknown as ClaimedRow[] | { rows: ClaimedRow[] };
  const rows = Array.isArray(result) ? result : result.rows;
  const order = (a: ClaimedRow, b: ClaimedRow) => {
    const byAvailable = BigInt(a.available_us) - BigInt(b.available_us);
    const byCreated = BigInt(a.created_us) - BigInt(b.created_us);
    return byAvailable !== 0n ? (byAvailable < 0n ? -1 : 1) : byCreated === 0n ? 0 : byCreated < 0n ? -1 : 1;
  };

  return [...rows].sort(order).map((j) => ({
    jobId: j.id,
    eventId: j.event_id,
    reason: j.reason as JobReason,
    workerId: input.workerId,
    attempt: Number(j.attempts),
    maxAttempts: Number(j.max_attempts),
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
