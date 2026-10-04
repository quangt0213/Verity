import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { geocodeCache } from "../../src/db/schema";
import { lookupPlace, type ReverseGeocoder, type SearchPlace } from "../../src/verification/geocoding";
import { DEFAULT_POLICY } from "../../src/verification/policy";
import { durableGeocoder } from "../../src/worker/geocode-cache";
import { createTestContext, type TestContext } from "../helpers";
import { FakeClock } from "./harness";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

const DAY = 24 * 60 * 60_000;
const PLACE: Omit<SearchPlace, "retrievedAt"> = {
  street: "Mission Street",
  neighborhood: "Mission District",
  city: "San Francisco",
  region: "California",
  countryCode: "US",
  provider: "fake-geo",
};

function provider(behavior: () => Promise<SearchPlace | null>, name = "fake-geo"): ReverseGeocoder & { calls: number } {
  const p = { provider: name, calls: 0, reverse: async () => (p.calls++, behavior()) };
  return p;
}

let lat = 10;
const point = () => ({ latitude: (lat += 0.01), longitude: -100.0004 });

describe("durable geocode cache", () => {
  it("caches a result for 90 days and serves it without calling the provider", async () => {
    const clock = new FakeClock();
    const fake = provider(async () => ({ ...PLACE, retrievedAt: clock.now() }));
    const geocoder = durableGeocoder(fake, ctx.db, { now: clock.now });
    const p = point();
    expect(await geocoder.reverse(p)).toMatchObject({ city: "San Francisco" });
    clock.advance(89 * DAY);
    expect(await geocoder.reverse({ latitude: p.latitude + 0.0001, longitude: p.longitude })).toMatchObject({ city: "San Francisco" });
    expect(fake.calls).toBe(1);

    const [row] = await ctx.db.select().from(geocodeCache).where(eq(geocodeCache.provider, "fake-geo"));
    expect(row!.expiresAt.getTime() - row!.retrievedAt.getTime()).toBe(DEFAULT_POLICY.geocodeCache.okTtlDays * DAY);
    // Only derived place fields, provider, cell and timestamps are stored.
    expect(Object.keys(row!).sort()).toEqual(["cellKey", "city", "countryCode", "expiresAt", "neighborhood", "provider", "region", "retrievedAt", "status", "street"]);
  });

  it("calls the provider again once an entry expires", async () => {
    const clock = new FakeClock();
    const fake = provider(async () => ({ ...PLACE, retrievedAt: clock.now() }));
    const geocoder = durableGeocoder(fake, ctx.db, { now: clock.now });
    const p = point();
    await geocoder.reverse(p);
    clock.advance(91 * DAY);
    await geocoder.reverse(p);
    expect(fake.calls).toBe(2);
  });

  it("caches 'no result' for 7 days without calling the provider again", async () => {
    const clock = new FakeClock();
    const fake = provider(async () => null);
    const geocoder = durableGeocoder(fake, ctx.db, { now: clock.now });
    const p = point();
    expect(await geocoder.reverse(p)).toBeNull();
    clock.advance(6 * DAY);
    expect(await geocoder.reverse(p)).toBeNull();
    expect(fake.calls).toBe(1);
    clock.advance(2 * DAY);
    await geocoder.reverse(p);
    expect(fake.calls).toBe(2);
  });

  it("never caches a provider failure", async () => {
    const clock = new FakeClock();
    let fail = true;
    const fake = provider(async () => (fail ? Promise.reject(new Error("503")) : { ...PLACE, retrievedAt: clock.now() }), "flaky-geo");
    const geocoder = durableGeocoder(fake, ctx.db, { now: clock.now });
    const p = point();
    expect(await lookupPlace(geocoder, p)).toEqual({ status: "unavailable", place: null });
    expect(await ctx.db.select().from(geocodeCache).where(eq(geocodeCache.provider, "flaky-geo"))).toHaveLength(0);
    fail = false;
    expect((await lookupPlace(geocoder, p)).status).toBe("ok");
    expect(fake.calls).toBe(2);
  });

  it("keeps providers separate", async () => {
    const clock = new FakeClock();
    const p = point();
    const a = provider(async () => ({ ...PLACE, retrievedAt: clock.now() }), "geo-a");
    const b = provider(async () => ({ ...PLACE, city: "Elsewhere", retrievedAt: clock.now() }), "geo-b");
    await durableGeocoder(a, ctx.db, { now: clock.now }).reverse(p);
    expect(await durableGeocoder(b, ctx.db, { now: clock.now }).reverse(p)).toMatchObject({ city: "Elsewhere" });
    expect(b.calls).toBe(1);
  });
});
