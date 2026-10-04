import { describe, expect, it } from "vitest";
import type { sourceRecords } from "../../src/db/schema";
import { parseDateValue, reconcileTimes, timeBounds, timesConsistent, type EvidenceTime } from "../../src/verification/dates";
import { fromSourceRecord, storedPublishedPrecision, toSourceRecordValues } from "../../src/verification/evidence";
import { assignLineages } from "../../src/verification/lineage";
import { mergeWithStored } from "../../src/verification/merge";
import { DEFAULT_POLICY, freshness, timeMatch, type TimedEvent } from "../../src/verification/policy";
import { communityReport, hoursAgo, minutesAgo, minutesFromNow, news, NOW, official, run } from "./factories";

/**
 * Date precision (S5A). A date-only value is a RANGE covering that calendar
 * day in every timezone, never midnight UTC as a moment. Freshness and time
 * relevance use the worst case; a range that straddles a boundary is unknown.
 */

const H = 60 * 60_000;
const day = (iso: string): EvidenceTime => ({ at: new Date(`${iso}T00:00:00Z`), precision: "day" });
const instant = (d: Date): EvidenceTime => ({ at: d, precision: "instant" });
/** Evidence whose only time is a publication DATE. */
const dated = (iso: string) => ({ publishedAt: new Date(`${iso}T00:00:00Z`), publishedAtPrecision: "day" as const, eventTimeAsReported: null, eventTimePrecision: null, retrievedAt: NOW });
const disruption = (over: Partial<TimedEvent> = {}): TimedEvent => ({ category: "crash", firstSeenAt: hoursAgo(1), scheduledStartAt: null, scheduledEndAt: null, ...over });

describe("parseDateValue: strict formats, real precision", () => {
  it.each([
    ["2026-10-03", "2026-10-03T00:00:00.000Z", "day"],
    ["2026-10-03T09:15:00Z", "2026-10-03T09:15:00.000Z", "instant"],
    ["2026-10-03T03:15:00-07:00", "2026-10-03T10:15:00.000Z", "instant"],
    ["2026-10-03T09:15:00.250+0000", "2026-10-03T09:15:00.250Z", "instant"],
    ["Sat, 03 Oct 2026 04:00:00 PDT", "2026-10-03T11:00:00.000Z", "instant"],
    ["3 Oct 2026 05:00 -0500", "2026-10-03T10:00:00.000Z", "instant"],
    // A clock time WITHOUT a zone is only a date: the zone is unknown.
    ["2026-10-03T09:15:00", "2026-10-03T00:00:00.000Z", "day"],
    ["2026-10-03 09:15", "2026-10-03T00:00:00.000Z", "day"],
  ])("%s → %s (%s)", (raw, iso, precision) => {
    expect(parseDateValue(raw, NOW)).toEqual({ at: new Date(iso), precision });
  });

  it.each([
    "2 hours ago",
    "yesterday",
    "2026",
    "10/03/2026",
    "October 3, 2026",
    "2026-02-30",
    "2026-13-01",
    "2026-10-03T25:00:00Z",
    "2026-10-03T09:00:00+15:00",
    "Sat, 03 Oct 2026 09:00:00 CEST", // a zone abbreviation that isn't defined: never guessed
    "1999-12-31",
    "2026-10-03T09:00:00Z".padEnd(80, " x"),
  ])("rejects %s", (raw) => {
    expect(parseDateValue(raw, NOW)).toBeNull();
  });

  it("rejects non-strings and future values, allowing only small clock skew", () => {
    for (const raw of [1791000000, null, undefined, { date: "2026-10-03" }]) expect(parseDateValue(raw, NOW)).toBeNull();
    expect(parseDateValue(minutesFromNow(30).toISOString(), NOW)?.precision).toBe("instant");
    expect(parseDateValue(minutesFromNow(90).toISOString(), NOW)).toBeNull();
    // NOW is 12:00 UTC on Oct 3: Oct 4 has already begun at UTC+14, Oct 5 has not begun anywhere.
    expect(parseDateValue("2026-10-04", NOW)?.precision).toBe("day");
    expect(parseDateValue("2026-10-05", NOW)).toBeNull();
  });
});

describe("timeBounds and reconciliation", () => {
  it("an instant is a point; a day spans that date in every timezone", () => {
    expect(timeBounds(instant(NOW))).toEqual({ earliest: NOW.getTime(), latest: NOW.getTime() });
    const b = timeBounds(day("2026-10-03"));
    expect(new Date(b.earliest).toISOString()).toBe("2026-10-02T10:00:00.000Z"); // 00:00 at UTC+14
    expect(new Date(b.latest).toISOString()).toBe("2026-10-04T11:59:59.999Z"); // 23:59:59.999 at UTC−12
  });

  it("keeps the more precise of two consistent statements, and drops both when they conflict", () => {
    const tolerance = DEFAULT_POLICY.timeConflictToleranceMinutes;
    const inside = instant(new Date("2026-10-03T08:00:00Z"));
    expect(reconcileTimes(day("2026-10-03"), inside, tolerance)).toEqual({ time: inside, conflict: false });
    expect(reconcileTimes(inside, day("2026-10-03"), tolerance)).toEqual({ time: inside, conflict: false });
    expect(reconcileTimes(day("2026-10-03"), day("2026-09-28"), tolerance)).toEqual({ time: null, conflict: true });
    expect(reconcileTimes(instant(hoursAgo(1)), instant(hoursAgo(1.5)), tolerance)).toEqual({ time: instant(hoursAgo(1)), conflict: false });
    expect(reconcileTimes(instant(hoursAgo(1)), instant(hoursAgo(3)), tolerance)).toEqual({ time: null, conflict: true });
    expect(reconcileTimes(null, inside, tolerance)).toEqual({ time: inside, conflict: false });
    expect(timesConsistent(day("2026-10-03"), day("2026-10-04"), 0)).toBe(true); // overlapping ranges
  });
});

describe("freshness and time relevance use the whole range (worst case)", () => {
  it("no midnight false precision: a date-only value is NOT fresh for an hour-scale event, though midnight UTC would be", () => {
    // 01:00 UTC on Oct 3, a crash first seen at 00:30. Read as midnight UTC, "2026-10-03" would look 1 hour old.
    const now = new Date("2026-10-03T01:00:00Z");
    const event = disruption({ firstSeenAt: new Date("2026-10-03T00:30:00Z") });
    const midnightAsInstant = { ...dated("2026-10-03"), publishedAtPrecision: "instant" as const };
    expect(freshness(midnightAsInstant, event, now)).toBe("fresh");
    expect(freshness(dated("2026-10-03"), event, now)).toBe("unknown");
    expect(timeMatch(dated("2026-10-03"), event, now)).toBe("unclear");
  });

  it("an imprecise time can't prove staleness either: a range straddling the stale boundary is unknown", () => {
    const closure = disruption({ category: "road_closure", firstSeenAt: hoursAgo(30) }); // stale after 24 h
    expect(freshness(dated("2026-10-02"), closure, NOW)).toBe("unknown");
    // Certainly older than the stale window: stale.
    expect(freshness(dated("2026-09-20"), closure, NOW)).toBe("stale");
    expect(timeMatch(dated("2026-09-20"), closure, NOW)).toBe("outdated");
  });

  it("freshness boundary: the oldest possible moment decides fresh vs aging", () => {
    const construction = disruption({ category: "construction", firstSeenAt: hoursAgo(100) }); // fresh 3 d, stale 14 d
    // Earliest possible: Sep 30 10:00 UTC = 74 h before NOW, past the 72 h fresh window: aging, not fresh.
    expect(freshness(dated("2026-10-01"), construction, NOW)).toBe("aging");
    // Earliest possible: Oct 1 10:00 UTC = 50 h: certainly fresh.
    expect(freshness(dated("2026-10-02"), construction, NOW)).toBe("fresh");
  });

  it("event-time boundary: a date-only time may or may not predate the event, so it is unclear, never current", () => {
    // First seen 07:00 UTC; "outdated" = more than 6 h before that. Oct 3 may have started Oct 2 10:00 UTC.
    const event = disruption({ category: "road_closure", firstSeenAt: new Date("2026-10-03T07:00:00Z") });
    expect(timeMatch(dated("2026-10-03"), event, NOW)).toBe("unclear");
    expect(timeMatch(dated("2026-10-01"), event, NOW)).toBe("outdated");
  });

  it("a day-scale rule can be satisfied by a date: scheduled events are judged against their schedule", () => {
    const festival: TimedEvent = { category: "festival", firstSeenAt: hoursAgo(2), scheduledStartAt: minutesFromNow(600), scheduledEndAt: minutesFromNow(1200) };
    expect(freshness(dated("2026-09-30"), festival, NOW)).toBe("fresh");
    expect(timeMatch(dated("2026-09-30"), festival, NOW)).toBe("current");
    // Announcements dated more than the 14-day lead before the start may describe a previous edition.
    expect(timeMatch(dated("2026-09-18"), festival, NOW)).toBe("outdated");
    expect(timeMatch(dated("2026-09-20"), festival, NOW)).toBe("unclear");
  });

  it("the reported event time takes precedence over publication, with ITS precision", () => {
    const e = { ...dated("2026-10-03"), eventTimeAsReported: minutesAgo(20), eventTimePrecision: "instant" as const };
    expect(freshness(e, disruption(), NOW)).toBe("fresh");
    const dayEvent = { ...e, eventTimeAsReported: new Date("2026-10-03T00:00:00Z"), eventTimePrecision: "day" as const, publishedAt: minutesAgo(5), publishedAtPrecision: "instant" as const };
    expect(freshness(dayEvent, disruption(), NOW)).toBe("unknown");
  });
});

describe("decisions with date-only evidence", () => {
  const dateOnly = (iso: string, over: Parameters<typeof news>[0] = {}) => news({ publishedAt: new Date(`${iso}T00:00:00Z`), publishedAtPrecision: "day", ...over });

  it("date-only sources never confirm an hour-scale event, and the explanation says why", () => {
    const d = run("UNVERIFIED", [communityReport(), dateOnly("2026-10-03", { sourceClass: "OFFICIAL", isPrimary: true }), dateOnly("2026-10-03")], { event: { category: "crash" } });
    expect(d.target).toBeNull();
    expect(d.facts.support).toHaveLength(0);
    expect(d.facts.dateOnly).toBe(2);
    expect(d.explanation).toMatch(/2 more sources give only a date, not a time/);
  });

  it("an official primary date-only announcement can verify a scheduled event (a day-scale rule)", () => {
    const d = run("UNVERIFIED", [official({ publishedAt: new Date("2026-09-30T00:00:00Z"), publishedAtPrecision: "day" })], {
      event: { category: "festival", scheduledStartAt: minutesFromNow(600), scheduledEndAt: minutesFromNow(1200), firstSeenAt: hoursAgo(2) },
    });
    expect(d).toMatchObject({ target: "VERIFIED", ruleId: "verified_primary_source" });
    expect(d.facts.dateOnly).toBe(0);
  });

  it("an 'ended' report known only to the day can't resolve an event against possibly-newer support", () => {
    const schedule = { category: "festival" as const, scheduledStartAt: hoursAgo(2), scheduledEndAt: minutesFromNow(600), firstSeenAt: hoursAgo(3) };
    const support = official({ publishedAt: minutesAgo(30) });
    const endedDateOnly = official({ stance: "ended", publishedAt: new Date("2026-10-03T00:00:00Z"), publishedAtPrecision: "day" });
    expect(run("VERIFIED", [support, endedDateOnly], { event: schedule }).ruleId).not.toBe("resolved_primary_end");
    // The same report with an exact, newer time does resolve it.
    expect(run("VERIFIED", [support, official({ stance: "ended", publishedAt: minutesAgo(5) })], { event: schedule }).target).toBe("RESOLVED");
  });

  it("does not move a verified event to STALE on a date-only time that may still be current", () => {
    const d = run("VERIFIED", [dateOnly("2026-10-02", { sourceClass: "OFFICIAL", isPrimary: true })], { event: { firstSeenAt: hoursAgo(30) } });
    expect(d.target).toBeNull();
    expect(d.reconfirmed).toBe(false);
    // Certainly older than the stale window: STALE.
    expect(run("VERIFIED", [dateOnly("2026-09-20", { sourceClass: "OFFICIAL", isPrimary: true })], { event: { firstSeenAt: hoursAgo(300) } }).target).toBe("STALE");
  });
});

describe("storage keeps the precision with the time", () => {
  type Row = typeof sourceRecords.$inferSelect;
  const asRow = (values: ReturnType<typeof toSourceRecordValues>): Row =>
    ({ id: "00000000-0000-4000-8000-0000000000d1", reportId: null, rawSnapshotRef: null, createdAt: NOW, ...values }) as Row;

  it("round-trips day precision through extraction_metadata v2", () => {
    const [record] = assignLineages([news({ publishedAt: new Date("2026-10-03T00:00:00Z"), publishedAtPrecision: "day", eventTimeAsReported: new Date("2026-10-02T00:00:00Z"), eventTimePrecision: "day" })]);
    const values = toSourceRecordValues(record!, "00000000-0000-4000-8000-00000000e001", { freshness: "unknown", timeMatch: "unclear" });
    expect(values.extractionMetadata).toMatchObject({ v: 2, published_at_precision: "day", event_time_precision: "day" });
    const back = fromSourceRecord(asRow(values));
    expect(back).toMatchObject({ publishedAtPrecision: "day", eventTimePrecision: "day" });
    expect(storedPublishedPrecision(asRow(values))).toBe("day");
  });

  it("reads v1 records (and community reports without metadata) as instants, and no time as no precision", () => {
    const [record] = assignLineages([news()]);
    const values = toSourceRecordValues(record!, "00000000-0000-4000-8000-00000000e001", { freshness: "fresh", timeMatch: "current" });
    const v1 = { ...(values.extractionMetadata as Record<string, unknown>), v: 1, published_at_precision: undefined };
    expect(fromSourceRecord(asRow({ ...values, extractionMetadata: v1 })).publishedAtPrecision).toBe("instant");
    expect(fromSourceRecord(asRow({ ...values, extractionMetadata: null })).publishedAtPrecision).toBe("instant");
    expect(fromSourceRecord(asRow({ ...values, publishedAt: null })).publishedAtPrecision).toBeNull();
  });

  it("never writes a precision without its time", () => {
    const [record] = assignLineages([news({ publishedAt: null, publishedAtPrecision: "day" })]);
    const values = toSourceRecordValues(record!, "00000000-0000-4000-8000-00000000e001", { freshness: "unknown", timeMatch: "unclear" });
    expect(values.extractionMetadata).toMatchObject({ published_at_precision: null });
  });
});

describe("merging a re-retrieved resource into its stored record", () => {
  const stored = news({ id: "00000000-0000-4000-8000-0000000000aa", publishedAt: new Date("2026-10-03T00:00:00Z"), publishedAtPrecision: "day" });

  it("keeps a known time when the new observation has none, and takes the more precise consistent one", () => {
    expect(mergeWithStored(stored, news({ canonicalUrl: stored.canonicalUrl, publishedAt: null, publishedAtPrecision: null }))).toMatchObject({
      id: stored.id,
      publishedAt: stored.publishedAt,
      publishedAtPrecision: "day",
    });
    const precise = new Date("2026-10-03T08:30:00Z");
    expect(mergeWithStored(stored, news({ canonicalUrl: stored.canonicalUrl, publishedAt: precise, publishedAtPrecision: "instant" }))).toMatchObject({ publishedAt: precise, publishedAtPrecision: "instant" });
  });

  it("drops both times when they materially conflict", () => {
    const merged = mergeWithStored(stored, news({ canonicalUrl: stored.canonicalUrl, publishedAt: new Date("2026-09-20T08:00:00Z"), publishedAtPrecision: "instant" }));
    expect(merged).toMatchObject({ publishedAt: null, publishedAtPrecision: null });
  });

  it("never lets a bare search snippet overwrite a record built from the page itself", () => {
    const enriched = { ...stored, retrievalMethod: "extract" as const, retrievalSteps: ["search" as const, "extract" as const], excerpt: "From the page." };
    expect(mergeWithStored(enriched, news({ canonicalUrl: stored.canonicalUrl, excerpt: "From a snippet." }))).toBeNull();
  });

  it("accumulates provenance steps on the one record", () => {
    const fresh = news({ canonicalUrl: stored.canonicalUrl, retrievalMethod: "extract", retrievalSteps: ["search", "extract"] });
    expect(mergeWithStored(stored, fresh)?.retrievalSteps).toEqual(["search", "extract"]);
  });
});

it("the day-precision range is centrally configured", () => {
  expect(DEFAULT_POLICY.dayPrecision).toEqual({ aheadHours: 14, behindHours: 12 });
  expect(timeBounds(day("2026-10-03"), DEFAULT_POLICY.dayPrecision).latest - timeBounds(day("2026-10-03"), DEFAULT_POLICY.dayPrecision).earliest).toBe(50 * H - 1);
});
