import { EVENT_STATUSES, type CommunitySummary, type EventSummary } from "@verity/contracts";
import { describe, expect, it } from "vitest";
import { MARKER_GROUPS, markerGroup, STATUS_DISPLAY } from "./display";
import { checkedText, communityReportNote, communitySummaryText, freshnessLine, sourcesText, stillHappeningText } from "./freshness";
import { relativeTime, scheduleText } from "./time";

const NOW = Date.parse("2026-10-01T15:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function event(partial: Partial<EventSummary> = {}): EventSummary {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    title: "Test",
    summary: "",
    category: "road_closure",
    coordinates: { latitude: 37.7, longitude: -122.4 },
    approximate_location: "Somewhere",
    affected_area: null,
    status: "VERIFIED",
    verification_state: "idle",
    origin: "community_report",
    source_count: 3,
    independent_source_count: 3,
    community_confirmation_count: 0,
    community_dispute_count: 0,
    first_seen_at: ago(60),
    last_updated_at: ago(30),
    last_verified_at: ago(4),
    last_checked_at: ago(4),
    scheduled_start_at: null,
    scheduled_end_at: null,
    expires_at: null,
    is_demo: true,
    ...partial,
  };
}

describe("freshness line", () => {
  it("states status, independent sources and last-checked time", () => {
    expect(freshnessLine(event(), NOW)).toBe("Verified · 3 independent sources · checked 4 min ago");
  });

  it("shows when copies make independent sources fewer than total", () => {
    expect(sourcesText({ source_count: 5, independent_source_count: 2 })).toBe("2 independent sources (5 total)");
    expect(sourcesText({ source_count: 1, independent_source_count: 1 })).toBe("1 source");
    expect(sourcesText({ source_count: 0, independent_source_count: 0 })).toBe("No sources yet");
  });

  it("puts verification state ahead of an old timestamp", () => {
    expect(checkedText(event({ verification_state: "in_progress" }), NOW)).toBe("verifying now");
    expect(checkedText(event({ verification_state: "unavailable", last_checked_at: ago(22) }), NOW)).toBe(
      "verification unavailable · tried 22 min ago",
    );
    expect(checkedText(event({ verification_state: "idle", last_checked_at: null }), NOW)).toBe("not yet checked");
  });

  it("labels unverified community reports", () => {
    expect(communityReportNote(event({ status: "UNVERIFIED", verification_state: "in_progress" }))).toBe(
      "Community report — verification in progress",
    );
    expect(communityReportNote(event({ status: "VERIFIED" }))).toBeNull();
    expect(communityReportNote(event({ status: "UNVERIFIED", origin: "source_discovered" }))).toBeNull();
  });
});

describe("no fake certainty", () => {
  it("never expresses status as a percentage or probability", () => {
    for (const status of EVENT_STATUSES) {
      const { label, description } = STATUS_DISPLAY[status];
      expect(`${label} ${description}`).not.toMatch(/%|percent|probab|confiden/i);
    }
  });

  it("never claims to prove truth", () => {
    for (const status of EVENT_STATUSES) {
      expect(STATUS_DISPLAY[status].description).not.toMatch(/\b(true|truth|proven|certain)\b/i);
    }
  });
});

describe("community wording is aggregate-only", () => {
  const base: CommunitySummary = {
    window_minutes: 60,
    recent_confirmations: 3,
    recent_disputes: 0,
    resolved_reports: 0,
    still_happening: { yes: 3, no: 0, not_sure: 0 },
  };

  it("counts people without identifying them or their location", () => {
    const text = stillHappeningText(base);
    expect(text).toBe("3 people confirmed this is still happening in the last hour.");
    expect(text).not.toMatch(/meters|km|miles|away|user/i);
  });

  it("reports mixed answers honestly", () => {
    expect(stillHappeningText({ ...base, still_happening: { yes: 2, no: 1, not_sure: 0 } })).toBe(
      "Mixed answers in the last hour: 2 people said yes, 1 person said no.",
    );
    expect(stillHappeningText({ ...base, still_happening: { yes: 0, no: 0, not_sure: 0 } })).toBeNull();
  });

  it("falls back to confirmations and disputes when nobody answered 'still happening'", () => {
    const none = { ...base, still_happening: { yes: 0, no: 0, not_sure: 0 } };
    expect(communitySummaryText({ ...none, recent_confirmations: 1 })).toBe("1 person confirmed this in the last hour.");
    expect(communitySummaryText({ ...none, recent_confirmations: 0, recent_disputes: 2 })).toBe("2 people disputed this in the last hour.");
    expect(communitySummaryText({ ...none, recent_confirmations: 0 })).toBeNull();
  });
});

describe("marker groups", () => {
  it("maps status and category to a small set of meaningful groups", () => {
    expect(markerGroup({ status: "VERIFIED", category: "crash" })).toBe("urgent");
    expect(markerGroup({ status: "LIKELY", category: "flooding" })).toBe("urgent");
    expect(markerGroup({ status: "DEVELOPING", category: "fire" })).toBe("developing");
    expect(markerGroup({ status: "CONFLICTING", category: "transit_disruption" })).toBe("developing");
    expect(markerGroup({ status: "UNVERIFIED", category: "fire" })).toBe("unverified");
    expect(markerGroup({ status: "VERIFIED", category: "concert" })).toBe("planned");
    expect(markerGroup({ status: "STALE", category: "crash" })).toBe("inactive");
    expect(markerGroup({ status: "RESOLVED", category: "protest" })).toBe("inactive");
  });

  it("distinguishes unverified markers by shape, not only color", () => {
    expect(MARKER_GROUPS.unverified.hollow).toBe(true);
    expect(MARKER_GROUPS.unverified.color).toBe(MARKER_GROUPS.developing.color);
  });
});

describe("time formatting", () => {
  it("formats relative times", () => {
    expect(relativeTime(ago(0.2), NOW)).toBe("just now");
    expect(relativeTime(ago(4), NOW)).toBe("4 min ago");
    expect(relativeTime(ago(130), NOW)).toBe("2 h ago");
    expect(relativeTime(ago(60 * 30), NOW)).toBe("yesterday");
    expect(relativeTime(new Date(NOW + 25 * 60_000).toISOString(), NOW)).toBe("in 25 min");
  });

  it("describes scheduled windows", () => {
    const opts = { locale: "en-US", timeZone: "UTC" };
    expect(scheduleText(new Date(NOW + 30 * 60_000).toISOString(), "2026-10-01T18:00:00Z", NOW, opts)).toBe(
      "Starts in 30 min · until 6:00 PM",
    );
    expect(scheduleText(ago(60), "2026-10-01T18:00:00Z", NOW, opts)).toBe("Happening now · until 6:00 PM");
    expect(scheduleText(ago(120), ago(30), NOW, opts)).toBe("Ended 30 min ago");
    expect(scheduleText(null, null, NOW)).toBeNull();
  });
});
