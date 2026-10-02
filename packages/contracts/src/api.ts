import { z } from "zod";
import { EVENT_CATEGORIES, eventCategorySchema } from "./category";
import { STILL_HAPPENING_ANSWERS } from "./community";
import { eventSummarySchema } from "./event";
import { bboxSchema, coordinatesSchema } from "./geo";
import { LIMITS } from "./limits";
import { EVENT_STATUSES, eventStatusSchema } from "./status";
import { multilineText, singleLineText } from "./text";
import { isoDateTime } from "./time";
import { publicHttpUrlSchema } from "./url";

// ---------------------------------------------------------------------------
// GET /api/events
// ---------------------------------------------------------------------------

export const listEventsQuerySchema = z.strictObject({
  bbox: bboxSchema.optional(),
  categories: z.array(eventCategorySchema).max(EVENT_CATEGORIES.length).optional(),
  statuses: z.array(eventStatusSchema).max(EVENT_STATUSES.length).optional(),
  q: singleLineText(1, LIMITS.searchQueryMax).optional(),
});
export type ListEventsQuery = z.input<typeof listEventsQuerySchema>;

export const listEventsResponseSchema = z.object({
  events: z.array(eventSummarySchema).max(LIMITS.maxEventsPerQuery),
  generated_at: isoDateTime,
  /** True when more events matched than were returned. */
  truncated: z.boolean(),
});
export type ListEventsResponse = z.infer<typeof listEventsResponseSchema>;

// ---------------------------------------------------------------------------
// POST /api/events/report
// ---------------------------------------------------------------------------

export const reportEventInputSchema = z.strictObject({
  category: eventCategorySchema,
  title: singleLineText(LIMITS.titleMin, LIMITS.titleMax),
  description: multilineText(LIMITS.descriptionMax).optional(),
  location: z.strictObject({
    coordinates: coordinatesSchema,
    label: singleLineText(1, LIMITS.locationLabelMax).optional(),
  }),
  source_url: publicHttpUrlSchema.optional(),
});
export type ReportEventInput = z.input<typeof reportEventInputSchema>;
export type ReportEventPayload = z.output<typeof reportEventInputSchema>;

export const reportEventResultSchema = z.object({
  event_id: z.string().min(1).max(64),
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
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
