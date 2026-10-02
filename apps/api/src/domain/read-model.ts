import {
  ACTIVE_STATUSES,
  LIMITS,
  type Claim,
  type CommunitySummary,
  type EventCategory,
  type EventDetail,
  type EventStatus,
  type EventSummary,
  type Evidence,
  type ListEventsResponse,
  type TimelineEntry,
} from "@verity/contracts";
import { and, asc, between, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import type { Queryable } from "../db/client";
import { communitySignals, eventFollows, events, eventTimeline, sourceRecords } from "../db/schema";

/**
 * Public read model. Everything returned here is public-safe: no user ids,
 * emails, IPs, reporter identities, moderation or security metadata.
 */

export const COMMUNITY_WINDOW_MINUTES = 60;
const DEFAULT_STATUSES: EventStatus[] = [...ACTIVE_STATUSES, "RESOLVED"];

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// Correlated subqueries reference the outer row as "events"."id" explicitly:
// an unqualified column would resolve to the inner table instead.
const counts = {
  sourceCount: sql<number>`(select count(*)::int from source_records sr where sr.event_id = "events"."id")`,
  independentSourceCount: sql<number>`(select count(*)::int from source_records sr where sr.event_id = "events"."id" and sr.counts_as_independent)`,
  confirmationCount: sql<number>`(select count(*)::int from community_signals cs where cs.event_id = "events"."id" and cs.active and cs.type = 'CONFIRM')`,
  disputeCount: sql<number>`(select count(*)::int from community_signals cs where cs.event_id = "events"."id" and cs.active and cs.type = 'DISPUTE')`,
};

const summaryColumns = {
  id: events.id,
  title: events.title,
  summary: events.summary,
  category: events.category,
  latitude: events.latitude,
  longitude: events.longitude,
  approximateLocation: events.approximateLocation,
  affectedRadiusM: events.affectedRadiusM,
  status: events.status,
  verificationState: events.verificationState,
  origin: events.origin,
  firstSeenAt: events.firstSeenAt,
  lastUpdatedAt: events.lastUpdatedAt,
  lastVerifiedAt: events.lastVerifiedAt,
  lastCheckedAt: events.lastCheckedAt,
  scheduledStartAt: events.scheduledStartAt,
  scheduledEndAt: events.scheduledEndAt,
  expiresAt: events.expiresAt,
  isDemo: events.isDemo,
  evidenceSummary: events.evidenceSummary,
  ...counts,
};

interface SummaryRow {
  id: string;
  title: string;
  summary: string;
  category: string;
  latitude: number;
  longitude: number;
  approximateLocation: string;
  affectedRadiusM: number | null;
  status: string;
  verificationState: string;
  origin: string;
  firstSeenAt: Date;
  lastUpdatedAt: Date;
  lastVerifiedAt: Date | null;
  lastCheckedAt: Date | null;
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;
  expiresAt: Date | null;
  isDemo: boolean;
  evidenceSummary: string | null;
  sourceCount: number;
  independentSourceCount: number;
  confirmationCount: number;
  disputeCount: number;
}

function toSummary(row: SummaryRow): EventSummary {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    category: row.category as EventCategory,
    coordinates: { latitude: row.latitude, longitude: row.longitude },
    approximate_location: row.approximateLocation,
    affected_area: row.affectedRadiusM ? { radius_m: row.affectedRadiusM } : null,
    status: row.status as EventStatus,
    verification_state: row.verificationState as EventSummary["verification_state"],
    origin: row.origin as EventSummary["origin"],
    source_count: Number(row.sourceCount),
    independent_source_count: Number(row.independentSourceCount),
    community_confirmation_count: Number(row.confirmationCount),
    community_dispute_count: Number(row.disputeCount),
    first_seen_at: row.firstSeenAt.toISOString(),
    last_updated_at: row.lastUpdatedAt.toISOString(),
    last_verified_at: iso(row.lastVerifiedAt),
    last_checked_at: iso(row.lastCheckedAt),
    scheduled_start_at: iso(row.scheduledStartAt),
    scheduled_end_at: iso(row.scheduledEndAt),
    expires_at: iso(row.expiresAt),
    is_demo: row.isDemo,
  };
}

// ---------------------------------------------------------------------------
// Listing with keyset pagination
// ---------------------------------------------------------------------------

export interface ListParams {
  bbox?: [number, number, number, number];
  categories?: EventCategory[];
  statuses?: EventStatus[];
  q?: string;
  limit?: number;
  cursor?: string;
  updatedSince?: string;
}

function encodeCursor(row: { lastUpdatedAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify([row.lastUpdatedAt.toISOString(), row.id])).toString("base64url");
}

export function decodeCursor(cursor: string): { at: Date; id: string } | null {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [unknown, unknown];
    if (typeof at !== "string" || typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    const date = new Date(at);
    return Number.isNaN(date.getTime()) ? null : { at: date, id };
  } catch {
    return null;
  }
}

/** Escape LIKE wildcards so user text matches literally (the value is still a bound parameter). */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listEvents(db: Queryable, params: ListParams, now = new Date()): Promise<ListEventsResponse> {
  const limit = Math.min(params.limit ?? 200, LIMITS.maxEventsPerQuery);
  const cursor = params.cursor ? decodeCursor(params.cursor) : null;
  const conditions: Array<SQL | undefined> = [
    inArray(events.status, params.statuses?.length ? params.statuses : DEFAULT_STATUSES),
  ];
  if (params.bbox) {
    const [west, south, east, north] = params.bbox;
    conditions.push(between(events.latitude, south, north), between(events.longitude, west, east));
  }
  if (params.categories?.length) conditions.push(inArray(events.category, params.categories));
  if (params.q) {
    const pattern = likePattern(params.q);
    conditions.push(or(ilike(events.title, pattern), ilike(events.approximateLocation, pattern), ilike(events.summary, pattern)));
  }
  if (params.updatedSince) conditions.push(gte(events.lastUpdatedAt, new Date(params.updatedSince)));
  if (cursor) {
    conditions.push(or(lt(events.lastUpdatedAt, cursor.at), and(eq(events.lastUpdatedAt, cursor.at), lt(events.id, cursor.id))));
  }

  const rows: SummaryRow[] = await db
    .select(summaryColumns)
    .from(events)
    .where(and(...conditions))
    .orderBy(desc(events.lastUpdatedAt), desc(events.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page.at(-1);
  return {
    events: page.map(toSummary),
    generated_at: now.toISOString(),
    truncated: hasMore,
    next_cursor: hasMore && last ? encodeCursor(last) : null,
  };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

async function getSummaryRow(db: Queryable, id: string): Promise<SummaryRow | null> {
  const [row]: SummaryRow[] = await db.select(summaryColumns).from(events).where(eq(events.id, id)).limit(1);
  return row ?? null;
}

export async function getEvidence(db: Queryable, eventId: string): Promise<Evidence[]> {
  const rows = await db
    .select()
    .from(sourceRecords)
    .where(eq(sourceRecords.eventId, eventId))
    .orderBy(asc(sourceRecords.createdAt), asc(sourceRecords.id));
  return rows.map((r) => ({
    id: r.id,
    event_id: r.eventId,
    source_type: r.sourceType as Evidence["source_type"],
    source_name: r.sourceName,
    source_url: r.sourceUrl,
    source_domain: r.sourceDomain,
    publisher: r.publisher,
    published_at: iso(r.publishedAt),
    retrieved_at: r.retrievedAt.toISOString(),
    quote: r.quote,
    agent_note: r.agentNote,
    stance: r.stance as Evidence["stance"],
    source_class: r.sourceClass as Evidence["source_class"],
    is_primary: r.isPrimary,
    lineage_id: r.lineageId,
    counts_as_independent: r.countsAsIndependent,
    freshness_state: r.freshnessState as Evidence["freshness_state"],
    location_match: r.locationMatch as Evidence["location_match"],
    time_match: r.timeMatch as Evidence["time_match"],
  }));
}

export async function getTimeline(db: Queryable, eventId: string): Promise<TimelineEntry[]> {
  const rows = await db
    .select()
    .from(eventTimeline)
    .where(eq(eventTimeline.eventId, eventId))
    .orderBy(asc(eventTimeline.at), asc(eventTimeline.createdAt));
  return rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    kind: r.kind as TimelineEntry["kind"],
    label: r.label,
    detail: r.detail,
    from_status: r.fromStatus as EventStatus | null,
    to_status: r.toStatus as EventStatus | null,
    evidence_id: r.sourceRecordId,
  }));
}

async function getCommunitySummary(db: Queryable, eventId: string, now: Date): Promise<CommunitySummary> {
  const since = new Date(now.getTime() - COMMUNITY_WINDOW_MINUTES * 60_000);
  const rows = await db
    .select({ type: communitySignals.type, count: sql<number>`count(*)::int` })
    .from(communitySignals)
    .where(and(eq(communitySignals.eventId, eventId), eq(communitySignals.active, true), gte(communitySignals.createdAt, since)))
    .groupBy(communitySignals.type);
  const by = Object.fromEntries(rows.map((r) => [r.type, Number(r.count)])) as Record<string, number>;
  return {
    window_minutes: COMMUNITY_WINDOW_MINUTES,
    recent_confirmations: by.CONFIRM ?? 0,
    recent_disputes: by.DISPUTE ?? 0,
    resolved_reports: by.NO_LONGER_HAPPENING ?? 0,
    still_happening: { yes: by.STILL_HAPPENING ?? 0, no: by.NO_LONGER_HAPPENING ?? 0, not_sure: by.NOT_SURE ?? 0 },
  };
}

const CLAIM_STANCE: Record<EventStatus, Claim["stance"]> = {
  UNVERIFIED: "unconfirmed",
  DEVELOPING: "unconfirmed",
  LIKELY: "supported",
  VERIFIED: "supported",
  CONFLICTING: "contradicted",
  STALE: "unconfirmed",
  RESOLVED: "ended",
  REJECTED: "contradicted",
};

/** Deterministic description of the evidence, used until the verification engine writes one. */
export function describeEvidence(evidence: Evidence[]): string {
  const community = evidence.filter((e) => e.source_type === "community_report").length;
  const other = evidence.length - community;
  if (evidence.length === 0) return "No evidence has been attached yet.";
  const parts: string[] = [];
  if (community === 1) parts.push("One community report so far.");
  else if (community > 1) parts.push(`${community} community reports so far; together they count as one independent source.`);
  if (other === 0) parts.push("Not yet checked against other sources.");
  else parts.push(`${other} other source${other === 1 ? "" : "s"} attached.`);
  return parts.join(" ");
}

export async function getEventDetail(db: Queryable, id: string, now = new Date()): Promise<EventDetail | null> {
  const row = await getSummaryRow(db, id);
  if (!row) return null;
  const [evidence, timeline, community] = await Promise.all([
    getEvidence(db, id),
    getTimeline(db, id),
    getCommunitySummary(db, id, now),
  ]);
  const summary = toSummary(row);
  return {
    ...summary,
    current_claims: [
      {
        id: `${id.slice(0, 8)}-primary`,
        text: row.title.slice(0, 300),
        stance: CLAIM_STANCE[summary.status],
        evidence_ids: evidence.slice(0, 50).map((e) => e.id),
      },
    ],
    evidence_summary: row.evidenceSummary ?? describeEvidence(evidence),
    evidence,
    timeline,
    community,
  };
}

export async function eventExists(db: Queryable, id: string): Promise<boolean> {
  const [row] = await db.select({ id: events.id }).from(events).where(eq(events.id, id)).limit(1);
  return Boolean(row);
}

export async function listFollowing(db: Queryable, userId: string): Promise<EventSummary[]> {
  const rows: SummaryRow[] = await db
    .select(summaryColumns)
    .from(eventFollows)
    .innerJoin(events, eq(events.id, eventFollows.eventId))
    .where(eq(eventFollows.userId, userId))
    .orderBy(desc(eventFollows.createdAt))
    .limit(200);
  return rows.map(toSummary);
}
