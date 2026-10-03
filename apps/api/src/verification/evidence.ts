import {
  EVIDENCE_STANCES,
  LOCATION_MATCHES,
  SOURCE_CLASSES,
  SOURCE_TYPES,
  isoDateTime,
  type EvidenceStance,
  type SourceClass,
} from "@verity/contracts";
import { z } from "zod";
import type { sourceRecords } from "../db/schema";
import type { Freshness, TimeMatch } from "./policy";

/**
 * Verity's internal, provider-neutral representation of one piece of
 * evidence. Nimble (or any later retriever) is normalized INTO this; the
 * verification engine only ever sees this. It maps onto existing
 * source_records columns, plus a versioned `extraction_metadata` object for
 * provenance that has no column of its own.
 */

export const RETRIEVAL_METHODS = ["community", "search", "agent", "extract"] as const;
export type RetrievalMethod = (typeof RETRIEVAL_METHODS)[number];

/** Who decided stance and relevance: community reports, Verity's deterministic rules, or the agent (as an input). */
export const CLASSIFIERS = ["community", "rules", "agent"] as const;
export type Classifier = (typeof CLASSIFIERS)[number];

/** How a source was attributed: an explicit "according to X", or a syndication marker such as "(AP) —". */
export const ATTRIBUTION_KINDS = ["explicit", "syndication"] as const;
export interface Attribution {
  /** Normalized origin key, e.g. "associated press". */
  origin: string;
  /** As written in the source, for explanations. */
  label: string;
  kind: (typeof ATTRIBUTION_KINDS)[number];
}

/** Why a record belongs to its lineage. There is deliberately no "same publisher" reason. */
export const LINEAGE_REASONS = [
  "own_origin",
  "community",
  "canonical_url",
  "explicit_attribution",
  "syndication",
  "near_duplicate",
  "same_origin_metadata",
] as const;
export type LineageReason = (typeof LINEAGE_REASONS)[number];

export interface NormalizedEvidence {
  /** The stored source_records id; null until the record is persisted. */
  id: string | null;
  /** Canonical URL (see url.ts). Stored as source_records.source_url. */
  canonicalUrl: string | null;
  /** The URL as retrieved, when canonicalization changed it. */
  originalUrl: string | null;
  /** Publisher identity (registrable domain). Not lineage: same publisher ≠ same origin. */
  publisherDomain: string | null;
  publisher: string | null;
  sourceName: string;
  sourceType: (typeof SOURCE_TYPES)[number];
  sourceClass: SourceClass;
  title: string | null;
  /** Three clocks: when the source says it happened, when it was published, when Verity fetched it. */
  eventTimeAsReported: Date | null;
  publishedAt: Date | null;
  retrievedAt: Date;
  /** VERBATIM text from the source. Never generated, never paraphrased. */
  excerpt: string | null;
  /** Verity-generated description. Always shown as "not a quote". */
  note: string | null;
  stance: EvidenceStance;
  locationMatch: (typeof LOCATION_MATCHES)[number];
  /** The source originated the information rather than repeating it. */
  isPrimary: boolean;
  attributions: Attribution[];
  /** Explicit origin metadata (e.g. a wire story id or a declared original URL). */
  originRef: string | null;
  retrievalMethod: RetrievalMethod;
  classifiedBy: Classifier;
  /** The query that found it (event wording and place names only; never user data). */
  query: string | null;
  providerRequestId: string | null;
}

export interface LineageAssignment {
  lineageId: string;
  reason: LineageReason;
  /** Key of the record this one was related to (its canonical URL or id), when not the origin itself. */
  relatedTo: string | null;
  /** The attributed origin, for attribution and syndication reasons. */
  via: string | null;
  /** Exactly one record per lineage counts toward independence. */
  countsAsIndependent: boolean;
}

export type EvidenceRecord = NormalizedEvidence & { lineage: LineageAssignment };

// ---------------------------------------------------------------------------
// extraction_metadata (versioned; parsed defensively on read)
// ---------------------------------------------------------------------------

const isoDate = isoDateTime;
const shortText = (max: number) => z.string().min(1).max(max);

export const extractionMetadataSchema = z.object({
  v: z.literal(1),
  original_url: shortText(2048).nullable(),
  publisher_domain: shortText(253).nullable(),
  title: shortText(300).nullable(),
  event_time_as_reported: isoDate.nullable(),
  attributions: z
    .array(z.object({ origin: shortText(120), label: shortText(120), kind: z.enum(ATTRIBUTION_KINDS) }))
    .max(10),
  origin_ref: shortText(300).nullable(),
  retrieval_method: z.enum(RETRIEVAL_METHODS),
  classified_by: z.enum(CLASSIFIERS),
  query: shortText(300).nullable(),
  provider_request_id: shortText(128).nullable(),
  lineage_reason: z.enum(LINEAGE_REASONS),
  lineage_related_to: shortText(2048).nullable(),
  lineage_via: shortText(120).nullable(),
});
export type ExtractionMetadata = z.infer<typeof extractionMetadataSchema>;

const cap = (value: string | null, max: number) => (value ? value.slice(0, max) : null);

type SourceRecordInsert = typeof sourceRecords.$inferInsert;
type SourceRecordRow = typeof sourceRecords.$inferSelect;

/** Persisted freshness has no "unknown": evidence without a usable time is stored as aging with an unclear time match. */
function storedFreshness(f: Freshness): "fresh" | "aging" | "stale" {
  return f === "unknown" ? "aging" : f;
}

export function toSourceRecordValues(
  e: EvidenceRecord,
  eventId: string,
  judged: { freshness: Freshness; timeMatch: TimeMatch },
): SourceRecordInsert {
  const metadata: ExtractionMetadata = {
    v: 1,
    original_url: cap(e.originalUrl, 2048),
    publisher_domain: cap(e.publisherDomain, 253),
    title: cap(e.title, 300),
    event_time_as_reported: e.eventTimeAsReported?.toISOString() ?? null,
    attributions: e.attributions.slice(0, 10).map((a) => ({ origin: a.origin.slice(0, 120), label: a.label.slice(0, 120), kind: a.kind })),
    origin_ref: cap(e.originRef, 300),
    retrieval_method: e.retrievalMethod,
    classified_by: e.classifiedBy,
    query: cap(e.query, 300),
    provider_request_id: cap(e.providerRequestId, 128),
    lineage_reason: e.lineage.reason,
    lineage_related_to: cap(e.lineage.relatedTo, 2048),
    lineage_via: cap(e.lineage.via, 120),
  };
  return {
    eventId,
    sourceType: e.sourceType,
    sourceName: e.sourceName.slice(0, 200),
    sourceUrl: e.canonicalUrl,
    sourceDomain: e.canonicalUrl ? new URL(e.canonicalUrl).hostname : null,
    publisher: cap(e.publisher, 200),
    publishedAt: e.publishedAt,
    retrievedAt: e.retrievedAt,
    quote: cap(e.excerpt, 1000),
    agentNote: cap(e.note, 1000),
    stance: e.stance,
    sourceClass: e.sourceClass,
    isPrimary: e.isPrimary,
    lineageId: e.lineage.lineageId,
    countsAsIndependent: e.lineage.countsAsIndependent,
    freshnessState: storedFreshness(judged.freshness),
    locationMatch: e.locationMatch,
    timeMatch: judged.timeMatch,
    extractionMetadata: metadata,
  };
}

/** Read a stored record back. Community reports (Phase 2) carry no metadata and map to sensible defaults. */
export function fromSourceRecord(row: SourceRecordRow): EvidenceRecord {
  const parsed = extractionMetadataSchema.safeParse(row.extractionMetadata);
  const m = parsed.success ? parsed.data : null;
  const community = row.sourceType === "community_report";
  return {
    id: row.id,
    canonicalUrl: row.sourceUrl,
    originalUrl: m?.original_url ?? null,
    publisherDomain: m?.publisher_domain ?? null,
    publisher: row.publisher,
    sourceName: row.sourceName,
    sourceType: row.sourceType as NormalizedEvidence["sourceType"],
    sourceClass: (SOURCE_CLASSES as readonly string[]).includes(row.sourceClass) ? (row.sourceClass as SourceClass) : "UNKNOWN",
    title: m?.title ?? null,
    eventTimeAsReported: m?.event_time_as_reported ? new Date(m.event_time_as_reported) : null,
    publishedAt: row.publishedAt,
    retrievedAt: row.retrievedAt,
    excerpt: row.quote,
    note: row.agentNote,
    stance: (EVIDENCE_STANCES as readonly string[]).includes(row.stance) ? (row.stance as EvidenceStance) : "context",
    locationMatch: row.locationMatch as NormalizedEvidence["locationMatch"],
    isPrimary: row.isPrimary,
    attributions: m?.attributions ?? [],
    originRef: m?.origin_ref ?? null,
    retrievalMethod: m?.retrieval_method ?? (community ? "community" : "search"),
    classifiedBy: m?.classified_by ?? (community ? "community" : "rules"),
    query: m?.query ?? null,
    providerRequestId: m?.provider_request_id ?? null,
    lineage: {
      lineageId: row.lineageId,
      reason: m?.lineage_reason ?? (community ? "community" : "own_origin"),
      relatedTo: m?.lineage_related_to ?? null,
      via: m?.lineage_via ?? null,
      countsAsIndependent: row.countsAsIndependent,
    },
  };
}

/** A stable key for a record: its id once stored, otherwise its canonical URL. */
export function evidenceKey(e: Pick<NormalizedEvidence, "id" | "canonicalUrl">, fallback: string): string {
  return e.id ?? e.canonicalUrl ?? fallback;
}
