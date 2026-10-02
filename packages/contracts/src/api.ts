import { z } from "zod";
import { EVENT_CATEGORIES, eventCategorySchema } from "./category";
import { STILL_HAPPENING_ANSWERS } from "./community";
import { eventSummarySchema } from "./event";
import { evidenceSchema } from "./evidence";
import { bboxSchema, coordinatesSchema } from "./geo";
import { LIMITS } from "./limits";
import { EVENT_STATUSES, eventStatusSchema } from "./status";
import { multilineText, singleLineText } from "./text";
import { isoDateTime } from "./time";
import { timelineEntrySchema } from "./timeline";
import { publicHttpUrlSchema } from "./url";

// ---------------------------------------------------------------------------
// GET /api/v1/events
// ---------------------------------------------------------------------------

export const listEventsQuerySchema = z.strictObject({
  bbox: bboxSchema.optional(),
  categories: z.array(eventCategorySchema).max(EVENT_CATEGORIES.length).optional(),
  statuses: z.array(eventStatusSchema).max(EVENT_STATUSES.length).optional(),
  q: singleLineText(1, LIMITS.searchQueryMax).optional(),
  /** Page size; the service caps it at LIMITS.maxEventsPerQuery. */
  limit: z.number().int().min(1).max(LIMITS.maxEventsPerQuery).optional(),
  /** Opaque cursor from a previous response's next_cursor. */
  cursor: z.string().min(1).max(200).optional(),
  /** Freshness filter: only events updated at or after this time. */
  updated_since: isoDateTime.optional(),
});
export type ListEventsQuery = z.input<typeof listEventsQuerySchema>;

export const listEventsResponseSchema = z.object({
  events: z.array(eventSummarySchema).max(LIMITS.maxEventsPerQuery),
  generated_at: isoDateTime,
  /** True when more events matched than were returned. */
  truncated: z.boolean(),
  /** Pass back as `cursor` to fetch the next page. */
  next_cursor: z.string().max(200).nullable().optional(),
});
export type ListEventsResponse = z.infer<typeof listEventsResponseSchema>;

export const evidenceListResponseSchema = z.object({ evidence: z.array(evidenceSchema).max(200) });
export const timelineResponseSchema = z.object({ timeline: z.array(timelineEntrySchema).max(500) });

// ---------------------------------------------------------------------------
// POST /api/v1/reports
// ---------------------------------------------------------------------------

const MAX_OBSERVED_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const reportEventInputSchema = z.strictObject({
  category: eventCategorySchema,
  title: singleLineText(LIMITS.titleMin, LIMITS.titleMax),
  description: multilineText(LIMITS.descriptionMax).optional(),
  location: z.strictObject({
    coordinates: coordinatesSchema,
    label: singleLineText(1, LIMITS.locationLabelMax).optional(),
  }),
  source_url: publicHttpUrlSchema.optional(),
  /** When the reporter saw it. Defaults to the time the report is received. */
  observed_at: isoDateTime
    .refine((v) => Date.parse(v) <= Date.now() + MAX_CLOCK_SKEW_MS, { message: "Can't be in the future" })
    .refine((v) => Date.parse(v) >= Date.now() - MAX_OBSERVED_AGE_MS, { message: "Must be within the last 7 days" })
    .optional(),
});
export type ReportEventInput = z.input<typeof reportEventInputSchema>;
export type ReportEventPayload = z.output<typeof reportEventInputSchema>;

export const reportEventResultSchema = z.object({
  event_id: z.string().min(1).max(64),
  report_id: z.string().min(1).max(64).optional(),
  /** "attached_to_existing" when the report matched an active event nearby. */
  outcome: z.enum(["created", "attached_to_existing"]),
});
export type ReportEventResult = z.infer<typeof reportEventResultSchema>;

// ---------------------------------------------------------------------------
// POST /api/events/:id/{confirm,dispute,resolved,still-happening,update}
// ---------------------------------------------------------------------------

export const communityResponseInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("confirm") }),
  z.strictObject({
    kind: z.literal("dispute"),
    reason: singleLineText(1, LIMITS.disputeReasonMax).optional(),
  }),
  z.strictObject({ kind: z.literal("resolved") }),
  z.strictObject({ kind: z.literal("still_happening"), answer: z.enum(STILL_HAPPENING_ANSWERS) }),
  z.strictObject({
    kind: z.literal("update"),
    text: multilineText(LIMITS.updateTextMax).pipe(z.string().min(1, { message: "Required" })),
  }),
]);
export type CommunityResponseInput = z.input<typeof communityResponseInputSchema>;
export type CommunityResponseKind = CommunityResponseInput["kind"];

// ---------------------------------------------------------------------------
// Errors: the only shape the service returns on failure. Never stack traces,
// provider errors or internal identifiers.
// ---------------------------------------------------------------------------

export const API_ERROR_CODES = [
  "validation_failed",
  "auth_required",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "payload_too_large",
  "unavailable",
  "internal",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string().max(300),
    fields: z.record(z.string(), z.string().max(200)).optional(),
    /** Correlation id for support; never contains user data. */
    request_id: z.string().max(100).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
