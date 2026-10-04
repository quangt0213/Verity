import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import { verificationRuns } from "../db/schema";
import type { EscalationReason } from "../verification/rules";
import { releaseBudget, reserveBudget } from "./budget";
import type { WorkerConfig } from "./config";
import { lockOwnedJob, type Lease } from "./jobs";

/**
 * One logical verification run per job. Every attempt resumes the same row,
 * so the agent slot and agent run id survive worker crashes.
 */

export type Run = typeof verificationRuns.$inferSelect;

/** Create the job's run, or resume it on a later attempt. Call inside the claim-confirming transaction. */
export async function ensureRun(tx: Tx, lease: Lease, now: Date): Promise<Run> {
  const [run] = await tx
    .insert(verificationRuns)
    .values({ jobId: lease.jobId, eventId: lease.eventId, startedAt: now, createdAt: now })
    .onConflictDoUpdate({
      target: verificationRuns.jobId,
      set: { outcome: "running", completedAt: null },
    })
    .returning();
  return run!;
}

export type SearchReservation = { status: "reserved"; amount: number; at: Date } | { status: "budget_exhausted" } | { status: "lost_lease" };

/**
 * Reserve today's search budget for this attempt and count the searches on the
 * run BEFORE calling the provider, so a crash mid-call still shows the cost.
 */
export async function reserveSearches(db: Database, lease: Lease, runId: string, config: WorkerConfig, now: Date): Promise<SearchReservation> {
  const amount = config.nimble.maxSearchesPerJob;
  return db.transaction(async (tx) => {
    if (!(await lockOwnedJob(tx, lease))) return { status: "lost_lease" } as const;
    if (!(await reserveBudget(tx, "search", amount, config.nimble.dailySearchBudget, now))) return { status: "budget_exhausted" } as const;
    await tx
      .update(verificationRuns)
      .set({ searchCount: sql`least(${verificationRuns.searchCount} + ${amount}, 50)` })
      .where(eq(verificationRuns.id, runId));
    return { status: "reserved", amount, at: now } as const;
  });
}

/** After the call: return reserved-but-unused searches to the budget and correct the run's count. */
export async function settleSearches(db: Database, runId: string, reservation: { amount: number; at: Date }, performed: number): Promise<void> {
  const unused = Math.max(0, reservation.amount - Math.max(0, performed));
  if (unused === 0) return;
  await db.transaction(async (tx) => {
    await releaseBudget(tx, "search", unused, reservation.at);
    await tx
      .update(verificationRuns)
      .set({ searchCount: sql`greatest(${verificationRuns.searchCount} - ${unused}, 0)` })
      .where(eq(verificationRuns.id, runId));
  });
}

export type ExtractReservation = { status: "reserved" } | { status: "budget_exhausted" } | { status: "lost_lease" };

/**
 * Reserve ONE page extraction: today's budget and the run's extract_count are
 * taken before the provider is called, so a crash mid-call still shows the
 * cost. Unlike searches, an extraction is never handed back: a call that may
 * have reached the provider is counted.
 */
export async function reserveExtract(db: Database, lease: Lease, runId: string, config: WorkerConfig, now: Date): Promise<ExtractReservation> {
  return db.transaction(async (tx) => {
    if (!(await lockOwnedJob(tx, lease))) return { status: "lost_lease" } as const;
    if (!(await reserveBudget(tx, "extract", 1, config.nimble.dailyExtractBudget, now))) return { status: "budget_exhausted" } as const;
    await tx
      .update(verificationRuns)
      .set({ extractCount: sql`least(${verificationRuns.extractCount} + 1, 50)` })
      .where(eq(verificationRuns.id, runId));
    return { status: "reserved" } as const;
  });
}

export type AgentSlot =
  | { status: "claimed" }
  /** Already claimed by an earlier attempt of this run: never buy a second investigation. */
  | { status: "already_claimed" }
  | { status: "cooldown" | "lifetime_cap" | "budget_exhausted" | "lost_lease" };

/**
 * Claim the run's single agent investigation BEFORE calling the provider. All
 * limits are checked and the slot is taken in one transaction, fenced on the
 * lease; any failure rolls back the budget reservation too.
 */
export async function claimAgentSlot(
  db: Database,
  input: { lease: Lease; runId: string; reason: EscalationReason; config: WorkerConfig; now: Date },
): Promise<AgentSlot> {
  const { lease, config, now } = input;
  const rollback = new Error("slot not claimed");
  let outcome: AgentSlot = { status: "already_claimed" };
  try {
    await db.transaction(async (tx) => {
      if (!(await lockOwnedJob(tx, lease))) return void (outcome = { status: "lost_lease" });
      const [run] = await tx.select().from(verificationRuns).where(eq(verificationRuns.id, input.runId)).for("update");
      if (!run || run.agentRequestedAt) return void (outcome = { status: "already_claimed" });

      const cooldownStart = new Date(now.getTime() - config.nimble.agentEventCooldownHours * 60 * 60_000);
      const [recent] = await tx
        .select({ n: count() })
        .from(verificationRuns)
        .where(and(eq(verificationRuns.eventId, lease.eventId), gt(verificationRuns.agentRequestedAt, cooldownStart)));
      if ((recent?.n ?? 0) > 0) return void (outcome = { status: "cooldown" });

      const [lifetime] = await tx
        .select({ n: count() })
        .from(verificationRuns)
        .where(and(eq(verificationRuns.eventId, lease.eventId), eq(verificationRuns.agentRunCount, 1)));
      if ((lifetime?.n ?? 0) >= config.nimble.agentMaxPerEvent) return void (outcome = { status: "lifetime_cap" });

      if (!(await reserveBudget(tx, "agent", 1, config.nimble.dailyAgentBudget, now))) return void (outcome = { status: "budget_exhausted" });

      const claimed = await tx
        .update(verificationRuns)
        .set({ agentRunCount: 1, agentRequestedAt: now, escalationReason: input.reason })
        .where(and(eq(verificationRuns.id, input.runId), isNull(verificationRuns.agentRequestedAt)))
        .returning({ id: verificationRuns.id });
      if (claimed.length !== 1) throw rollback;
      outcome = { status: "claimed" };
    });
  } catch (error) {
    if (error !== rollback) throw error;
    outcome = { status: "already_claimed" };
  }
  return outcome;
}

/** Save the provider's run id as soon as it is known (not lease-fenced: the id is worth keeping regardless). */
export async function saveAgentRunId(db: Database, runId: string, agentRunId: string): Promise<void> {
  await db
    .update(verificationRuns)
    .set({ agentRunId: agentRunId.slice(0, 128) })
    .where(and(eq(verificationRuns.id, runId), isNull(verificationRuns.agentRunId)));
}
