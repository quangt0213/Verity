/**
 * Deterministic synthetic events for performance tests only. They satisfy the
 * EventSummary contract and are marked is_demo. Never used by the app itself.
 */
const CATEGORIES = [
  "road_closure",
  "crash",
  "flooding",
  "fire",
  "police_activity",
  "transit_disruption",
  "construction",
  "power_outage",
  "protest",
  "parade",
  "concert",
  "sporting_event",
  "festival",
  "campus_event",
  "parking_traffic",
  "other",
] as const;
const STATUSES = ["UNVERIFIED", "DEVELOPING", "LIKELY", "VERIFIED", "CONFLICTING", "STALE", "RESOLVED"] as const;

export interface SyntheticEvent {
  id: string;
  title: string;
  summary: string;
  category: (typeof CATEGORIES)[number];
  coordinates: { latitude: number; longitude: number };
  approximate_location: string;
  affected_area: null;
  status: (typeof STATUSES)[number];
  verification_state: "idle";
  origin: "source_discovered";
  source_count: number;
  independent_source_count: number;
  community_confirmation_count: number;
  community_dispute_count: number;
  first_seen_at: string;
  last_updated_at: string;
  last_verified_at: string | null;
  last_checked_at: string | null;
  scheduled_start_at: null;
  scheduled_end_at: null;
  expires_at: null;
  is_demo: true;
}

/** Mulberry32: small seeded PRNG so runs are comparable. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` events spread over [west, south, east, north]. */
export function syntheticEvents(count: number, bbox: [number, number, number, number], seed = 1): SyntheticEvent[] {
  const rand = prng(seed);
  const [w, s, e, n] = bbox;
  const now = Date.parse("2026-10-17T12:00:00Z");
  return Array.from({ length: count }, (_, i) => {
    const t = new Date(now - Math.floor(rand() * 6 * 3600_000)).toISOString();
    const sources = 1 + Math.floor(rand() * 4);
    return {
      id: `perf-${seed}-${i}`,
      title: `Synthetic event ${i}`,
      summary: "Synthetic performance-test event.",
      category: CATEGORIES[Math.floor(rand() * CATEGORIES.length)]!,
      coordinates: { latitude: s + rand() * (n - s), longitude: w + rand() * (e - w) },
      approximate_location: "Synthetic area",
      affected_area: null,
      status: STATUSES[Math.floor(rand() * STATUSES.length)]!,
      verification_state: "idle",
      origin: "source_discovered",
      source_count: sources,
      independent_source_count: Math.max(1, sources - 1),
      community_confirmation_count: 0,
      community_dispute_count: 0,
      first_seen_at: t,
      last_updated_at: t,
      last_verified_at: t,
      last_checked_at: t,
      scheduled_start_at: null,
      scheduled_end_at: null,
      expires_at: null,
      is_demo: true,
    };
  });
}
