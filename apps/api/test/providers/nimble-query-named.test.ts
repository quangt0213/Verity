import { describe, expect, it } from "vitest";
import { buildQueries } from "../../src/providers/nimble/query";
import { createNimbleRetriever } from "../../src/providers/nimble/retriever";
import { buildSearchContext, type SearchPlace } from "../../src/verification/geocoding";
import type { EventForRetrieval } from "../../src/worker/ports";
import { DIA_SAN_JOSE_EVENT, RECONSTRUCTED_RESULTS } from "../fixtures/dia-san-jose";
import { json, mockFetch, nimbleResult } from "./mock-fetch";

const NOW = new Date("2026-03-10T12:00:00Z");
const SAN_JOSE: SearchPlace = { street: null, neighborhood: null, city: "San Jose", region: "California", countryCode: "US", provider: "t", retrievedAt: NOW };
const FESTIVAL: EventForRetrieval = {
  id: "00000000-0000-4000-8000-000000000031",
  category: "festival",
  status: "UNVERIFIED",
  title: DIA_SAN_JOSE_EVENT.title,
  summary: "",
  firstSeenAt: NOW,
  scheduledStartAt: null,
  scheduledEndAt: null,
};
const contextFor = (place: SearchPlace | null, label: string = DIA_SAN_JOSE_EVENT.label) =>
  buildSearchContext({ category: "festival", title: FESTIVAL.title, approximateLocation: label, reportLocationLabels: [] }, place);
const queries = (event: EventForRetrieval, place: SearchPlace | null = SAN_JOSE, maxSearches = 3) => buildQueries(event, contextFor(place), { maxSearches, maxResults: 10 });

describe("queries for named planned events (A1)", () => {
  it("lead with the quoted event name, then the venue; the category query is only a fallback", () => {
    for (const place of [SAN_JOSE, null]) {
      expect(queries(FESTIVAL, place).map((q) => [q.id, q.query, q.focus ?? "general"])).toEqual([
        ["q1", '"Día San José" Plaza de César Chávez 2026', "general"],
        ["q2", '"Día San José" California 2026', "news"],
        ["q3", "festival Plaza de César Chávez San Jose California", "news"],
      ]);
    }
  });

  it("adds the city when the name doesn't contain it, and the scheduled month when known", () => {
    const jazz = { ...FESTIVAL, title: "Summer Jazz Fest", reportedSchedules: [{ start: new Date("2026-08-08T18:00:00Z"), end: null }] };
    const q = queries(jazz);
    expect(q[0]).toMatchObject({ id: "q1", query: '"Summer Jazz" Plaza de César Chávez San Jose August 2026', startDate: "2026-07-25" });
    expect(q[1]!.query).toBe('"Summer Jazz" San Jose California August 2026');
    // An established schedule wins over a reporter's claim.
    const established = { ...jazz, scheduledStartAt: new Date("2026-09-12T18:00:00Z") };
    expect(queries(established)[0]!.query).toBe('"Summer Jazz" Plaza de César Chávez San Jose September 2026');
  });

  it("keeps the ceiling: never more than maxSearches", () => {
    expect(queries(FESTIVAL, SAN_JOSE, 1).map((q) => q.id)).toEqual(["q1"]);
    expect(queries(FESTIVAL, SAN_JOSE, 2).map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(queries(FESTIVAL, SAN_JOSE, 0)).toEqual([]);
  });

  it("never lets the title steer query syntax or leak contact details", () => {
    const hostile = { ...FESTIVAL, title: 'Día "San José" site:evil.example OR call 408-555-0100 me@x.example' };
    for (const q of queries(hostile)) {
      expect(q.query).not.toMatch(/site:|evil|\bOR\b|408|@/);
      // Quotes appear only as one balanced pair around the name Verity built.
      expect((q.query.match(/"/g) ?? []).length % 2).toBe(0);
    }
  });

  it("keeps category strategies for unnamed planned events and for disruptions", () => {
    const generic = { ...FESTIVAL, title: "Festival at the plaza" };
    expect(queries(generic).map((q) => [q.id, q.query])).toEqual([
      ["q1", "festival Plaza de César Chávez San Jose California"],
      ["q3", "Festival at the plaza San Jose"],
    ]);
    const crash = { ...FESTIVAL, category: "crash" as const, title: "Crash on Almaden Blvd" };
    const ctx = buildSearchContext({ category: "crash", title: crash.title, approximateLocation: "Almaden Blvd & Park Ave", reportLocationLabels: [] }, SAN_JOSE);
    expect(buildQueries(crash, ctx, { maxSearches: 3, maxResults: 10 })[0]).toMatchObject({ id: "q1", query: "crash Almaden Blvd & Park Ave San Jose California", focus: "news", timeRange: "day" });
  });
});

describe("retriever with the reconstructed results", () => {
  const retriever = (fetch: typeof globalThis.fetch) => createNimbleRetriever({ apiKey: "k-0123456789", baseUrl: "https://sdk.nimbleway.com", now: () => NOW, fetch });
  const results = RECONSTRUCTED_RESULTS.map((r) => nimbleResult({ ...r, additional_data: { publish_date: new Date(NOW.getTime() - 30 * 60_000).toISOString() } }));

  it("issues the fallback: unrelated festivals are neither usable nor promising", async () => {
    const mock = mockFetch(() => json({ results }));
    const out = await retriever(mock.fetch).search({ event: FESTIVAL, context: contextFor(SAN_JOSE), maxSearches: 3, signal: new AbortController().signal });
    expect(out.status).toBe("ok");
    expect(out.searchCount).toBe(3);
    expect(mock.calls[0]!.body!.query).toBe('"Día San José" Plaza de César Chávez 2026');
    const supporting = out.evidence.filter((e) => e.stance !== "context").map((e) => e.canonicalUrl);
    expect(supporting).toEqual(["https://www.sanjoseca.gov/news/dia-san-jose-2026"]);
    // Promising: the event's own page, and the same-venue page (located; reading it might name the event). Never another place or edition.
    expect(out.stats).toMatchObject({ results: 30, accepted: 10, promising: 2 });
  });
});
