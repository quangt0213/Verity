import { CATEGORY_KIND, EVENT_CATEGORIES } from "@verity/contracts";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  evidenceTime,
  freshness,
  recheckDelayMinutes,
  timeMatch,
  withinRecheckAge,
  type TimedEvent,
} from "../../src/verification/policy";
import { hoursAgo, minutesAgo, minutesFromNow, NOW } from "./factories";

const crash: TimedEvent = { category: "crash", firstSeenAt: minutesAgo(30), scheduledStartAt: null, scheduledEndAt: null };
const closure: TimedEvent = { ...crash, category: "road_closure" };
const at = (published: Date | null, eventTime: Date | null = null) => ({ publishedAt: published, eventTimeAsReported: eventTime, retrievedAt: NOW });

describe("verification policy", () => {
  it("defines ordered windows for every category, in one place", () => {
    for (const category of EVENT_CATEGORIES) {
      const p = DEFAULT_POLICY.categories[category];
      expect(p.freshMinutes, category).toBeGreaterThan(0);
      expect(p.staleMinutes, category).toBeGreaterThan(p.freshMinutes);
      expect(p.maxRecheckAgeHours, category).toBeGreaterThan(0);
    }
    expect(DEFAULT_POLICY.version).toMatch(/heuristics/);
  });

  it("E: a page retrieved now but published yesterday about a short-lived incident is NOT fresh", () => {
    const yesterday = at(hoursAgo(26));
    expect(freshness(yesterday, crash, NOW)).toBe("stale");
    expect(timeMatch(yesterday, crash, NOW)).toBe("outdated");
  });

  it("never uses retrieval time: without event or publication time, evidence is never fresh", () => {
    expect(evidenceTime(at(null))).toBeNull();
    expect(freshness(at(null), crash, NOW)).toBe("unknown");
    expect(timeMatch(at(null), crash, NOW)).toBe("unclear");
  });

  it("prefers the event time a source reports over its publication time", () => {
    // Published a minute ago, but describing a crash from yesterday.
    const recap = at(minutesAgo(1), hoursAgo(26));
    expect(freshness(recap, crash, NOW)).toBe("stale");
  });

  it("applies category windows: fresh, then aging, then stale", () => {
    expect(freshness(at(hoursAgo(3)), closure, NOW)).toBe("fresh");
    expect(freshness(at(hoursAgo(12)), closure, NOW)).toBe("aging");
    expect(freshness(at(hoursAgo(30)), closure, NOW)).toBe("stale");
    // The same 3-hour-old report is already aging for a crash.
    expect(freshness(at(hoursAgo(3)), crash, NOW)).toBe("aging");
  });

  it("marks evidence from well before the event's first sighting as an earlier incident", () => {
    const longAfter: TimedEvent = { ...closure, firstSeenAt: minutesAgo(10) };
    expect(timeMatch(at(hoursAgo(8)), longAfter, NOW)).toBe("outdated");
    expect(timeMatch(at(minutesAgo(20)), longAfter, NOW)).toBe("current");
  });

  it("judges planned events against their schedule", () => {
    expect(CATEGORY_KIND.concert).toBe("planned");
    const concert: TimedEvent = { category: "concert", firstSeenAt: hoursAgo(2), scheduledStartAt: minutesFromNow(24 * 60), scheduledEndAt: minutesFromNow(27 * 60) };
    // An announcement 10 days ahead still describes this occurrence; last year's does not.
    expect(freshness(at(hoursAgo(240)), concert, NOW)).toBe("fresh");
    expect(timeMatch(at(hoursAgo(240)), concert, NOW)).toBe("current");
    expect(freshness(at(hoursAgo(24 * 365)), concert, NOW)).toBe("stale");
    expect(timeMatch(at(hoursAgo(24 * 365)), concert, NOW)).toBe("outdated");

    const over: TimedEvent = { ...concert, scheduledStartAt: hoursAgo(5), scheduledEndAt: hoursAgo(3) };
    expect(freshness(at(minutesAgo(5)), over, NOW)).toBe("stale");
  });

  it("schedules rechecks by status and stops them for ended or old events", () => {
    expect(recheckDelayMinutes("UNVERIFIED", crash, NOW)).toBe(DEFAULT_POLICY.recheckMinutes.unconfirmed);
    expect(recheckDelayMinutes("UNVERIFIED", { ...crash, firstSeenAt: hoursAgo(3) }, NOW)).toBe(DEFAULT_POLICY.recheckMinutes.unconfirmedAfter2h);
    expect(recheckDelayMinutes("VERIFIED", crash, NOW)).toBe(DEFAULT_POLICY.recheckMinutes.confirmed);
    expect(recheckDelayMinutes("CONFLICTING", crash, NOW)).toBe(DEFAULT_POLICY.recheckMinutes.contested);
    expect(recheckDelayMinutes("RESOLVED", crash, NOW)).toBeNull();
    expect(recheckDelayMinutes("REJECTED", crash, NOW)).toBeNull();
    expect(withinRecheckAge({ ...crash, firstSeenAt: hoursAgo(13) }, NOW)).toBe(false);
    expect(recheckDelayMinutes("VERIFIED", { ...crash, firstSeenAt: hoursAgo(13) }, NOW)).toBeNull();
  });
});
