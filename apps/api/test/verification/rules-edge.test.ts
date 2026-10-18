import { describe, expect, it } from "vitest";
import type { NormalizedEvidence } from "../../src/verification/evidence";
import type { Retrieval } from "../../src/verification/rules";
import { communityReport, hoursAgo, minutesAgo, minutesFromNow, news, official, run } from "./factories";

/**
 * V3: edge cases of the decision rule table. These pin existing behavior and
 * invariants; no rule is changed here.
 */

const RANK: Record<string, number> = { UNVERIFIED: 0, DEVELOPING: 1, LIKELY: 2, VERIFIED: 3 };
const firstParty = (over: Partial<NormalizedEvidence> = {}) =>
  official({ canonicalUrl: `https://www.pge.com/outages/${Math.random().toString(36).slice(2, 8)}`, publisher: "PG&E", sourceName: "PG&E", sourceClass: "FIRST_PARTY", ...over });

/** A range of evidence situations, from nothing to contested. */
const SCENARIOS: Array<[string, () => NormalizedEvidence[]]> = [
  ["nothing", () => []],
  ["community only", () => [communityReport(), communityReport()]],
  ["one news source", () => [news()]],
  ["two news sources", () => [news(), news()]],
  ["primary official", () => [official()]],
  ["official contradiction", () => [official({ stance: "contradicts" })]],
  ["support and contradiction", () => [news(), news({ stance: "contradicts" })]],
  ["official ended", () => [news({ publishedAt: minutesAgo(90) }), official({ stance: "ended", publishedAt: minutesAgo(10) })]],
  ["stale only", () => [news({ publishedAt: hoursAgo(30) })]],
];

describe("V3: invariants hold across every situation", () => {
  it.each(SCENARIOS)("%s: retrieval outcomes never change the verdict", (_name, make) => {
    const evidence = make();
    const targets = (["ok", "no_results", "unavailable", "not_attempted"] as Retrieval[]).map((retrieval) => run("UNVERIFIED", evidence, { retrieval }).target);
    expect(new Set(targets).size).toBe(1);
  });

  it.each(SCENARIOS)("%s: community disputes and confirmations alone never change the verdict", (_name, make) => {
    const evidence = make();
    const base = run("DEVELOPING", evidence).target;
    expect(run("DEVELOPING", evidence, { community: { disputes: 50 } }).target).toBe(base);
    expect(run("DEVELOPING", evidence, { community: { confirmations: 50, stillHappening: 50, noLongerHappening: 50 } }).target).toBe(base);
  });

  it.each(SCENARIOS)("%s: the decision is deterministic", (_name, make) => {
    const evidence = make();
    expect(run("UNVERIFIED", evidence)).toEqual(run("UNVERIFIED", evidence));
  });

  it.each(SCENARIOS)("%s: no explanation states a percentage or probability", (_name, make) => {
    expect(run("UNVERIFIED", make()).explanation).not.toMatch(/%|percent|probab|confiden|likelihood/i);
  });
});

describe("V3: rule priority and boundaries", () => {
  it("a newer primary 'ended' wins over support and contradiction (RESOLVED before CONFLICTING)", () => {
    const d = run("VERIFIED", [news({ publishedAt: minutesAgo(90) }), news({ stance: "contradicts", publishedAt: minutesAgo(80) }), official({ stance: "ended", publishedAt: minutesAgo(5) })]);
    expect(d).toMatchObject({ ruleId: "resolved_primary_end", target: "RESOLVED" });
  });

  it("an 'ended' report only as precise as a date can't resolve an event supported today", () => {
    const today = new Date(Date.UTC(2026, 9, 3));
    const d = run("VERIFIED", [official({ publishedAt: minutesAgo(30) }), official({ stance: "ended", publishedAt: today, publishedAtPrecision: "day" })]);
    expect(d.target).not.toBe("RESOLVED");
  });

  it("a later update from the same source replaces its earlier stance (newest record of a lineage wins)", () => {
    const url = "https://dot.ca.gov/alerts/same";
    const earlier = official({ canonicalUrl: `${url}?v=1`, originRef: "caltrans:alert-7", publishedAt: minutesAgo(90) });
    const later = official({ canonicalUrl: `${url}?v=2`, originRef: "caltrans:alert-7", stance: "ended", publishedAt: minutesAgo(10) });
    const d = run("VERIFIED", [earlier, later]);
    expect(d.facts.support).toHaveLength(0);
    expect(d).toMatchObject({ ruleId: "resolved_primary_end", target: "RESOLVED" });
  });

  it("REJECTED needs a primary official contradiction AND an unconfirmed event", () => {
    expect(run("UNVERIFIED", [official({ stance: "contradicts" })]).target).toBe("REJECTED");
    expect(run("DEVELOPING", [official({ stance: "contradicts" })]).target).toBe("REJECTED");
    for (const status of ["LIKELY", "VERIFIED"] as const) expect(run(status, [official({ stance: "contradicts" })]).target).toBe("CONFLICTING");
    // A non-primary official contradiction never rejects.
    expect(run("UNVERIFIED", [official({ stance: "contradicts", isPrimary: false })]).target).toBeNull();
  });

  it("near-located support counts, but verifying on independent sources needs one exact location", () => {
    const near = [firstParty({ isPrimary: false, locationMatch: "near" }), news({ locationMatch: "near" })];
    expect(run("UNVERIFIED", near).target).toBe("LIKELY");
    expect(run("UNVERIFIED", [near[0]!, news({ locationMatch: "exact" })]).target).toBe("VERIFIED");
  });

  it("a FIRST_PARTY primary source verifies for its own category (a utility's outage)", () => {
    const d = run("UNVERIFIED", [firstParty()], { event: { category: "power_outage" } });
    expect(d).toMatchObject({ ruleId: "verified_primary_source", target: "VERIFIED" });
  });

  it("an aging primary source keeps an event verified but doesn't refresh 'last verified'", () => {
    // Crash: fresh for 2 hours, aging until 6.
    const d = run("VERIFIED", [official({ publishedAt: hoursAgo(4) })], { event: { category: "crash", firstSeenAt: hoursAgo(5) } });
    expect(d).toMatchObject({ target: null, guard: "already_in_state", reconfirmed: false });
    expect(run("VERIFIED", [official({ publishedAt: hoursAgo(1) })], { event: { category: "crash", firstSeenAt: hoursAgo(2) } }).reconfirmed).toBe(true);
  });

  it("support with an unclear location never counts, even from a primary official source", () => {
    const d = run("UNVERIFIED", [official({ locationMatch: "unclear" })]);
    expect(d).toMatchObject({ target: null, escalation: "location_unclear" });
  });

  it("one external source plus community reports reaches LIKELY at most; community alone changes nothing", () => {
    expect(run("UNVERIFIED", [news(), communityReport()]).target).toBe("LIKELY");
    expect(run("UNVERIFIED", [communityReport(), communityReport(), communityReport()]).target).toBeNull();
  });

  it("evidence never raises an event past what it supports, and the no-downgrade guard never lowers it", () => {
    for (const [, make] of SCENARIOS) {
      for (const status of ["DEVELOPING", "LIKELY", "VERIFIED"] as const) {
        const d = run(status, make());
        if (d.target && d.target in RANK) expect(RANK[d.target]!).toBeGreaterThanOrEqual(RANK[status]!);
      }
    }
  });
});

describe("V3: planned events (scheduled is not occurring)", () => {
  const schedule = { category: "festival" as const, firstSeenAt: minutesAgo(30) };
  const announcement = (over: Partial<NormalizedEvidence> = {}) =>
    official({ publishedAt: hoursAgo(48), isPrimary: true, excerpt: "The Harvest Festival will be held at Main St Plaza on Saturday from noon to 6 p.m.", ...over });

  it("an announcement-framed record doesn't verify an event before its scheduled start", () => {
    const d = run("UNVERIFIED", [announcement()], { event: { ...schedule, scheduledStartAt: minutesFromNow(60), scheduledEndAt: minutesFromNow(600) } });
    expect(d.target).toBeNull();
    expect(d.facts.announcedOnly).toBe(1);
  });

  it("the same announcement counts once the established schedule is underway", () => {
    const d = run("UNVERIFIED", [announcement()], { event: { ...schedule, scheduledStartAt: minutesAgo(30), scheduledEndAt: minutesFromNow(300) } });
    expect(d).toMatchObject({ target: "VERIFIED", ruleId: "verified_primary_source" });
  });

  it("without an established schedule an announcement never counts", () => {
    expect(run("UNVERIFIED", [announcement({ publishedAt: minutesAgo(20) })], { event: schedule }).facts.support).toHaveLength(0);
  });

  it("nothing whose time lies entirely in the future qualifies", () => {
    const future = news({ eventTimeAsReported: minutesFromNow(48 * 60), eventTimePrecision: "instant" });
    expect(run("UNVERIFIED", [future, communityReport()]).facts.support).toHaveLength(0);
  });

  it("without a known end, the schedule never resolves an event (an end is never inferred)", () => {
    const d = run("VERIFIED", [official({ publishedAt: hoursAgo(20) })], { event: { ...schedule, scheduledStartAt: hoursAgo(30), scheduledEndAt: null } });
    expect(d.ruleId).not.toBe("resolved_schedule_ended");
  });

  it("an announcement doesn't affect disruptions (their windows already exclude old announcements)", () => {
    const closure = news({ excerpt: "Mission St will be closed between 22nd and 24th St." });
    // Disruption stance classification makes hypothetical sentences context before they get here; a stored "supports" still judges normally.
    expect(run("UNVERIFIED", [closure]).facts.announcedOnly).toBe(0);
  });
});
