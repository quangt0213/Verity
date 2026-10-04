import { z } from "zod";
import { isoDateTime } from "./time";

/**
 * Coarse source classes. A class is one input to the verification engine,
 * never a verdict on its own: an official page can be outdated and a social
 * post can be the earliest primary report.
 */
export const SOURCE_CLASSES = [
  "OFFICIAL",
  "FIRST_PARTY",
  "REPUTABLE_NEWS",
  "LOCAL_NEWS",
  "COMMUNITY",
  "SOCIAL",
  "UNKNOWN",
] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];
export const sourceClassSchema = z.enum(SOURCE_CLASSES);

export const SOURCE_TYPES = [
  "web_page",
  "news_article",
  "official_feed",
  "social_post",
  "community_report",
  "structured_extraction",
] as const;
export const sourceTypeSchema = z.enum(SOURCE_TYPES);

/** What a piece of evidence says about the event. */
export const EVIDENCE_STANCES = ["supports", "contradicts", "ended", "context"] as const;
export type EvidenceStance = (typeof EVIDENCE_STANCES)[number];
export const evidenceStanceSchema = z.enum(EVIDENCE_STANCES);

export const FRESHNESS_STATES = ["fresh", "aging", "stale"] as const;
export type FreshnessState = (typeof FRESHNESS_STATES)[number];
export const freshnessStateSchema = z.enum(FRESHNESS_STATES);

export const LOCATION_MATCHES = ["exact", "near", "unclear", "mismatch"] as const;
export const locationMatchSchema = z.enum(LOCATION_MATCHES);

/**
 * How precisely a time is known. "day": only the calendar date is known (e.g.
 * a "2026-10-03" publication date), in an unknown timezone. It is a range,
 * never a moment: never display or reason about it as a clock time.
 */
export const TIME_PRECISIONS = ["instant", "day"] as const;
export type TimePrecision = (typeof TIME_PRECISIONS)[number];
export const timePrecisionSchema = z.enum(TIME_PRECISIONS);

export const TIME_MATCHES = ["current", "recent", "outdated", "unclear"] as const;
export const timeMatchSchema = z.enum(TIME_MATCHES);

/**
 * Public view of one evidence record.
 *
 * `quote` is verbatim text from the source. `agent_note` is Verity's research
 * agent describing the source in its own words; clients must label it as such
 * and never present it as a quotation.
 */
export const evidenceSchema = z.object({
  id: z.string().min(1).max(64),
  event_id: z.string().min(1).max(64),
  source_type: sourceTypeSchema,
  source_name: z.string().min(1).max(200),
  source_url: z.string().max(2048).nullable(),
  source_domain: z.string().max(253).nullable(),
  publisher: z.string().max(200).nullable(),
  published_at: isoDateTime.nullable(),
  /** Null exactly when published_at is null. "day": published_at is 00:00 UTC of the stated calendar date, not a time. */
  published_at_precision: timePrecisionSchema.nullable(),
  retrieved_at: isoDateTime,
  quote: z.string().max(1000).nullable(),
  agent_note: z.string().max(1000).nullable(),
  stance: evidenceStanceSchema,
  source_class: sourceClassSchema,
  /** True when the source originated the information rather than repeating it. */
  is_primary: z.boolean(),
  /** Evidence sharing a lineage traces back to the same origin (e.g. one press release). */
  lineage_id: z.string().min(1).max(64),
  /** True for exactly one record per lineage among those counted toward independence. */
  counts_as_independent: z.boolean(),
  freshness_state: freshnessStateSchema,
  location_match: locationMatchSchema,
  time_match: timeMatchSchema,
});
export type Evidence = z.infer<typeof evidenceSchema>;
