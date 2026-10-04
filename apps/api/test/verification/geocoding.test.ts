import { describe, expect, it, vi } from "vitest";
import {
  buildSearchContext,
  cachedGeocoder,
  geocodeCacheKey,
  lookupPlace,
  memoryGeocodeCache,
  type ReverseGeocoder,
  type SearchPlace,
} from "../../src/verification/geocoding";
import { NOW } from "./factories";

const PLACE: SearchPlace = {
  street: "Mission Street",
  neighborhood: "Mission District",
  city: "San Francisco",
  region: "California",
  countryCode: "US",
  provider: "test-provider",
  retrievedAt: NOW,
};

const POINT = { latitude: 37.76012, longitude: -122.41891 };

function fakeGeocoder(behavior: () => Promise<SearchPlace | null>): ReverseGeocoder & { calls: number } {
  const geocoder = {
    provider: "test-provider",
    calls: 0,
    reverse: vi.fn(async () => {
      geocoder.calls += 1;
      return behavior();
    }),
  };
  return geocoder;
}

const base = { category: "road_closure" as const, title: "Road blocked near Mission", reportLocationLabels: [] };

describe("geocode cache keys", () => {
  it("round to about 110 m so nearby events share one lookup", () => {
    expect(geocodeCacheKey(POINT)).toBe("37.760,-122.419");
    expect(geocodeCacheKey({ latitude: 37.76049, longitude: -122.41851 })).toBe(geocodeCacheKey(POINT));
    expect(geocodeCacheKey({ latitude: 37.7616, longitude: -122.4189 })).not.toBe(geocodeCacheKey(POINT));
    expect(geocodeCacheKey({ latitude: -0.0001, longitude: 0.0002 })).toBe("0.000,0.000");
  });
});

describe("place lookup", () => {
  it("turns provider failure into 'unavailable' and an empty result into 'no_result', never throwing", async () => {
    expect(await lookupPlace(fakeGeocoder(async () => PLACE), POINT)).toEqual({ status: "ok", place: PLACE });
    expect(await lookupPlace(fakeGeocoder(async () => null), POINT)).toEqual({ status: "no_result", place: null });
    expect(await lookupPlace(fakeGeocoder(async () => Promise.reject(new Error("503"))), POINT)).toEqual({ status: "unavailable", place: null });
  });

  it("caches results and empty results, but not provider failures", async () => {
    const ok = fakeGeocoder(async () => PLACE);
    const cached = cachedGeocoder(ok, memoryGeocodeCache());
    await cached.reverse(POINT);
    await cached.reverse({ latitude: 37.7603, longitude: -122.4191 });
    expect(ok.calls).toBe(1);

    const empty = fakeGeocoder(async () => null);
    const cachedEmpty = cachedGeocoder(empty, memoryGeocodeCache());
    await cachedEmpty.reverse(POINT);
    await cachedEmpty.reverse(POINT);
    expect(empty.calls).toBe(1);

    let fail = true;
    const flaky = fakeGeocoder(async () => (fail ? Promise.reject(new Error("timeout")) : PLACE));
    const cachedFlaky = cachedGeocoder(flaky, memoryGeocodeCache());
    expect((await lookupPlace(cachedFlaky, POINT)).status).toBe("unavailable");
    fail = false;
    expect((await lookupPlace(cachedFlaky, POINT)).status).toBe("ok");
    expect(flaky.calls).toBe(2);
  });

  it("keeps the in-memory cache bounded", async () => {
    const geocoder = fakeGeocoder(async () => PLACE);
    const cached = cachedGeocoder(geocoder, memoryGeocodeCache(2));
    for (const lat of [10, 20, 30, 10]) await cached.reverse({ latitude: lat, longitude: 0 });
    expect(geocoder.calls).toBe(4);
  });
});

describe("search context", () => {
  it("puts the reporter's own words first and supplements them with derived place names", () => {
    const context = buildSearchContext(
      { ...base, approximateLocation: "Mission St & 22nd St", reportLocationLabels: ["mission st & 22nd st", "Near the BART station"] },
      PLACE,
    );
    expect(context.locationTerms).toEqual(["Mission St & 22nd St", "Near the BART station", "Mission Street", "Mission District"]);
    expect(context.termSources).toEqual(["reporter", "reporter", "derived", "derived"]);
    expect(context).toMatchObject({ city: "San Francisco", region: "California", countryCode: "US", searchable: true });
    expect(context.derivedFrom).toEqual({ provider: "test-provider", retrievedAt: NOW });
  });

  it("never uses the map-pin placeholder as search context", () => {
    const pinned = { ...base, approximateLocation: "Location pinned on the map", reportLocationLabels: ["LOCATION PINNED ON THE MAP"] };
    expect(buildSearchContext(pinned, null)).toMatchObject({ locationTerms: [], searchable: false, derivedFrom: null });
    const derived = buildSearchContext(pinned, PLACE);
    expect(derived.locationTerms).toEqual(["Mission Street", "Mission District"]);
    expect(derived.termSources).toEqual(["derived", "derived"]);
  });

  it("works without a provider: a geocoder failure only means less context", () => {
    const context = buildSearchContext({ ...base, approximateLocation: "Mission St & 22nd St" }, null);
    expect(context).toMatchObject({ locationTerms: ["Mission St & 22nd St"], city: null, searchable: true, derivedFrom: null });
  });

  it("contains no coordinates and rejects malformed provider fields", () => {
    const context = buildSearchContext({ ...base, approximateLocation: "Mission St" }, { ...PLACE, countryCode: "usa", city: " " });
    expect(JSON.stringify(context)).not.toMatch(/37\.76|122\.41/);
    expect(context.countryCode).toBeNull();
    expect(context.city).toBeNull();
  });
});
