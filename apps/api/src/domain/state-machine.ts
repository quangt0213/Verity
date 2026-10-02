import type { EventStatus } from "@verity/contracts";
import type { ActorType } from "../db/schema";

/**
 * Allowed status edges. The verification engine (Phase 3) decides *when* an
 * edge is taken based on evidence; this table decides *which* edges can exist.
 */
export const ALLOWED_TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  UNVERIFIED: ["DEVELOPING", "LIKELY", "VERIFIED", "CONFLICTING", "STALE", "RESOLVED", "REJECTED"],
  DEVELOPING: ["LIKELY", "VERIFIED", "CONFLICTING", "STALE", "RESOLVED", "REJECTED"],
  LIKELY: ["DEVELOPING", "VERIFIED", "CONFLICTING", "STALE", "RESOLVED", "REJECTED"],
  VERIFIED: ["LIKELY", "CONFLICTING", "STALE", "RESOLVED"],
  CONFLICTING: ["DEVELOPING", "LIKELY", "VERIFIED", "STALE", "RESOLVED", "REJECTED"],
  STALE: ["DEVELOPING", "LIKELY", "VERIFIED", "CONFLICTING", "RESOLVED", "REJECTED"],
  // Re-investigation can reopen an ended event, but never straight to VERIFIED.
  RESOLVED: ["DEVELOPING", "CONFLICTING"],
  REJECTED: ["DEVELOPING"],
};

/**
 * Who may move an event into which status. Community input never changes
 * status: confirmations and disputes are counts and verification triggers only.
 */
const ACTOR_MAY_SET: Record<ActorType, readonly EventStatus[] | "any"> = {
  community: [],
  system: ["STALE", "RESOLVED"],
  verifier: "any",
  admin: "any",
};

export type TransitionCheck = { ok: true } | { ok: false; reason: string };

export function checkTransition(from: EventStatus, to: EventStatus, actor: ActorType): TransitionCheck {
  if (from === to) return { ok: false, reason: `Event is already ${to}` };
  if (!ALLOWED_TRANSITIONS[from].includes(to)) return { ok: false, reason: `${from} → ${to} is not an allowed transition` };
  const allowed = ACTOR_MAY_SET[actor];
  if (allowed !== "any" && !allowed.includes(to)) return { ok: false, reason: `A ${actor} actor cannot set ${to}` };
  return { ok: true };
}
