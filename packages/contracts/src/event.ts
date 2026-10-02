import { z } from "zod";
import { eventCategorySchema } from "./category";
import { communitySummarySchema } from "./community";
import { evidenceSchema } from "./evidence";
import { coordinatesSchema } from "./geo";
import { eventStatusSchema, verificationStateSchema } from "./status";
import { isoDateTime } from "./time";
import { timelineEntrySchema } from "./timeline";

const count = z.number().int().nonnegative();

export const EVENT_ORIGINS = ["community_report", "source_discovered"] as const;
export type EventOrigin = (typeof EVENT_ORIGINS)[number];

const eventSummaryBase = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  summary: z.string().max(2000),
  category: eventCategorySchema,
  coordinates: coordinatesSchema,
  /** Human-readable, intentionally approximate place description. */
  approximate_location: z.string().max(200),
  affected_area: z.object({ radius_m: z.number().int().positive().max(50_000) }).nullable(),
  status: eventStatusSchema,
  verification_state: verificationStateSchema,
  origin: z.enum(EVENT_ORIGINS),
  /** Every evidence record attached to the event. */
  source_count: count,
  /** Distinct source lineages; copies of one origin count once. */
  independent_source_count: count,
  community_confirmation_count: count,
  community_dispute_count: count,
  first_seen_at: isoDateTime,
  last_updated_at: isoDateTime,
  /** When evidence last supported the current status. */
  last_verified_at: isoDateTime.nullable(),
  /** When Verity last re-checked sources, even if nothing changed. */
  last_checked_at: isoDateTime.nullable(),
  scheduled_start_at: isoDateTime.nullable(),
  scheduled_end_at: isoDateTime.nullable(),
  expires_at: isoDateTime.nullable(),
  /** Demo/seed data. Clients must label it and never present it as a real current event. */
  is_demo: z.boolean(),
});

const independentNotAboveTotal = (e: { source_count: number; independent_source_count: number }) =>
  e.independent_source_count <= e.source_count;
const independenceMessage = { message: "independent_source_count cannot exceed source_count" };

export const eventSummarySchema = eventSummaryBase.refine(independentNotAboveTotal, independenceMessage);
export type EventSummary = z.infer<typeof eventSummarySchema>;

/** A normalized statement Verity is tracking, in Verity's own words. */
export const claimSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(300),
  stance: z.enum(["supported", "contradicted", "ended", "unconfirmed"]),
  evidence_ids: z.array(z.string().max(64)).max(50),
});
export type Claim = z.infer<typeof claimSchema>;

export const eventDetailSchema = eventSummaryBase
  .extend({
    current_claims: z.array(claimSchema).max(50),
    /** Deterministic explanation of the evidence behind the status. */
    evidence_summary: z.string().max(1000).nullable(),
    evidence: z.array(evidenceSchema).max(200),
    timeline: z.array(timelineEntrySchema).max(500),
    community: communitySummarySchema,
  })
  .refine(independentNotAboveTotal, independenceMessage);
export type EventDetail = z.infer<typeof eventDetailSchema>;

/** Narrow a detail payload to the summary fields used in lists and cards. */
export function toEventSummary(detail: EventDetail): EventSummary {
  const {
    current_claims: _claims,
    evidence_summary: _summary,
    evidence: _evidence,
    timeline: _timeline,
    community: _community,
    ...summary
  } = detail;
  return summary;
}
