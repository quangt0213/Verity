import { describe, expect, it } from "vitest";
import { createNimbleRetriever } from "../../src/providers/nimble/retriever";
import { createNominatimGeocoder } from "../../src/providers/nominatim";
import { buildSearchContext } from "../../src/verification/geocoding";
import { loadWorkerConfig } from "../../src/worker/config";
import type { EventForRetrieval } from "../../src/worker/ports";
import { json, mockFetch, nimbleResult } from "./mock-fetch";

const NOW = new Date("2026-10-03T12:00:00Z");
const EVENT: EventForRetrieval = {
  id: "00000000-0000-4000-8000-000000000002",
  category: "road_closure",
  status: "UNVERIFIED",
  title: "Road blocked near Mission St",
  summary: "",
  firstSeenAt: NOW,
  scheduledStartAt: null,
  scheduledEndAt: null,
};
const context = buildSearchContext(
  { category: "road_closure", title: EVENT.title, approximateLocation: "Mission St & 22nd St", reportLocationLabels: [] },
  { street: null, neighborhood: null, city: "San Francisco", region: "California", countryCode: "US", provider: "t", retrievedAt: NOW },
);
const retriever = (fetch: typeof globalThis.fetch) => createNimbleRetriever({ apiKey: "k-0123456789", baseUrl: "https://sdk.nimbleway.com", now: () => NOW, fetch });
const run = (fetch: typeof globalThis.fetch, maxSearches = 3) => retriever(fetch).search({ event: EVENT, context, maxSearches, signal: new AbortController().signal });
const usable = (n: number) => nimbleResult({ url: `https://outlet-${n}.example/a`, content: `Lanes of Mission St are closed at 22nd St, outlet ${n} reports.` });
const unusable = (n: number) => nimbleResult({ url: `https://other-${n}.example/a`, content: "The council discussed the budget.", additional_data: null });

describe("NimbleRetriever", () => {
  it("keeps evidence from successful queries when a later query fails (partial)", async () => {
    const mock = mockFetch((_c, i) => (i === 0 ? json({ results: [unusable(1)] }) : i === 1 ? json({ results: [usable(2)] }) : Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" }))));
    const out = await run(mock.fetch);
    expect(out.status).toBe("ok");
    expect(out.evidence.map((e) => e.canonicalUrl)).toEqual(["https://other-1.example/a", "https://outlet-2.example/a"]);
    expect(out.errorCode).toBe("partial_nimble_timeout");
    expect(out.searchCount).toBe(3);
    expect(out.stats).toMatchObject({ queries: 3, performed: 3, succeeded: 2, results: 2, accepted: 2, usable: 1 });
  });

  it("de-duplicates the same resource across queries, including tracking variants", async () => {
    const same = (q: string) => nimbleResult({ url: `https://news.example/story-1?utm_source=${q}` });
    const mock = mockFetch((_c, i) => json({ results: [same(`q${i}`), usable(9)] }));
    const out = await run(mock.fetch);
    expect(out.evidence.map((e) => e.canonicalUrl)).toEqual(["https://news.example/story-1", "https://outlet-9.example/a"]);
  });

  it("stops early: the title search runs only if earlier searches found too little usable evidence", async () => {
    const enough = mockFetch(() => json({ results: [usable(1), usable(2)] }));
    expect((await run(enough.fetch)).searchCount).toBe(2);
    expect(enough.calls.map((c) => c.body!.query)).not.toContain("Road blocked near Mission St San Francisco");
    const thin = mockFetch(() => json({ results: [unusable(3)] }));
    expect((await run(thin.fetch)).searchCount).toBe(3);
  });

  it("reports no_results when every search answered with nothing", async () => {
    const out = await run(mockFetch(() => json({ results: [] })).fetch);
    expect(out).toMatchObject({ status: "no_results", evidence: [], searchCount: 3, errorCode: null });
  });

  it("asks for a retry (never a verdict) when nothing came back and a search failed transiently", async () => {
    const mock = mockFetch((_c, i) => (i === 0 ? json({}, 429, { "retry-after": "300" }) : json({ results: [] })));
    expect(await run(mock.fetch)).toMatchObject({ status: "unavailable", errorCode: "nimble_rate_limited", retryAfterSeconds: 300 });
  });

  it("stops at once on rejected credentials and reports a permanent error", async () => {
    const mock = mockFetch(() => json({}, 401));
    expect(await run(mock.fetch)).toMatchObject({ status: "permanent_error", errorCode: "nimble_auth", searchCount: 1 });
    expect(mock.calls).toHaveLength(1);
  });

  it("never sends more searches than the job allows", async () => {
    const mock = mockFetch(() => json({ results: [] }));
    await run(mock.fetch, 1);
    expect(mock.calls).toHaveLength(1);
  });
});

describe("Nominatim adapter (mocked; never called live in tests)", () => {
  const ok = {
    address: { road: "Mission Street", neighbourhood: "Mission District", city: "San Francisco", state: "California", country_code: "us", postcode: "94110", house_number: "2400" },
  };

  it("sends rounded coordinates and an identifying User-Agent, and maps the address", async () => {
    const mock = mockFetch(() => json(ok));
    const geo = createNominatimGeocoder({ url: "https://nominatim.example", userAgent: "Verity/1.0 (ops@verity.example)", fetch: mock.fetch, now: () => NOW, sleep: async () => {} });
    const place = await geo.reverse({ latitude: 37.760123, longitude: -122.418912 });
    expect(place).toEqual({ street: "Mission Street", neighborhood: "Mission District", city: "San Francisco", region: "California", countryCode: "US", provider: "nominatim", retrievedAt: NOW });
    const url = new URL(mock.calls[0]!.url);
    expect(url.pathname).toBe("/reverse");
    expect(url.searchParams.get("lat")).toBe("37.760");
    expect(url.searchParams.get("lon")).toBe("-122.419");
    expect(mock.calls[0]!.headers["user-agent"]).toBe("Verity/1.0 (ops@verity.example)");
    // House numbers and postcodes are never kept.
    expect(JSON.stringify(place)).not.toMatch(/2400|94110/);
  });

  it("returns null for 'unable to geocode' and throws on failures (so they are never cached)", async () => {
    const none = createNominatimGeocoder({ url: "https://n.example", userAgent: "Verity (ops@v.example)", fetch: mockFetch(() => json({ error: "Unable to geocode" })).fetch, sleep: async () => {} });
    expect(await none.reverse({ latitude: 0, longitude: 0 })).toBeNull();
    const down = createNominatimGeocoder({ url: "https://n.example", userAgent: "Verity (ops@v.example)", fetch: mockFetch(() => json({}, 503)).fetch, sleep: async () => {} });
    await expect(down.reverse({ latitude: 0, longitude: 0 })).rejects.toThrow("nominatim_http_503");
  });

  it("makes at most one request per ~second, one at a time", async () => {
    let t = 0;
    const waits: number[] = [];
    const mock = mockFetch(() => json(ok));
    const geo = createNominatimGeocoder({ url: "https://n.example", userAgent: "Verity (ops@v.example)", fetch: mock.fetch, clock: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
    await Promise.all([geo.reverse({ latitude: 1, longitude: 1 }), geo.reverse({ latitude: 2, longitude: 2 }), geo.reverse({ latitude: 3, longitude: 3 })]);
    expect(mock.calls).toHaveLength(3);
    expect(waits).toEqual([1100, 1100]);
  });

  it("is off by default and needs an identifying User-Agent when enabled", () => {
    expect(loadWorkerConfig({ NODE_ENV: "test" }).geocoder).toBeNull();
    expect(() => loadWorkerConfig({ NODE_ENV: "test", GEOCODER_PROVIDER: "nominatim" })).toThrow(/GEOCODER_USER_AGENT/);
    expect(() => loadWorkerConfig({ NODE_ENV: "test", GEOCODER_PROVIDER: "nominatim", GEOCODER_USER_AGENT: "Verity (ops@v.example)", GEOCODER_URL: "http://evil.example" })).toThrow(/GEOCODER_URL/);
    expect(loadWorkerConfig({ NODE_ENV: "test", GEOCODER_PROVIDER: "nominatim", GEOCODER_USER_AGENT: "Verity (ops@v.example)" }).geocoder).toEqual({
      provider: "nominatim",
      url: "https://nominatim.openstreetmap.org",
      userAgent: "Verity (ops@v.example)",
    });
  });
});
