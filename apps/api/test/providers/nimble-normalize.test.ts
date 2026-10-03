import { describe, expect, it } from "vitest";
import { normalizeResult, parsePublishDate } from "../../src/providers/nimble/normalize";
import { buildQueries, sanitizeQueryText } from "../../src/providers/nimble/query";
import { buildSearchContext, type SearchPlace } from "../../src/verification/geocoding";
import { classifyOfficial, officialDomainsFor, OFFICIAL_SOURCES } from "../../src/verification/official-sources";
import type { EventForRetrieval } from "../../src/worker/ports";
import { nimbleResult } from "./mock-fetch";

const NOW = new Date("2026-10-03T12:00:00Z");
const PLACE: SearchPlace = { street: "Mission Street", neighborhood: "Mission District", city: "San Francisco", region: "California", countryCode: "US", provider: "test", retrievedAt: NOW };
const EVENT: EventForRetrieval = {
  id: "00000000-0000-4000-8000-000000000001",
  category: "road_closure",
  status: "UNVERIFIED",
  title: "Road blocked near Mission St",
  summary: "Two lanes closed",
  firstSeenAt: NOW,
  scheduledStartAt: null,
  scheduledEndAt: null,
};
const context = buildSearchContext({ category: "road_closure", title: EVENT.title, approximateLocation: "Mission St & 22nd St", reportLocationLabels: [] }, PLACE);
const norm = (over: Record<string, unknown> = {}, category: EventForRetrieval["category"] = "road_closure") =>
  normalizeResult(nimbleResult(over) as never, { category, context, query: "q", requestId: "req-1", now: NOW });

describe("query generation", () => {
  it("is deterministic and uses only category words, place names and the event title", () => {
    const a = buildQueries(EVENT, context, { maxSearches: 3, maxResults: 10 });
    const b = buildQueries(EVENT, context, { maxSearches: 3, maxResults: 10 });
    expect(a).toEqual(b);
    expect(a.map((q) => [q.id, q.query])).toEqual([
      ["q1", "road closure Mission St & 22nd St San Francisco California"],
      ["q2", "road closure Mission St & 22nd St"],
      ["q3", "Road blocked near Mission St San Francisco"],
    ]);
    expect(a.every((q) => q.searchDepth === "standard" && q.timeRange === "day" && q.country === "US")).toBe(true);
    expect(a[1]!.includeDomains).toEqual(expect.arrayContaining(["dot.ca.gov", "511.org", "sfmta.com", "sf.gov"]));
    expect(a[1]!.includeDomains).not.toContain("pge.com"); // not authoritative on road closures
  });

  it("respects the search limit and skips the official query where the registry has nothing", () => {
    expect(buildQueries(EVENT, context, { maxSearches: 1, maxResults: 10 }).map((q) => q.id)).toEqual(["q1"]);
    const elsewhere = buildSearchContext({ category: "road_closure", title: EVENT.title, approximateLocation: "Main St", reportLocationLabels: [] }, { ...PLACE, city: "Boise", region: "Idaho" });
    expect(buildQueries(EVENT, elsewhere, { maxSearches: 3, maxResults: 10 }).map((q) => q.id)).toEqual(["q1", "q3"]);
  });

  it("sanitizes user text: no operators, quotes, URLs or boolean words", () => {
    expect(sanitizeQueryText('site:evil.example "Mission St" -closed OR inurl:x https://x.example/y (and) <b>')).toBe("Mission St closed and b");
    const hostile = { ...EVENT, title: 'Closed "site:x.example" OR filetype:pdf https://track.example/?u=1' };
    const queries = buildQueries(hostile, context, { maxSearches: 3, maxResults: 10 });
    for (const q of queries) expect(q.query).not.toMatch(/site:|filetype:|"|https?:|\bOR\b/);
  });

  it("never sends coordinates, reporter, account or auth data", () => {
    const withData = { ...EVENT, title: "Road blocked near Mission St reported by reporter@example.com" };
    const queries = JSON.stringify(buildQueries(withData, context, { maxSearches: 3, maxResults: 10 }));
    expect(queries).not.toMatch(/37\.7|-122\.4|reporter_user|user_id|token|authorization|@/i);
  });

  it("returns no queries when there is nothing location-specific to search for", () => {
    const pinned = buildSearchContext({ category: "road_closure", title: EVENT.title, approximateLocation: "Location pinned on the map", reportLocationLabels: [] }, null);
    expect(buildQueries(EVENT, pinned, { maxSearches: 3, maxResults: 10 })).toEqual([]);
  });

  it("searches planned events from their announcement window, not a short time range", () => {
    const festival = { ...EVENT, category: "festival" as const, scheduledStartAt: new Date("2026-10-10T17:00:00Z") };
    const [q1] = buildQueries(festival, context, { maxSearches: 1, maxResults: 10 });
    expect(q1).toMatchObject({ startDate: "2026-09-26" });
    expect(q1!.timeRange).toBeUndefined();
  });
});

describe("official-source registry", () => {
  it("is structured: domain, organization, class, kind, scope and primary categories", () => {
    for (const entry of OFFICIAL_SOURCES) {
      expect(entry.domain).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
      expect(entry.organization.length).toBeGreaterThan(1);
      expect(["OFFICIAL", "FIRST_PARTY"]).toContain(entry.sourceClass);
      expect(entry.scope.country).toBe("US");
    }
  });

  it("classifies who a source is, not whether it is relevant", () => {
    expect(classifyOfficial("https://cad.chp.ca.gov/Traffic.aspx", "crash")).toMatchObject({ organization: "California Highway Patrol", sourceClass: "OFFICIAL", primaryForCategory: true });
    // A utility is official-ish (first party) for outages, never primary for a crash.
    expect(classifyOfficial("https://www.pge.com/outages", "crash")).toMatchObject({ sourceClass: "FIRST_PARTY", primaryForCategory: false });
    // Any .gov is OFFICIAL but never automatically primary.
    expect(classifyOfficial("https://www.somecounty.gov/news", "flooding")).toMatchObject({ sourceClass: "OFFICIAL", primaryForCategory: false, organization: null });
    expect(classifyOfficial("https://dot.ca.gov.evil.example/x", "road_closure")).toBeNull();
    expect(classifyOfficial("https://news.example/story", "road_closure")).toBeNull();
  });

  it("scopes official searches to the place", () => {
    expect(officialDomainsFor({ region: "California", city: "Oakland" }, "road_closure")).toContain("oaklandca.gov");
    expect(officialDomainsFor({ region: "California", city: "Oakland" }, "road_closure")).not.toContain("sf.gov");
    expect(officialDomainsFor({ region: null, city: null }, "flooding")).toEqual(["weather.gov"]);
  });
});

describe("normalizing a Nimble result into NormalizedEvidence", () => {
  it("builds located, attributed evidence with a verbatim excerpt and a returned publication date", () => {
    const out = norm({ content: "SAN FRANCISCO (AP) — Northbound lanes of Mission St are closed between 22nd St and 24th St after a water main break. Crews expect repairs into the evening." });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const e = out.evidence;
    expect(e).toMatchObject({
      canonicalUrl: "https://news.example/story-1",
      publisher: "news.example",
      sourceClass: "UNKNOWN",
      sourceType: "web_page",
      isPrimary: false,
      stance: "supports",
      locationMatch: "exact",
      publishedAt: new Date("2026-10-03T10:00:00Z"),
      retrievedAt: NOW,
      retrievalMethod: "search",
      classifiedBy: "rules",
      providerRequestId: "req-1",
      note: null,
    });
    expect(e.excerpt).toBe("SAN FRANCISCO (AP) — Northbound lanes of Mission St are closed between 22nd St and 24th St after a water main break.");
    expect(nimbleResult().content).toContain("Mission St are closed");
    expect(e.attributions.map((a) => a.origin)).toContain("associated press");
    expect(out.usable).toBe(true);
  });

  it("takes the verbatim excerpt from the description when content is empty (as the live API returned)", () => {
    const description = "Northbound lanes of Mission St are closed at 22nd St after a water main break …";
    const out = norm({ content: "", description });
    expect(out.ok && out.evidence.excerpt).toBe(description);
    expect(description).toContain(out.ok ? out.evidence.excerpt! : "x");
    expect(out.ok && out.evidence.stance).toBe("supports");
  });

  it("never uses retrieval time as publication time", () => {
    const out = norm({ additional_data: null });
    expect(out.ok && out.evidence.publishedAt).toBeNull();
    expect(out.ok && out.usable).toBe(false);
  });

  it("accepts only full, plausible publication dates", () => {
    expect(parsePublishDate({ publish_date: "2026-10-03" }, NOW)?.toISOString()).toBe("2026-10-03T00:00:00.000Z");
    expect(parsePublishDate({ published_at: "Sat, 03 Oct 2026 09:00:00 GMT" }, NOW)?.toISOString()).toBe("2026-10-03T09:00:00.000Z");
    expect(parsePublishDate({ publish_date: "2 hours ago" }, NOW)).toBeNull();
    expect(parsePublishDate({ publish_date: "2026" }, NOW)).toBeNull();
    expect(parsePublishDate({ publish_date: "2027-01-01" }, NOW)).toBeNull(); // future
    expect(parsePublishDate({ publish_date: "1999-12-31" }, NOW)).toBeNull();
    expect(parsePublishDate({ publish_date: 1791000000 }, NOW)).toBeNull();
    expect(parsePublishDate(null, NOW)).toBeNull();
  });

  it("keeps the quote null when no sentence safely describes the event", () => {
    const out = norm({ content: "The city council discussed next year's budget priorities at length.", description: "" });
    expect(out.ok && out.evidence.excerpt).toBeNull();
    expect(out.ok && out.evidence.stance).toBe("context");
  });

  it("classifies an official page as official, but it only counts if it is relevant and takes a stance", () => {
    const relevant = norm({ url: "https://dot.ca.gov/caltrans-near-me/district-4/d4-news/closure", content: "Caltrans: All lanes of Mission St are closed at 22nd St until further notice." });
    expect(relevant.ok && relevant.evidence).toMatchObject({ sourceClass: "OFFICIAL", publisher: "Caltrans", isPrimary: true, stance: "supports", locationMatch: "exact" });
    const irrelevant = norm({ url: "https://dot.ca.gov/news/2026-09-01-budget", title: "Caltrans budget update", content: "Caltrans released its annual budget report for highway maintenance programs." });
    expect(irrelevant.ok && irrelevant.evidence).toMatchObject({ sourceClass: "OFFICIAL", stance: "context", locationMatch: "unclear" });
    expect(irrelevant.ok && irrelevant.usable).toBe(false);
  });

  it("canonicalizes tracking variants and rejects unsafe URLs", () => {
    const tracked = norm({ url: "https://news.example/story-1?utm_source=feed&fbclid=1" });
    expect(tracked.ok && tracked.evidence).toMatchObject({ canonicalUrl: "https://news.example/story-1", originalUrl: "https://news.example/story-1?utm_source=feed&fbclid=1" });
    expect(norm({ url: "http://127.0.0.1/admin" })).toEqual({ ok: false, reason: "invalid_url" });
    expect(norm({ url: "javascript:alert(1)" })).toEqual({ ok: false, reason: "invalid_url" });
  });

  it("parses publisher identity from the registrable domain", () => {
    const out = norm({ url: "https://www.sfchronicle.com/bayarea/article/x.php" });
    expect(out.ok && out.evidence).toMatchObject({ publisher: "sfchronicle.com", publisherDomain: "sfchronicle.com" });
  });

  it("classifies negated or reversed text conservatively", () => {
    expect(norm({ content: "Despite rumors, Mission St is not closed at 22nd St." }).ok && norm({ content: "Despite rumors, Mission St is not closed at 22nd St." })).toMatchObject({ evidence: { stance: "context" } });
    expect(norm({ content: "Mission St is not closed at 22nd St, police said." })).toMatchObject({ evidence: { stance: "contradicts" } });
    expect(norm({ content: "Mission St at 22nd St was closed yesterday but reopened this morning." })).toMatchObject({ evidence: { stance: "ended" } });
  });
});
