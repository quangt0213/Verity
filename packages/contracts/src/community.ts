import { z } from "zod";

const count = z.number().int().nonnegative();

/**
 * Aggregated community signals. Deliberately contains no user identifiers,
 * usernames, distances or locations: only counts within a recent window.
 */
export const communitySummarySchema = z.object({
  window_minutes: z.number().int().positive(),
  recent_confirmations: count,
  recent_disputes: count,
  resolved_reports: count,
  still_happening: z.object({
    yes: count,
    no: count,
    not_sure: count,
  }),
});
export type CommunitySummary = z.infer<typeof communitySummarySchema>;

export const STILL_HAPPENING_ANSWERS = ["yes", "no", "not_sure"] as const;
export type StillHappeningAnswer = (typeof STILL_HAPPENING_ANSWERS)[number];
