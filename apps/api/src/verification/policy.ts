import { CATEGORY_KIND, type EventCategory, type EventStatus, type SourceClass } from "@verity/contracts";

/**
 * THE verification policy: every duration and threshold the verification
 * engine and worker use lives here, nowhere else.
 *
 * All values are INITIAL PRODUCT HEURISTICS, chosen as reasonable starting
 * points, not established truths. They must be calibrated against real Verity
 * events (how long a crash report really stays accurate, how far ahead festival
 * coverage appears, and so on). Change them here, with tests, and bump
 * `version` so verification runs can be traced to the policy that produced them.
 */

export interface DisruptionWindows {
  /** Evidence about the event this old (by event or publication time) is fresh. */
  freshMinutes: number;
  /** ...and stale beyond this. In between it is "aging": still counted, no longer fresh. */
  staleMinutes: number;
}

export interface CategoryPolicy extends DisruptionWindows {
  /** Stop scheduled rechecks this long after the event was first seen. */
  maxRecheckAgeHours: number;
}

export interface VerificationPolicy {
  version: string;
  categories: Record<EventCategory, CategoryPolicy>;
  /** Planned events with a schedule are judged against it rather than the windows above. */
  planned: {
    /** Coverage published this long before the scheduled start still describes this occurrence. */
    announcementLeadDays: number;
    /** After the scheduled end plus this, the event is treated as over. */
    endGraceMinutes: number;
    /** Stop rechecks this long after the scheduled end. */
    recheckAfterEndHours: number;
  };
  /**
   * Evidence whose event/publication time is earlier than the event's first
   * sighting by more than this is about an earlier incident ("outdated").
   * Disruptions only: planned events use announcementLeadDays.
   */
  outdatedLeadMinutes: number;
  /** Rechecks, in minutes, by how settled the event is. */
  recheckMinutes: { unconfirmed: number; unconfirmedAfter2h: number; confirmed: number; contested: number };
  lineage: {
    /** Token-set similarity (0..1) at or above which two texts are near-duplicates. */
    nearDuplicateSimilarity: number;
    /** Texts with fewer distinct tokens are too short to call duplicates. */
    nearDuplicateMinTokens: number;
  };
  /** Transient-failure retries: base · factor^(attempt-1) seconds, capped, ± jitter. */
  retry: { baseSeconds: number; factor: number; maxSeconds: number; jitterRatio: number };
  /** A job deferred for budget waits until the budget window resets, but never less than this. */
  budgetDeferMinMinutes: number;
  /** Reverse-geocode cache lifetimes (providers such as public Nominatim require caching). */
  geocodeCache: { okTtlDays: number; noResultTtlDays: number };
  /** Quiet periods so frequent rechecks don't flood the user-facing timeline (verification_runs keeps everything). */
  timeline: { checkedQuietMinutes: number; unavailableQuietMinutes: number; maxSourceNamesPerEntry: number };
  /** The no-cost aging sweep. */
  sweep: { intervalMinutes: number; batchSize: number };
  /** Timeouts for external calls made by the worker. */
  external: { searchTimeoutSeconds: number; geocodeTimeoutSeconds: number; agentPollIntervalSeconds: number };
  rules: {
    /** Independent external lineages that verify an event without a primary official source. */
    verifiedMinIndependent: number;
    /** Lineages (community counts as one) for LIKELY. */
    likelyMinLineages: number;
    /** Independent "it ended" lineages that resolve an event without a primary official one. */
    resolvedMinIndependent: number;
    /**
     * PRODUCT RULE: VERIFIED needs at least one qualifying supporting record from
     * one of these identified source classes, on top of every other requirement.
     * UNKNOWN (unidentified web pages), SOCIAL and COMMUNITY never qualify, so any
     * number of them alone can reach LIKELY at most.
     */
    verifiedSourceClasses: readonly VerifyingSourceClass[];
  };
}

/** Source classes that may ever satisfy the VERIFIED source-quality rule. */
export type VerifyingSourceClass = Exclude<SourceClass, "UNKNOWN" | "SOCIAL" | "COMMUNITY">;

const h = (hours: number) => hours * 60;
const d = (days: number) => days * 24 * 60;

export const DEFAULT_POLICY: VerificationPolicy = {
  version: "heuristics-2026-10-v2",
  categories: {
    crash: { freshMinutes: h(2), staleMinutes: h(6), maxRecheckAgeHours: 12 },
    road_closure: { freshMinutes: h(6), staleMinutes: h(24), maxRecheckAgeHours: 48 },
    flooding: { freshMinutes: h(6), staleMinutes: h(24), maxRecheckAgeHours: 72 },
    fire: { freshMinutes: h(6), staleMinutes: h(24), maxRecheckAgeHours: 72 },
    police_activity: { freshMinutes: h(2), staleMinutes: h(8), maxRecheckAgeHours: 12 },
    transit_disruption: { freshMinutes: h(2), staleMinutes: h(8), maxRecheckAgeHours: 24 },
    power_outage: { freshMinutes: h(6), staleMinutes: h(24), maxRecheckAgeHours: 72 },
    protest: { freshMinutes: h(3), staleMinutes: h(12), maxRecheckAgeHours: 24 },
    parking_traffic: { freshMinutes: h(1), staleMinutes: h(3), maxRecheckAgeHours: 6 },
    other: { freshMinutes: h(3), staleMinutes: h(12), maxRecheckAgeHours: 24 },
    // Planned categories: used only when no schedule is known.
    construction: { freshMinutes: d(3), staleMinutes: d(14), maxRecheckAgeHours: 24 * 30 },
    parade: { freshMinutes: d(1), staleMinutes: d(3), maxRecheckAgeHours: 72 },
    concert: { freshMinutes: d(1), staleMinutes: d(3), maxRecheckAgeHours: 72 },
    sporting_event: { freshMinutes: d(1), staleMinutes: d(3), maxRecheckAgeHours: 72 },
    festival: { freshMinutes: d(1), staleMinutes: d(3), maxRecheckAgeHours: 96 },
    campus_event: { freshMinutes: d(1), staleMinutes: d(3), maxRecheckAgeHours: 72 },
  },
  planned: { announcementLeadDays: 14, endGraceMinutes: 60, recheckAfterEndHours: 6 },
  outdatedLeadMinutes: h(6),
  recheckMinutes: { unconfirmed: 15, unconfirmedAfter2h: 60, confirmed: 30, contested: 20 },
  lineage: { nearDuplicateSimilarity: 0.6, nearDuplicateMinTokens: 12 },
  retry: { baseSeconds: 30, factor: 4, maxSeconds: 30 * 60, jitterRatio: 0.2 },
  budgetDeferMinMinutes: 15,
  geocodeCache: { okTtlDays: 90, noResultTtlDays: 7 },
  timeline: { checkedQuietMinutes: h(6), unavailableQuietMinutes: h(3), maxSourceNamesPerEntry: 3 },
  sweep: { intervalMinutes: 5, batchSize: 100 },
  external: { searchTimeoutSeconds: 30, geocodeTimeoutSeconds: 10, agentPollIntervalSeconds: 5 },
  rules: { verifiedMinIndependent: 2, likelyMinLineages: 2, resolvedMinIndependent: 2, verifiedSourceClasses: ["OFFICIAL", "FIRST_PARTY"] },
};

// ---------------------------------------------------------------------------
// Time relevance. Three clocks: EVENT time (when the thing happened, as the
// source describes it), PUBLICATION time, and RETRIEVAL time. Retrieval time
// never makes evidence fresh: a page fetched today may describe yesterday.
// ---------------------------------------------------------------------------

export interface TimedEvent {
  category: EventCategory;
  firstSeenAt: Date;
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;
}

export interface TimedEvidence {
  /** When the source says the event happened (as reported), if it says. */
  eventTimeAsReported: Date | null;
  publishedAt: Date | null;
  /** Present for completeness; deliberately ignored for relevance. */
  retrievedAt: Date;
}

/** "unknown": no event or publication time, so the evidence can never count as fresh. */
export type Freshness = "fresh" | "aging" | "stale" | "unknown";
export type TimeMatch = "current" | "recent" | "outdated" | "unclear";

/** The time a piece of evidence speaks for: the reported event time, else publication. Never retrieval. */
export function evidenceTime(e: TimedEvidence): Date | null {
  return e.eventTimeAsReported ?? e.publishedAt ?? null;
}

const minutesBetween = (later: Date, earlier: Date) => (later.getTime() - earlier.getTime()) / 60_000;

function hasSchedule(event: TimedEvent): event is TimedEvent & { scheduledStartAt: Date } {
  return CATEGORY_KIND[event.category] === "planned" && event.scheduledStartAt !== null;
}

/**
 * When a scheduled event is over: its KNOWN scheduled end plus grace. Null when
 * no end is known: an end is never inferred from the start time or from old
 * evidence.
 */
export function scheduledOverAt(event: TimedEvent, policy: VerificationPolicy = DEFAULT_POLICY): Date | null {
  if (!hasSchedule(event) || !event.scheduledEndAt) return null;
  return new Date(event.scheduledEndAt.getTime() + policy.planned.endGraceMinutes * 60_000);
}

export function freshness(e: TimedEvidence, event: TimedEvent, now: Date, policy: VerificationPolicy = DEFAULT_POLICY): Freshness {
  const at = evidenceTime(e);
  if (!at) return "unknown";
  if (hasSchedule(event)) {
    const over = scheduledOverAt(event, policy);
    if (over && now > over) return "stale";
    // Start known, end unknown: long after the start, coverage is no longer current.
    if (!over && minutesBetween(now, event.scheduledStartAt) > policy.categories[event.category].staleMinutes) return "stale";
    const earliest = event.scheduledStartAt.getTime() - policy.planned.announcementLeadDays * 24 * 60 * 60_000;
    return at.getTime() >= earliest ? "fresh" : "stale";
  }
  const windows = policy.categories[event.category];
  const age = minutesBetween(now, at);
  if (age <= windows.freshMinutes) return "fresh";
  if (age <= windows.staleMinutes) return "aging";
  return "stale";
}

export function timeMatch(e: TimedEvidence, event: TimedEvent, now: Date, policy: VerificationPolicy = DEFAULT_POLICY): TimeMatch {
  const at = evidenceTime(e);
  if (!at) return "unclear";
  if (hasSchedule(event)) {
    const earliest = event.scheduledStartAt.getTime() - policy.planned.announcementLeadDays * 24 * 60 * 60_000;
    return at.getTime() >= earliest ? "current" : "outdated";
  }
  // Clearly before this event was first seen: about an earlier incident.
  if (minutesBetween(event.firstSeenAt, at) > policy.outdatedLeadMinutes) return "outdated";
  return minutesBetween(now, at) <= policy.categories[event.category].freshMinutes ? "current" : "recent";
}

/**
 * Minutes until the next scheduled recheck, or null when rechecks should stop
 * (ended events, or past the category's maximum recheck age).
 */
export function recheckDelayMinutes(
  status: EventStatus,
  event: TimedEvent,
  now: Date,
  policy: VerificationPolicy = DEFAULT_POLICY,
): number | null {
  if (status === "RESOLVED" || status === "REJECTED") return null;
  if (!withinRecheckAge(event, now, policy)) return null;
  const r = policy.recheckMinutes;
  switch (status) {
    case "CONFLICTING":
      return r.contested;
    case "VERIFIED":
    case "LIKELY":
    case "STALE":
      return r.confirmed;
    case "UNVERIFIED":
    case "DEVELOPING":
      return minutesBetween(now, event.firstSeenAt) < 120 ? r.unconfirmed : r.unconfirmedAfter2h;
  }
}

/** Whether scheduled rechecks should still run for this event. */
export function withinRecheckAge(event: TimedEvent, now: Date, policy: VerificationPolicy = DEFAULT_POLICY): boolean {
  if (hasSchedule(event)) {
    const over = scheduledOverAt(event, policy);
    if (over) return now.getTime() <= over.getTime() + policy.planned.recheckAfterEndHours * 60 * 60_000;
    return minutesBetween(now, event.scheduledStartAt) <= policy.categories[event.category].maxRecheckAgeHours * 60;
  }
  return minutesBetween(now, event.firstSeenAt) <= policy.categories[event.category].maxRecheckAgeHours * 60;
}

/** Delay before retry number `attempt` (1-based) of a transient failure, honoring a provider's Retry-After. */
export function retryDelaySeconds(
  attempt: number,
  retryAfterSeconds: number | null = null,
  random: () => number = Math.random,
  policy: VerificationPolicy = DEFAULT_POLICY,
): number {
  const r = policy.retry;
  const base = Math.min(r.maxSeconds, r.baseSeconds * r.factor ** Math.max(0, attempt - 1));
  const jittered = base * (1 - r.jitterRatio + 2 * r.jitterRatio * random());
  return Math.round(Math.min(r.maxSeconds, Math.max(jittered, retryAfterSeconds ?? 0, 1)));
}

/** When a deferred job may be claimed again: the next UTC budget day, and never sooner than the minimum deferral. */
export function budgetResumeAt(now: Date, policy: VerificationPolicy = DEFAULT_POLICY): Date {
  const nextDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const minimum = new Date(now.getTime() + policy.budgetDeferMinMinutes * 60_000);
  return nextDay > minimum ? nextDay : minimum;
}

/** Expiry of a cached reverse-geocode result. */
export function geocodeExpiresAt(status: "ok" | "no_result", retrievedAt: Date, policy: VerificationPolicy = DEFAULT_POLICY): Date {
  const days = status === "ok" ? policy.geocodeCache.okTtlDays : policy.geocodeCache.noResultTtlDays;
  return new Date(retrievedAt.getTime() + days * 24 * 60 * 60_000);
}
