import { z } from "zod";
import { eventSummarySchema } from "./event";
import { isoDateTime } from "./time";

/**
 * Community signals: one person's current answer about an event. They adjust
 * community counts only. A signal never sets an event's status by itself.
 */
export const SIGNAL_TYPES = ["CONFIRM", "DISPUTE", "STILL_HAPPENING", "NO_LONGER_HAPPENING", "NOT_SURE"] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];
export const signalTypeSchema = z.enum(SIGNAL_TYPES);

/**
 * Signals in the same group answer the same question, so a person has at most
 * one active signal per group per event; a newer answer supersedes the older.
 *  - validity:      "Is this real?"          CONFIRM | DISPUTE
 *  - current_state: "Is it still happening?" STILL_HAPPENING | NO_LONGER_HAPPENING | NOT_SURE
 */
export const SIGNAL_GROUPS = ["validity", "current_state"] as const;
export type SignalGroup = (typeof SIGNAL_GROUPS)[number];

export const SIGNAL_GROUP: Record<SignalType, SignalGroup> = {
  CONFIRM: "validity",
  DISPUTE: "validity",
  STILL_HAPPENING: "current_state",
  NO_LONGER_HAPPENING: "current_state",
  NOT_SURE: "current_state",
};

/** POST /api/v1/events/:id/signals. Identity always comes from the session, never the body. */
export const signalInputSchema = z.strictObject({ type: signalTypeSchema });
export type SignalInput = z.infer<typeof signalInputSchema>;

export const signalResultSchema = z.object({
  type: signalTypeSchema,
  /** False when the same answer was already active (idempotent repeat). */
  changed: z.boolean(),
});
export type SignalResult = z.infer<typeof signalResultSchema>;

/** GET /api/v1/events/:id/signals/mine — the caller's own active answers. */
export const mySignalsResponseSchema = z.object({
  signals: z.array(z.object({ type: signalTypeSchema, created_at: isoDateTime })).max(SIGNAL_GROUPS.length),
});
export type MySignalsResponse = z.infer<typeof mySignalsResponseSchema>;

/** POST/DELETE /api/v1/events/:id/follow */
export const followStateSchema = z.object({ following: z.boolean() });

/** GET /api/v1/me/following */
export const followingResponseSchema = z.object({ events: z.array(eventSummarySchema).max(200) });
export type FollowingResponse = z.infer<typeof followingResponseSchema>;
