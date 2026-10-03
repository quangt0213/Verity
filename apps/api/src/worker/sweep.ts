import type { EventCategory, EventStatus } from "@verity/contracts";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { events, sourceRecords } from "../db/schema";
import { transitionEvent } from "../domain/transitions";
import { fromSourceRecord } from "../verification/evidence";
import { DEFAULT_POLICY, freshness, recheckDelayMinutes, timeMatch, type VerificationPolicy } from "../verification/policy";
import { decide, type RuleId } from "../verification/rules";
import { activeSignals, scheduleRecheck } from "./apply";

/**
 * The no-cost aging sweep: re-evaluates STORED evidence as time passes,
 * without contacting any provider. It is deliberately conservative. It applies
 * only two outcomes:
 *   stale_support_aged_out   → STALE    (support aged past the policy window)
 *   resolved_schedule_ended  → RESOLVED (only with an actual known scheduled end)
 * It never infers that an unscheduled incident ended because its evidence got
 * old: old evidence means STALE, and RESOLVED needs evidence that it ended.
 */

const SWEEPABLE: EventStatus[] = ["UNVERIFIED", "DEVELOPING", "LIKELY", "VERIFIED", "CONFLICTING", "STALE"];
const SWEEP_RULES = new Set<RuleId>(["stale_support_aged_out", "resolved_schedule_ended"]);

export async function sweepAging(db: Database, input: { now: Date; policy?: VerificationPolicy; limit?: number }): Promise<Array<{ eventId: string; to: EventStatus }>> {
  const policy = input.policy ?? DEFAULT_POLICY;
  const candidates = await db
    .select({ id: events.id })
    .from(events)
    .where(and(inArray(events.status, SWEEPABLE), eq(events.isDemo, false)))
    .orderBy(sql`${events.lastCheckedAt} asc nulls first`, asc(events.id))
    .limit(input.limit ?? policy.sweep.batchSize);

  const applied: Array<{ eventId: string; to: EventStatus }> = [];
  for (const { id } of candidates) {
    const result = await db.transaction(async (tx) => {
      // Skip events a worker is applying right now; they'll be swept next time.
      const [event] = await tx.select().from(events).where(eq(events.id, id)).for("update", { skipLocked: true });
      if (!event) return null;
      const timed = {
        category: event.category as EventCategory,
        firstSeenAt: event.firstSeenAt,
        scheduledStartAt: event.scheduledStartAt,
        scheduledEndAt: event.scheduledEndAt,
      };
      const rows = await tx.select().from(sourceRecords).where(eq(sourceRecords.eventId, id));
      const decision = decide({
        event: { ...timed, status: event.status as EventStatus },
        evidence: rows.map(fromSourceRecord),
        community: await activeSignals(tx, id),
        retrieval: "not_attempted",
        now: input.now,
        policy,
      });
      const allowed =
        decision.target !== null &&
        decision.actor === "system" &&
        SWEEP_RULES.has(decision.ruleId) &&
        (decision.ruleId !== "resolved_schedule_ended" || event.scheduledEndAt !== null);
      if (!allowed || !decision.target) return null;

      await transitionEvent(tx, {
        eventId: id,
        to: decision.target,
        reason: `[${decision.ruleId}] ${decision.explanation}`.slice(0, 500),
        actor: { type: "system" },
        expectedFrom: event.status as EventStatus,
        timelineDetail: decision.explanation,
      });
      // Keep the stored relevance labels (e.g. "Out of date") in step.
      for (const row of rows) {
        await tx
          .update(sourceRecords)
          .set({
            freshnessState: ((f) => (f === "unknown" ? "aging" : f))(freshness(fromSourceRecord(row), timed, input.now, policy)),
            timeMatch: timeMatch(fromSourceRecord(row), timed, input.now, policy),
          })
          .where(eq(sourceRecords.id, row.id));
      }
      await tx
        .update(events)
        .set({ evidenceSummary: decision.explanation, lastUpdatedAt: input.now, updatedAt: input.now })
        .where(eq(events.id, id));
      // A STALE event may still be re-checked against live sources within its recheck age.
      const delay = recheckDelayMinutes(decision.target, timed, input.now, policy);
      if (delay !== null) await scheduleRecheck(tx, id, new Date(input.now.getTime() + delay * 60_000), input.now, policy);
      return { eventId: id, to: decision.target };
    });
    if (result) applied.push(result);
  }
  return applied;
}
