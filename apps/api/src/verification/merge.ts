import { reconcileTimes, toEvidenceTime, type EvidenceTime } from "./dates";
import type { NormalizedEvidence, RetrievalMethod } from "./evidence";
import { DEFAULT_POLICY, type VerificationPolicy } from "./policy";

/**
 * One canonical resource is ONE evidence record. When a resource is retrieved
 * again (a recheck's search, an extraction, an agent citation), the new
 * observation is merged into the stored record instead of competing with it.
 * Pure; the worker applies the result.
 */

const published = (e: NormalizedEvidence) => toEvidenceTime(e.publishedAt, e.publishedAtPrecision);
const eventTime = (e: NormalizedEvidence) => toEvidenceTime(e.eventTimeAsReported, e.eventTimePrecision);

export function withPublished(e: NormalizedEvidence, t: EvidenceTime | null): NormalizedEvidence {
  return { ...e, publishedAt: t?.at ?? null, publishedAtPrecision: t?.precision ?? null };
}

export function withEventTime(e: NormalizedEvidence, t: EvidenceTime | null): NormalizedEvidence {
  return { ...e, eventTimeAsReported: t?.at ?? null, eventTimePrecision: t?.precision ?? null };
}

export function unionSteps(...lists: RetrievalMethod[][]): RetrievalMethod[] {
  return [...new Set(lists.flat())].slice(0, 4);
}

/** True when the record's content came from reading the page itself, not only a search snippet. */
export const isEnriched = (e: Pick<NormalizedEvidence, "retrievalSteps">) => e.retrievalSteps.includes("extract");

/**
 * Merge a fresh observation of a resource into its stored record.
 *  - Content (excerpt, stance, location) comes from the fresh observation,
 *    except that a page-derived record is never overwritten by a bare search
 *    snippet of the same page: the snippet is the weaker view of one source.
 *  - Times are reconciled: a missing value never erases a known one; a more
 *    precise consistent value wins; materially conflicting values both drop.
 *  - Provenance steps accumulate.
 * Returns null when the fresh observation adds nothing over the stored record.
 */
export function mergeWithStored(stored: NormalizedEvidence | undefined, fresh: NormalizedEvidence, policy: VerificationPolicy = DEFAULT_POLICY): NormalizedEvidence | null {
  if (!stored) return fresh;
  if (isEnriched(stored) && !isEnriched(fresh) && fresh.retrievalMethod === "search") return null;
  const tolerance = policy.timeConflictToleranceMinutes;
  let merged: NormalizedEvidence = { ...fresh, id: stored.id, retrievalSteps: unionSteps(stored.retrievalSteps, fresh.retrievalSteps) };
  merged = withPublished(merged, reconcileTimes(published(fresh), published(stored), tolerance, policy.dayPrecision).time);
  merged = withEventTime(merged, reconcileTimes(eventTime(fresh), eventTime(stored), tolerance, policy.dayPrecision).time);
  return merged;
}
