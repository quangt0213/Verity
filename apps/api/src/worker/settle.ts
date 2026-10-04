import { and, eq, lt } from "drizzle-orm";
import type { Database } from "../db/client";
import { verificationJobs, verificationRuns } from "../db/schema";
import { budgetResumeAt, DEFAULT_POLICY, retryDelaySeconds, type VerificationPolicy } from "../verification/policy";
import { recordUnavailable, setVerificationState } from "./effects";
import { expiredLeases, lockOwnedJob, ownedBy, type Lease } from "./jobs";

/**
 * Ending an attempt WITHOUT applying evidence: retries, permanent failures,
 * budget deferrals and expired leases. None of these is evidence, so none of
 * them can change an event's status: they touch only the job, the run, the
 * public verification_state and (quietly) the timeline.
 */

export type FailureKind = "transient" | "permanent";
export type SettleOutcome = "retry_scheduled" | "failed" | "deferred" | "lost_lease";

const code = (value: string) => value.replace(/[^a-z0-9_]/gi, "_").slice(0, 64) || "error";

export async function settleFailure(
  db: Database,
  lease: Lease,
  input: { kind: FailureKind; errorCode: string; retryAfterSeconds?: number | null; now: Date; random?: () => number; policy?: VerificationPolicy; leaseCutoff?: Date },
): Promise<SettleOutcome> {
  const policy = input.policy ?? DEFAULT_POLICY;
  const errorCode = code(input.errorCode);
  return db.transaction(async (tx) => {
    // Reaping passes leaseCutoff so a worker that heartbeat in the meantime keeps its job.
    const fence = input.leaseCutoff ? and(ownedBy(lease), lt(verificationJobs.lockedAt, input.leaseCutoff)) : ownedBy(lease);
    const locked = await tx.select({ id: verificationJobs.id }).from(verificationJobs).where(fence).for("update");
    if (locked.length !== 1) return "lost_lease" as const;

    const retry = input.kind === "transient" && lease.attempt < lease.maxAttempts;
    if (retry) {
      const delay = retryDelaySeconds(lease.attempt, input.retryAfterSeconds ?? null, input.random, policy);
      await tx
        .update(verificationJobs)
        .set({ status: "pending", availableAt: new Date(input.now.getTime() + delay * 1000), lockedBy: null, lockedAt: null, lastError: errorCode, updatedAt: input.now })
        .where(eq(verificationJobs.id, lease.jobId));
      await tx.update(verificationRuns).set({ outcome: "retry_scheduled", errorCode }).where(eq(verificationRuns.jobId, lease.jobId));
      // Another attempt is coming: still queued from the public's point of view.
      await setVerificationState(tx, lease.eventId, "queued", input.now);
      return "retry_scheduled" as const;
    }

    await tx
      .update(verificationJobs)
      .set({ status: "failed", lockedBy: null, lockedAt: null, lastError: errorCode, updatedAt: input.now })
      .where(eq(verificationJobs.id, lease.jobId));
    await tx
      .update(verificationRuns)
      .set({ outcome: "failed", completedAt: input.now, errorCode })
      .where(eq(verificationRuns.jobId, lease.jobId));
    await recordUnavailable(tx, lease.eventId, input.now, policy);
    return "failed" as const;
  });
}

/**
 * Budget exhausted before any external call: defer the job. The attempt is
 * refunded (budget is not a failure of the job), and the job is not claimable
 * again until the budget window resets, so claim/defer can never spin.
 */
export async function deferForBudget(db: Database, lease: Lease, input: { now: Date; reason: string; policy?: VerificationPolicy }): Promise<SettleOutcome> {
  const resumeAt = budgetResumeAt(input.now, input.policy);
  return db.transaction(async (tx) => {
    if (!(await lockOwnedJob(tx, lease))) return "lost_lease" as const;
    await tx
      .update(verificationJobs)
      .set({ status: "pending", attempts: lease.attempt - 1, availableAt: resumeAt, lockedBy: null, lockedAt: null, lastError: code(input.reason), updatedAt: input.now })
      .where(eq(verificationJobs.id, lease.jobId));
    await tx.update(verificationRuns).set({ outcome: "deferred", errorCode: code(input.reason) }).where(eq(verificationRuns.jobId, lease.jobId));
    await setVerificationState(tx, lease.eventId, "queued", input.now);
    return "deferred" as const;
  });
}

/** Return crashed or stuck workers' jobs to the queue (with backoff), or fail them when attempts are exhausted. */
export async function reapExpiredLeases(
  db: Database,
  input: { now: Date; leaseSeconds: number; limit?: number; random?: () => number; policy?: VerificationPolicy },
): Promise<Array<{ jobId: string; outcome: SettleOutcome }>> {
  const leaseCutoff = new Date(input.now.getTime() - input.leaseSeconds * 1000);
  const expired = await expiredLeases(db, { now: input.now, leaseSeconds: input.leaseSeconds, limit: input.limit ?? 50 });
  const results: Array<{ jobId: string; outcome: SettleOutcome }> = [];
  for (const job of expired) {
    if (!job.lockedBy) continue;
    // Act as the expired lease, fenced on it AND on the lease still being expired.
    const lease: Lease = {
      jobId: job.id,
      eventId: job.eventId,
      reason: job.reason as Lease["reason"],
      workerId: job.lockedBy,
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
      claimedAt: job.lockedAt ?? input.now,
    };
    const outcome = await settleFailure(db, lease, { kind: "transient", errorCode: "lease_expired", now: input.now, random: input.random, policy: input.policy, leaseCutoff });
    results.push({ jobId: job.id, outcome });
  }
  return results;
}
