import type { EventStatus } from "@verity/contracts";
import type { NormalizedEvidence } from "../../src/verification/evidence";
import { assignLineages } from "../../src/verification/lineage";
import { decide, type CommunitySignals, type DecisionEvent, type Retrieval } from "../../src/verification/rules";

export const NOW = new Date("2026-10-03T12:00:00Z");
export const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
export const hoursAgo = (h: number) => minutesAgo(h * 60);
export const minutesFromNow = (m: number) => new Date(NOW.getTime() + m * 60_000);

let counter = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

/** A supporting local-news record, located exactly, published 30 minutes ago. Every field can be overridden. */
export function news(over: Partial<NormalizedEvidence> = {}): NormalizedEvidence {
  const id = nextId();
  return {
    id,
    canonicalUrl: `https://outlet-${id.slice(-4)}.example/story`,
    originalUrl: null,
    publisherDomain: null,
    publisher: `Outlet ${id.slice(-4)}`,
    sourceName: `Outlet ${id.slice(-4)}`,
    sourceType: "news_article",
    sourceClass: "LOCAL_NEWS",
    title: null,
    eventTimeAsReported: null,
    eventTimePrecision: null,
    publishedAt: minutesAgo(30),
    publishedAtPrecision: "instant",
    retrievedAt: NOW,
    excerpt: null,
    note: null,
    stance: "supports",
    locationMatch: "exact",
    isPrimary: false,
    attributions: [],
    originRef: null,
    retrievalMethod: "search",
    retrievalSteps: ["search"],
    finalUrl: null,
    extractRef: null,
    classifiedBy: "rules",
    query: null,
    providerRequestId: null,
    ...over,
  };
}

/** A primary official source (e.g. a transportation agency page). */
export function official(over: Partial<NormalizedEvidence> = {}): NormalizedEvidence {
  return news({
    canonicalUrl: `https://dot.ca.gov/alerts/${counter + 1}`,
    publisher: "Caltrans",
    sourceName: "Caltrans",
    sourceType: "official_feed",
    sourceClass: "OFFICIAL",
    isPrimary: true,
    ...over,
  });
}

/** A Phase 2-style community report record. */
export function communityReport(over: Partial<NormalizedEvidence> = {}): NormalizedEvidence {
  return news({
    canonicalUrl: null,
    publisher: null,
    sourceName: "Community report",
    sourceType: "community_report",
    sourceClass: "COMMUNITY",
    isPrimary: true,
    locationMatch: "unclear",
    retrievalMethod: "community",
    classifiedBy: "community",
    ...over,
  });
}

export const NO_SIGNALS: CommunitySignals = { confirmations: 0, disputes: 0, stillHappening: 0, noLongerHappening: 0 };

export function event(status: EventStatus, over: Partial<DecisionEvent> = {}): DecisionEvent {
  return { status, category: "road_closure", firstSeenAt: minutesAgo(60), scheduledStartAt: null, scheduledEndAt: null, ...over };
}

export function run(
  status: EventStatus,
  records: NormalizedEvidence[],
  options: { event?: Partial<DecisionEvent>; community?: Partial<CommunitySignals>; retrieval?: Retrieval } = {},
) {
  return decide({
    event: event(status, options.event),
    evidence: assignLineages(records),
    community: { ...NO_SIGNALS, ...options.community },
    retrieval: options.retrieval ?? "ok",
    now: NOW,
  });
}
