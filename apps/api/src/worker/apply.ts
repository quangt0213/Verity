import type { EventCategory, EventStatus } from "@verity/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import { communitySignals, events, reports, sourceRecords, verificationJobs, verificationRuns } from "../db/schema";
import { transitionEvent } from "../domain/transitions";
import { fromSourceRecord, toSourceRecordValues, type EvidenceRecord, type NormalizedEvidence } from "../verification/evidence";
import { assignLineages } from "../verification/lineage";
import { DEFAULT_POLICY, freshness, recheckDelayMinutes, timeMatch, type VerificationPolicy } from "../verification/policy";
import { decide, type CommunitySignals, type Decision, type Retrieval } from "../verification/rules";
import { addTimelineEntry, enqueueWorkerJob } from "./effects";
import { lockOwnedJob, type Lease } from "./jobs";

/**
 * The single atomic step that turns retrieved evidence into canonical state.
 * One transaction, fenced on the lease: lock the job and the event, upsert
 * evidence, recompute lineage and stored relevance, decide, transition (only
 * through transitionEvent), update verification metadata, record the run,
 * complete the job, and schedule what comes next.
 */

export interface ApplyInput {
  lease: Lease;
  runId: string;
  evidence: NormalizedEvidence[];
  retrieval: Retrieval;
  /** Short code for a non-fatal issue worth recording on the run (e.g. agent_outcome_unknown). */
  note: string | null;
  /**
   * What the attempt's snapshot saw. Reports are append-only and every signal
   * change inserts a row, so a higher count at apply time means something
   * arrived that this attempt never searched for (no clock comparison needed).
   */
  seen: TriggerCounts;
  now: Date;
  policy?: VerificationPolicy;
}

export type ApplyResult =
  | { outcome: "lost_lease" }
  | {
      outcome: "state_changed" | "no_change";
      decision: Decision;
      transitionId: string | null;
      newSourceIds: string[];
      followUp: boolean;
      recheckAt: Date | null;
    };

const STRONG_STATUSES = new Set<EventStatus>(["VERIFIED", "LIKELY"]);

/** Signals that call for re-verification (the same ones the API enqueues jobs for). */
const TRIGGERING_SIGNALS = ["DISPUTE", "NO_LONGER_HAPPENING"];

export interface TriggerCounts {
  reports: number;
  triggeringSignals: number;
}

export async function triggerCounts(db: Database | Tx, eventId: string): Promise<TriggerCounts> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(reports).where(eq(reports.eventId, eventId));
  const [s] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(communitySignals)
    .where(and(eq(communitySignals.eventId, eventId), inArray(communitySignals.type, TRIGGERING_SIGNALS)));
  return { reports: Number(r?.n ?? 0), triggeringSignals: Number(s?.n ?? 0) };
}

export async function activeSignals(tx: Database | Tx, eventId: string): Promise<CommunitySignals> {
  const rows = await tx
    .select({ type: communitySignals.type, n: sql<number>`count(*)::int` })
    .from(communitySignals)
    .where(and(eq(communitySignals.eventId, eventId), eq(communitySignals.active, true)))
    .groupBy(communitySignals.type);
  const by = Object.fromEntries(rows.map((r) => [r.type, Number(r.n)])) as Record<string, number>;
  return {
    confirmations: by.CONFIRM ?? 0,
    disputes: by.DISPUTE ?? 0,
    stillHappening: by.STILL_HAPPENING ?? 0,
    noLongerHappening: by.NO_LONGER_HAPPENING ?? 0,
  };
}

/** Insert new evidence or update the record for the same canonical URL. Returns ids of newly inserted records. */
async function upsertEvidence(tx: Tx, eventId: string, evidence: NormalizedEvidence[], now: Date): Promise<string[]> {
  const inserted: string[] = [];
  const seen = new Set<string>();
  for (const e of evidence) {
    if (!e.canonicalUrl || seen.has(e.canonicalUrl)) continue;
    seen.add(e.canonicalUrl);
    // Lineage is assigned after all upserts; start every new record outside independence.
    const values = toSourceRecordValues(
      { ...e, id: null, lineage: { lineageId: "unassigned", reason: "own_origin", relatedTo: null, via: null, countsAsIndependent: false } },
      eventId,
      { freshness: "unknown", timeMatch: "unclear" },
    );
    const [row] = await tx
      .insert(sourceRecords)
      .values({ ...values, createdAt: now })
      .onConflictDoUpdate({
        target: [sourceRecords.eventId, sourceRecords.sourceUrl],
        targetWhere: sql`source_url IS NOT NULL`,
        set: {
          sourceType: values.sourceType,
          sourceName: values.sourceName,
          sourceDomain: values.sourceDomain,
          publisher: values.publisher,
          // The worker merged this observation with the stored record (merge.ts), so a missing time
          // already kept the stored one; the time and its precision (in metadata) are written together.
          publishedAt: values.publishedAt,
          retrievedAt: values.retrievedAt,
          quote: values.quote,
          agentNote: values.agentNote,
          stance: values.stance,
          sourceClass: values.sourceClass,
          isPrimary: values.isPrimary,
          locationMatch: values.locationMatch,
          extractionMetadata: values.extractionMetadata,
        },
      })
      .returning({ id: sourceRecords.id, inserted: sql<boolean>`(xmax = 0)` });
    if (row?.inserted) inserted.push(row.id);
  }
  return inserted;
}

/** Recompute lineage, independence and stored relevance for every record of the event. */
async function recomputeEvidence(
  tx: Tx,
  event: { id: string; category: EventCategory; firstSeenAt: Date; scheduledStartAt: Date | null; scheduledEndAt: Date | null },
  now: Date,
  policy: VerificationPolicy,
): Promise<EvidenceRecord[]> {
  const rows = await tx.select().from(sourceRecords).where(eq(sourceRecords.eventId, event.id));
  const assigned = assignLineages(rows.map(fromSourceRecord), policy);
  // Clear independence first so the one-independent-per-lineage index holds during the updates.
  await tx.update(sourceRecords).set({ countsAsIndependent: false }).where(eq(sourceRecords.eventId, event.id));
  for (const record of assigned) {
    const judged = { freshness: freshness(record, event, now, policy), timeMatch: timeMatch(record, event, now, policy) };
    const values = toSourceRecordValues(record, event.id, judged);
    await tx
      .update(sourceRecords)
      .set({
        lineageId: values.lineageId,
        countsAsIndependent: values.countsAsIndependent,
        freshnessState: values.freshnessState,
        timeMatch: values.timeMatch,
        extractionMetadata: values.extractionMetadata,
      })
      .where(eq(sourceRecords.id, record.id!));
  }
  return assigned;
}

function newSourcesLabel(records: EvidenceRecord[], max: number): string {
  const names = [...new Set(records.map((r) => r.publisher ?? r.sourceName))].slice(0, max);
  const more = records.length - names.length;
  const list = names.join(", ") + (more > 0 ? ` and ${more} more` : "");
  return records.length === 1 ? `New source found: ${list}` : `${records.length} new sources found: ${list}`;
}

export async function applyVerification(db: Database, input: ApplyInput): Promise<ApplyResult> {
  const policy = input.policy ?? DEFAULT_POLICY;
  const { lease, now } = input;

  return db.transaction(async (tx): Promise<ApplyResult> => {
    if (!(await lockOwnedJob(tx, lease))) return { outcome: "lost_lease" };
    const [event] = await tx.select().from(events).where(eq(events.id, lease.eventId)).for("update");
    if (!event) throw new Error("event_missing");
    const timed = {
      id: event.id,
      category: event.category as EventCategory,
      firstSeenAt: event.firstSeenAt,
      scheduledStartAt: event.scheduledStartAt,
      scheduledEndAt: event.scheduledEndAt,
    };

    const newIds = await upsertEvidence(tx, event.id, input.evidence, now);
    const records = await recomputeEvidence(tx, timed, now, policy);
    const current = event.status as EventStatus;
    const decision = decide({
      event: { ...timed, status: current },
      evidence: records,
      community: await activeSignals(tx, event.id),
      retrieval: input.retrieval,
      now,
      policy,
    });

    let transitionId: string | null = null;
    if (decision.target && decision.actor) {
      const result = await transitionEvent(tx, {
        eventId: event.id,
        to: decision.target,
        reason: `[${decision.ruleId}] ${decision.explanation}`.slice(0, 500),
        actor: { type: decision.actor },
        expectedFrom: current,
        timelineDetail: decision.explanation,
      });
      transitionId = result.transitionId;
    }
    const finalStatus = decision.target ?? current;

    // Verification metadata. A reconfirmation refreshes last_verified_at
    // WITHOUT a transition: no fake VERIFIED → VERIFIED.
    const changedSummary = event.evidenceSummary !== decision.explanation;
    await tx
      .update(events)
      .set({
        lastCheckedAt: now,
        verificationState: "idle",
        evidenceSummary: decision.explanation,
        ...(decision.reconfirmed && STRONG_STATUSES.has(finalStatus) ? { lastVerifiedAt: now } : {}),
        ...(transitionId || newIds.length > 0 || changedSummary ? { lastUpdatedAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(events.id, event.id));

    // User-facing timeline: what changed, quietly.
    const added = records.filter((r) => r.id && newIds.includes(r.id) && r.sourceType !== "community_report");
    const contradicting = added.filter((r) => r.stance === "contradicts");
    const others = added.filter((r) => r.stance !== "contradicts");
    const max = policy.timeline.maxSourceNamesPerEntry;
    if (others.length > 0) {
      await addTimelineEntry(tx, { eventId: event.id, kind: "source_found", label: newSourcesLabel(others, max), sourceRecordId: others[0]!.id, now });
    }
    if (contradicting.length > 0) {
      await addTimelineEntry(tx, {
        eventId: event.id,
        kind: "contradiction_found",
        label: contradicting.length === 1 ? "A source contradicts this report" : `${contradicting.length} sources contradict this report`,
        sourceRecordId: contradicting[0]!.id,
        now,
      });
    }
    if (!transitionId && added.length === 0) {
      await addTimelineEntry(tx, {
        eventId: event.id,
        kind: "checked_no_change",
        label: decision.reconfirmed
          ? "Checked again: the evidence still supports this"
          : input.retrieval === "no_results"
            ? "Checked again: no new sources"
            : "Checked again: no change",
        now,
        quietMinutes: policy.timeline.checkedQuietMinutes,
      });
    }

    // Complete the run and the job.
    await tx
      .update(verificationRuns)
      .set({
        outcome: transitionId ? "state_changed" : "no_change",
        completedAt: now,
        decisionRuleId: decision.ruleId,
        transitionId,
        evidenceIds: decision.evidenceIds.slice(0, 200),
        errorCode: input.note ? input.note.slice(0, 64) : null,
      })
      .where(eq(verificationRuns.id, input.runId));
    await tx
      .update(verificationJobs)
      .set({ status: "succeeded", lockedBy: null, lockedAt: null, lastError: null, updatedAt: now })
      .where(eq(verificationJobs.id, lease.jobId));

    // Lost wakeup: a report or dispute that arrived while this attempt ran
    // could not enqueue its own job (this one was open). Catch it here.
    const nowCounts = await triggerCounts(tx, event.id);
    const newReport = nowCounts.reports > input.seen.reports;
    const newSignal = nowCounts.triggeringSignals > input.seen.triggeringSignals;
    const followUp = newReport || newSignal;

    let recheckAt: Date | null = null;
    if (followUp) {
      await enqueueWorkerJob(tx, {
        eventId: event.id,
        reason: newReport ? "REPORT_ATTACHED" : "COMMUNITY_DISPUTE",
        idempotencyKey: `followup:${lease.jobId}`,
        availableAt: now,
        now,
      });
      await tx.update(events).set({ verificationState: "queued" }).where(eq(events.id, event.id));
    } else {
      const delay = recheckDelayMinutes(finalStatus, timed, now, policy);
      if (delay !== null) {
        recheckAt = new Date(now.getTime() + delay * 60_000);
        await scheduleRecheck(tx, event.id, recheckAt, now, policy);
      }
    }

    return { outcome: transitionId ? "state_changed" : "no_change", decision, transitionId, newSourceIds: newIds, followUp, recheckAt };
  });
}

/**
 * Schedule a RECHECK through the outbox. The idempotency key is bucketed in
 * time, so different paths asking for "a recheck around then" create one job.
 */
export async function scheduleRecheck(tx: Tx, eventId: string, at: Date, now: Date, policy: VerificationPolicy = DEFAULT_POLICY): Promise<boolean> {
  const bucketMs = policy.recheckMinutes.unconfirmed * 60_000;
  return enqueueWorkerJob(tx, {
    eventId,
    reason: "RECHECK",
    idempotencyKey: `recheck:${eventId}:${Math.floor(at.getTime() / bucketMs)}`,
    availableAt: at,
    now,
  });
}
