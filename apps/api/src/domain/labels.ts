import type { EventStatus } from "@verity/contracts";

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
