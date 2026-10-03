import { z } from "zod";
import { eventStatusSchema } from "./status";
import { isoDateTime } from "./time";

/**
 * Timeline entries explain how Verity's understanding of an event changed.
 * Labels come from deterministic server templates, not free-form model output.
 */
export const TIMELINE_KINDS = [
  "report_received",
  "report_merged",
  "verification_started",
  "source_found",
  "contradiction_found",
  "status_changed",
  "checked_no_change",
  "verification_unavailable",
  "community_update",
  "expected_end_passed",
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export const timelineEntrySchema = z.object({
  id: z.string().min(1).max(64),
  at: isoDateTime,
  kind: z.enum(TIMELINE_KINDS),
  label: z.string().min(1).max(300),
  detail: z.string().max(1000).nullable(),
  from_status: eventStatusSchema.nullable(),
  to_status: eventStatusSchema.nullable(),
  evidence_id: z.string().max(64).nullable(),
});
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;
