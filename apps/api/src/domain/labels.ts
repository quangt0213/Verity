import type { EventStatus } from "@verity/contracts";

/** Location text for events whose reporter gave no landmark. Never usable as search context. */
export const PINNED_LOCATION_PLACEHOLDER = "Location pinned on the map";

/** Human labels for server-written timeline text (deterministic templates, never model output). */
export const STATUS_LABEL: Record<EventStatus, string> = {
  UNVERIFIED: "Unverified",
  DEVELOPING: "Developing",
  LIKELY: "Likely",
  VERIFIED: "Verified",
  CONFLICTING: "Conflicting",
  STALE: "Stale",
  RESOLVED: "Resolved",
  REJECTED: "Not supported",
};
