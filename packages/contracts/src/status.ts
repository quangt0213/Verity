import { z } from "zod";

/**
 * Evidence states for a canonical event. These describe what the current
 * evidence supports. They are not probabilities and never claim to prove truth.
 */
export const EVENT_STATUSES = [
  "UNVERIFIED",
  "DEVELOPING",
  "LIKELY",
  "VERIFIED",
  "CONFLICTING",
  "STALE",
  "RESOLVED",
  "REJECTED",
] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];
export const eventStatusSchema = z.enum(EVENT_STATUSES);

/** Statuses for events that may still be affecting the physical world. */
export const ACTIVE_STATUSES = [
  "UNVERIFIED",
  "DEVELOPING",
  "LIKELY",
  "VERIFIED",
  "CONFLICTING",
  "STALE",
] as const satisfies readonly EventStatus[];

export function isActiveStatus(status: EventStatus): boolean {
  return (ACTIVE_STATUSES as readonly EventStatus[]).includes(status);
}

/**
 * Where the verification workflow currently stands for an event, independent
 * of its evidence status. "unavailable" means the last attempt could not reach
 * live sources; existing evidence is preserved and nothing is inferred.
 */
export const VERIFICATION_STATES = ["queued", "in_progress", "idle", "unavailable"] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];
export const verificationStateSchema = z.enum(VERIFICATION_STATES);
