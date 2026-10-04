import { ACTIVE_STATUSES, type EventCategory, type EventStatus } from "@verity/contracts";
import { checkTransition } from "../domain/state-machine";
import type { EvidenceRecord } from "./evidence";
import { explainDecision } from "./explain";
import {
  DEFAULT_POLICY,
  evidenceBounds,
  hasDayPrecision,
  freshness,
  scheduledOverAt,
  timeMatch,
  type Freshness,
  type TimedEvent,
  type TimeMatch,
  type VerificationPolicy,
} from "./policy";

/**
 * The deterministic verification engine. A pure function of the event, its
 * stored evidence, community counts, the clock and the policy: no I/O, no
 * model output. Nimble finds evidence; this decides state.
 *
 * Invariants (each covered by tests):
 *  - community reports alone never produce VERIFIED (they are one lineage and
 *    never count as external support);
 *  - no results, timeouts and provider outages are NOT evidence: the retrieval
 *    outcome only shapes the explanation;
 *  - stale evidence is not fresh confirmation, and retrieval time never makes
 *    evidence fresh;
 *  - independence counts lineages, never URLs or publishers;
 *  - REJECTED requires a primary official contradiction and no qualifying
 *    support, never mere absence of support;
 *  - PRODUCT RULE (S4.1): VERIFIED also needs at least one qualifying
 *    supporting record from an identified source class
 *    (policy.rules.verifiedSourceClasses: OFFICIAL, FIRST_PARTY). Any number of
 *    UNKNOWN web sources alone reaches LIKELY at most.
 */

export type Retrieval = "ok" | "no_results" | "unavailable" | "not_attempted";

export interface CommunitySignals {
  confirmations: number;
  disputes: number;
  stillHappening: number;
  noLongerHappening: number;
}

export interface DecisionEvent extends TimedEvent {
  status: EventStatus;
}

export interface DecisionInput {
  event: DecisionEvent;
  evidence: EvidenceRecord[];
  community: CommunitySignals;
  retrieval: Retrieval;
  now: Date;
  policy?: VerificationPolicy;
}

export const ESCALATION_REASONS = [
  "conflicting_sources",
  "insufficient_independent",
  "no_external_support",
  "location_unclear",
  "contradiction_without_support",
  "community_dispute",
  "no_identified_source",
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

export interface JudgedEvidence {
  record: EvidenceRecord;
  freshness: Freshness;
  timeMatch: TimeMatch;
  /** Counts toward a decision: located, on time, not stale, and taking a stance. */
  qualifies: boolean;
}

export interface LineageFacts {
  lineageId: string;
  /** The newest qualifying record's stance (a source updating itself wins). */
  stance: "supports" | "contradicts" | "ended";
  records: EvidenceRecord[];
  /** Contains a primary record from an official or first-party source. */
  primaryOfficial: boolean;
  /** Contains a qualifying SUPPORTING record from a class that can verify (policy.rules.verifiedSourceClasses). */
  identifiedSupport: boolean;
  exactLocation: boolean;
  /** At least one qualifying record is fresh (not merely aging). */
  fresh: boolean;
  /** Latest POSSIBLE time of its newest qualifying record (epoch ms). */
  newestAt: number;
  /** Earliest possible time of its newest qualifying record: when it is certainly at least this new. */
  newestCertainAt: number;
  /** A representative name, for explanations. */
  name: string;
}

export interface DecisionFacts {
  category: EventCategory;
  /** External (non-community) lineages, by their current qualifying stance. */
  support: LineageFacts[];
  contradiction: LineageFacts[];
  /** "Ended" lineages newer than every qualifying support. */
  ended: LineageFacts[];
  /** The community lineage currently supports the event (fresh community reports). */
  communitySupport: boolean;
  /** External supporting evidence exists but none of it still qualifies because it aged out. */
  supportAgedOut: boolean;
  /** Supporting records that would qualify but for an unclear location. */
  locationUnclear: number;
  /** Located, stance-taking records that don't count only because their time is known to the day, not the hour. */
  dateOnly: number;
  scheduledOver: boolean;
  /** For "N independent sources (M total)": all lineages and all records. */
  totalLineages: number;
  totalRecords: number;
  community: CommunitySignals;
  retrieval: Retrieval;
}

export const RULE_IDS = [
  "resolved_primary_end",
  "resolved_independent_end",
  "conflicting_sources",
  "rejected_primary_contradiction",
  "conflicting_primary_contradiction",
  "verified_primary_source",
  "verified_independent_sources",
  "likely_multiple_lineages",
  "developing_single_source",
  "resolved_schedule_ended",
  "stale_support_aged_out",
  "no_qualifying_evidence",
] as const;
export type RuleId = (typeof RULE_IDS)[number];

interface Rule {
  id: RuleId;
  /** "NO_CHANGE" keeps the current status. */
  target: EventStatus | "NO_CHANGE";
  actor: "verifier" | "system";
  applies: (f: DecisionFacts, status: EventStatus, policy: VerificationPolicy) => boolean;
  /** The lineages the decision rests on. */
  uses: (f: DecisionFacts) => LineageFacts[];
  escalation?: (f: DecisionFacts, policy: VerificationPolicy) => EscalationReason | null;
}

const ACTIVE = new Set<EventStatus>(ACTIVE_STATUSES);
const noContradiction = (f: DecisionFacts) => f.contradiction.length === 0;
/** The VERIFIED source-quality rule: some supporting lineage includes an identified source. */
const identifiedSupport = (f: DecisionFacts) => f.support.some((l) => l.identifiedSupport);

/**
 * THE rule table, in priority order: the first rule that applies decides.
 * Thresholds come from the policy so they can be tuned after live testing.
 */
export const RULES: readonly Rule[] = [
  {
    id: "resolved_primary_end",
    target: "RESOLVED",
    actor: "verifier",
    applies: (f) => f.ended.some((l) => l.primaryOfficial),
    uses: (f) => f.ended.filter((l) => l.primaryOfficial),
  },
  {
    id: "resolved_independent_end",
    target: "RESOLVED",
    actor: "verifier",
    applies: (f, _s, p) => f.ended.length >= p.rules.resolvedMinIndependent,
    uses: (f) => f.ended,
  },
  {
    id: "conflicting_sources",
    target: "CONFLICTING",
    actor: "verifier",
    applies: (f) => f.support.length > 0 && f.contradiction.length > 0,
    uses: (f) => [...f.support, ...f.contradiction],
    escalation: () => "conflicting_sources",
  },
  {
    id: "rejected_primary_contradiction",
    target: "REJECTED",
    actor: "verifier",
    applies: (f, s) => f.support.length === 0 && f.contradiction.some((l) => l.primaryOfficial) && (s === "UNVERIFIED" || s === "DEVELOPING"),
    uses: (f) => f.contradiction.filter((l) => l.primaryOfficial),
  },
  {
    // Once an event was supported, a later official contradiction makes it contested, not rejected.
    id: "conflicting_primary_contradiction",
    target: "CONFLICTING",
    actor: "verifier",
    applies: (f) => f.support.length === 0 && f.contradiction.some((l) => l.primaryOfficial),
    uses: (f) => f.contradiction.filter((l) => l.primaryOfficial),
    escalation: () => "conflicting_sources",
  },
  {
    id: "verified_primary_source",
    target: "VERIFIED",
    actor: "verifier",
    applies: (f) => noContradiction(f) && f.support.some((l) => l.primaryOfficial) && identifiedSupport(f),
    uses: (f) => f.support,
  },
  {
    id: "verified_independent_sources",
    target: "VERIFIED",
    actor: "verifier",
    applies: (f, _s, p) => noContradiction(f) && f.support.length >= p.rules.verifiedMinIndependent && f.support.some((l) => l.exactLocation) && identifiedSupport(f),
    uses: (f) => f.support,
  },
  {
    id: "likely_multiple_lineages",
    target: "LIKELY",
    actor: "verifier",
    applies: (f, _s, p) => noContradiction(f) && f.support.length >= 1 && f.support.length + (f.communitySupport ? 1 : 0) >= p.rules.likelyMinLineages,
    uses: (f) => f.support,
    // Enough independent sources, but none identified: an investigation may find an official or first-party one.
    escalation: (f, p) => (f.support.length >= p.rules.verifiedMinIndependent && !identifiedSupport(f) ? "no_identified_source" : "insufficient_independent"),
  },
  {
    id: "developing_single_source",
    target: "DEVELOPING",
    actor: "verifier",
    applies: (f) => noContradiction(f) && f.support.length >= 1,
    uses: (f) => f.support,
    escalation: () => "insufficient_independent",
  },
  {
    id: "resolved_schedule_ended",
    target: "RESOLVED",
    actor: "system",
    applies: (f, s) => f.scheduledOver && ACTIVE.has(s),
    uses: () => [],
  },
  {
    id: "stale_support_aged_out",
    target: "STALE",
    actor: "system",
    applies: (f, s) => f.supportAgedOut && (s === "DEVELOPING" || s === "LIKELY" || s === "VERIFIED" || s === "CONFLICTING"),
    uses: () => [],
  },
  {
    id: "no_qualifying_evidence",
    target: "NO_CHANGE",
    actor: "verifier",
    applies: () => true,
    uses: () => [],
    escalation: (f) =>
      f.contradiction.length > 0
        ? "contradiction_without_support"
        : f.locationUnclear > 0
          ? "location_unclear"
          : f.community.disputes > 0
            ? "community_dispute"
            : "no_external_support",
  },
];

// ---------------------------------------------------------------------------

export function judge(record: EvidenceRecord, event: TimedEvent, now: Date, policy: VerificationPolicy): JudgedEvidence {
  const f = freshness(record, event, now, policy);
  const t = timeMatch(record, event, now, policy);
  // A community report is located by construction: the event is where it was pinned.
  const located = record.sourceType === "community_report" || record.locationMatch === "exact" || record.locationMatch === "near";
  const qualifies = record.stance !== "context" && located && (f === "fresh" || f === "aging") && (t === "current" || t === "recent");
  return { record, freshness: f, timeMatch: t, qualifies };
}

const STANCE_TIEBREAK = { ended: 0, contradicts: 1, supports: 2 } as const;

function lineageFacts(lineageId: string, judged: JudgedEvidence[], verifying: ReadonlySet<string>, policy: VerificationPolicy): LineageFacts | null {
  // Order by the earliest POSSIBLE time (a date-only record is not assumed late in its day), then the latest.
  const usable = judged
    .filter((j) => j.qualifies)
    .map((j) => ({ j, b: evidenceBounds(j.record, policy)! }))
    .sort(
      (a, b) =>
        b.b.earliest - a.b.earliest ||
        b.b.latest - a.b.latest ||
        STANCE_TIEBREAK[a.j.record.stance as keyof typeof STANCE_TIEBREAK] - STANCE_TIEBREAK[b.j.record.stance as keyof typeof STANCE_TIEBREAK],
    );
  const newest = usable[0];
  if (!newest) return null;
  const records = usable.map((u) => u.j.record);
  const representative = records.find((r) => r.lineage.countsAsIndependent) ?? records[0]!;
  return {
    lineageId,
    stance: newest.j.record.stance as LineageFacts["stance"],
    records,
    primaryOfficial: records.some((r) => r.isPrimary && (r.sourceClass === "OFFICIAL" || r.sourceClass === "FIRST_PARTY")),
    identifiedSupport: records.some((r) => r.stance === "supports" && r.sourceType !== "community_report" && verifying.has(r.sourceClass)),
    exactLocation: records.some((r) => r.locationMatch === "exact"),
    fresh: usable.some((u) => u.j.freshness === "fresh"),
    newestAt: Math.max(...usable.map((u) => u.b.latest)),
    newestCertainAt: Math.max(...usable.map((u) => u.b.earliest)),
    name: representative.publisher ?? representative.sourceName,
  };
}

export function collectFacts(input: DecisionInput): DecisionFacts {
  const policy = input.policy ?? DEFAULT_POLICY;
  const judged = input.evidence.map((r) => judge(r, input.event, input.now, policy));
  const verifying = new Set<string>(policy.rules.verifiedSourceClasses);
  const byLineage = new Map<string, JudgedEvidence[]>();
  for (const j of judged) byLineage.set(j.record.lineage.lineageId, [...(byLineage.get(j.record.lineage.lineageId) ?? []), j]);

  const external: LineageFacts[] = [];
  let communitySupport = false;
  for (const [lineageId, members] of byLineage) {
    const facts = lineageFacts(lineageId, members, verifying, policy);
    if (!facts) continue;
    if (members.every((m) => m.record.sourceType === "community_report")) {
      communitySupport ||= facts.stance === "supports";
    } else {
      external.push(facts);
    }
  }
  const support = external.filter((l) => l.stance === "supports");
  const newestSupport = Math.max(Number.NEGATIVE_INFINITY, ...support.map((l) => l.newestAt));
  // External only: fresh community reports cannot keep an event verified on their own.
  const supportRecords = judged.filter((j) => j.record.stance === "supports" && j.record.sourceType !== "community_report");

  return {
    category: input.event.category,
    support,
    contradiction: external.filter((l) => l.stance === "contradicts"),
    // "Ended" wins only when it is CERTAINLY newer than every support (imprecise times can't resolve an event).
    ended: external.filter((l) => l.stance === "ended" && l.newestCertainAt > newestSupport),
    communitySupport,
    supportAgedOut: supportRecords.length > 0 && !supportRecords.some((j) => j.qualifies) && supportRecords.some((j) => j.freshness === "stale"),
    locationUnclear: judged.filter(
      (j) => !j.qualifies && j.record.stance === "supports" && j.record.locationMatch === "unclear" && j.record.sourceType !== "community_report" && (j.freshness === "fresh" || j.freshness === "aging"),
    ).length,
    dateOnly: judged.filter(
      (j) =>
        !j.qualifies &&
        j.record.stance !== "context" &&
        j.record.sourceType !== "community_report" &&
        (j.record.locationMatch === "exact" || j.record.locationMatch === "near") &&
        hasDayPrecision(j.record) &&
        (j.freshness === "unknown" || j.timeMatch === "unclear"),
    ).length,
    scheduledOver: (() => {
      const over = scheduledOverAt(input.event, policy);
      return over !== null && input.now > over;
    })(),
    totalLineages: byLineage.size,
    totalRecords: input.evidence.length,
    community: input.community,
    retrieval: input.retrieval,
  };
}

export interface Decision {
  /** The status to transition to, or null for no change. */
  target: EventStatus | null;
  actor: "verifier" | "system" | null;
  ruleId: RuleId;
  /** The rule's outcome before edge and downgrade guards (for provenance). */
  ruleTarget: EventStatus | null;
  /** Why the guards changed the outcome, if they did. */
  guard: "already_in_state" | "no_downgrade" | "reopened" | "edge_not_allowed" | null;
  explanation: string;
  escalation: EscalationReason | null;
  /** Stored source_records ids the decision rests on. */
  evidenceIds: string[];
  /** The evidence again supports the event's current VERIFIED/LIKELY status: refresh last_verified_at, no transition. */
  reconfirmed: boolean;
  facts: DecisionFacts;
}

/** Strength of positive states, for the no-downgrade guard. Aging evidence moves an event to STALE, never down this ladder. */
const POSITIVE_RANK: Partial<Record<EventStatus, number>> = { UNVERIFIED: 0, DEVELOPING: 1, LIKELY: 2, VERIFIED: 3 };

export function decide(input: DecisionInput): Decision {
  const policy = input.policy ?? DEFAULT_POLICY;
  const facts = collectFacts(input);
  const current = input.event.status;
  const rule = RULES.find((r) => r.applies(facts, current, policy))!;
  const used = rule.uses(facts);
  const evidenceIds = [...new Set(used.flatMap((l) => l.records.map((r) => r.id)).filter((id): id is string => id !== null))];
  const escalation = rule.escalation?.(facts, policy) ?? null;
  const ruleTarget = rule.target === "NO_CHANGE" ? null : rule.target;

  let target: EventStatus | null = ruleTarget;
  let guard: Decision["guard"] = null;
  let reconfirmed = false;
  let actor: Decision["actor"] = rule.actor;

  if (target === current) {
    target = null;
    guard = "already_in_state";
    // Only FRESH evidence reconfirms: aging evidence still counts, but must not refresh "last verified".
    reconfirmed = (current === "VERIFIED" || current === "LIKELY") && used.some((l) => l.fresh);
  } else if (target !== null) {
    const from = POSITIVE_RANK[current];
    const to = POSITIVE_RANK[target];
    if (from !== undefined && to !== undefined && to < from) {
      target = null;
      guard = "no_downgrade";
    } else if (!checkTransition(current, target, rule.actor).ok) {
      // An ended event with fresh support reopens as DEVELOPING; anything else waits.
      if (to !== undefined && checkTransition(current, "DEVELOPING", "verifier").ok) {
        target = "DEVELOPING";
        actor = "verifier";
        guard = "reopened";
      } else {
        target = null;
        guard = "edge_not_allowed";
      }
    }
  }
  if (target === null) actor = null;

  const decision: Omit<Decision, "explanation"> = { target, actor, ruleId: rule.id, ruleTarget, guard, escalation, evidenceIds, reconfirmed, facts };
  return { ...decision, explanation: explainDecision(decision, current, policy) };
}
