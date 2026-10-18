import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sourceRecords } from "../../src/db/schema";
import { createNimbleRetriever } from "../../src/providers/nimble/retriever";
import { processJob } from "../../src/worker/process";
import { DIA_SAN_JOSE_EVENT, RECONSTRUCTED_RESULTS } from "../fixtures/dia-san-jose";
import { createTestContext, type TestContext } from "../helpers";
import { json, mockFetch, nimbleResult } from "../providers/mock-fetch";
import { claimFor, deps, eventRow, FakeClock, fakeExtractor, fakeInvestigator, jobsFor, newEvent, runsFor, testConfig } from "./harness";

/**
 * The first live test, replayed with reconstructed results (fixtures/dia-san-jose.ts):
 * a named planned event whose category search returned festivals from all over the world.
 */

let ctx: TestContext;
let token: string;
beforeAll(async () => {
  ctx = await createTestContext();
  token = await ctx.signIn("named-event@example.com");
});
afterAll(async () => ctx.close());

const URL_OF = (key: string) => RECONSTRUCTED_RESULTS.find((r) => r.key === key)!.url;

function nimble(clock: FakeClock, handler?: Parameters<typeof mockFetch>[0]) {
  const published = clock.ago(30).toISOString();
  const mock = mockFetch(handler ?? (() => json({ request_id: "req-named", results: RECONSTRUCTED_RESULTS.map((r) => nimbleResult({ ...r, additional_data: { publish_date: published } })) })));
  return { mock, retriever: createNimbleRetriever({ apiKey: "fake-nimble-key-0123", baseUrl: "https://sdk.nimbleway.com", now: clock.now, fetch: mock.fetch }) };
}

const festival = () =>
  newEvent(ctx, token, { category: DIA_SAN_JOSE_EVENT.category, title: DIA_SAN_JOSE_EVENT.title, label: DIA_SAN_JOSE_EVENT.label, description: "Music and dancing at the plaza." });

describe("named planned event against the reconstructed 10-source result set", () => {
  it("stores the unrelated festivals as context only and leaves the event UNVERIFIED", async () => {
    const clock = new FakeClock();
    const eventId = await festival();
    const { mock, retriever } = nimble(clock);
    const extractor = fakeExtractor({});
    const investigator = fakeInvestigator();
    const outcome = await processJob(deps(ctx, clock, { retriever, extractor, investigator }), await claimFor(ctx, clock, eventId));

    expect(outcome).toBe("no_change");
    expect((await eventRow(ctx, eventId)).status).toBe("UNVERIFIED");

    const stored = await ctx.db.select().from(sourceRecords).where(and(eq(sourceRecords.eventId, eventId), isNotNull(sourceRecords.sourceUrl)));
    expect(stored).toHaveLength(10);
    const stances = Object.fromEntries(stored.map((r) => [r.sourceUrl, r.stance]));
    for (const r of RECONSTRUCTED_RESULTS.filter((x) => x.key !== "announcement")) expect(stances[r.url]).toBe("context");
    // The event's own announcement supports that it is PLANNED; it doesn't make it happening (see the explanation).
    expect(stances[URL_OF("announcement")]).toBe("supports");
    expect((await eventRow(ctx, eventId)).evidenceSummary).toContain("planned, not that it is happening now");

    // The searches led with the event's name; the category search was the fallback. Ceiling: 3.
    expect(mock.calls.map((c) => c.body!.query)).toEqual(['"Día San José" Plaza de César Chávez 2026', '"Día San José" California 2026', "festival Plaza de César Chávez San Jose California"]);
    for (const call of mock.calls) expect(JSON.stringify(call.body)).not.toMatch(/named-event@example\.com|reporter|user_id|\b3\d\.\d{2}/);

    // No page reads were spent on other places, other editions or unrelated festivals.
    expect(extractor.urls.every((u) => [URL_OF("announcement"), URL_OF("same_venue_other_event")].includes(u))).toBe(true);
    expect(extractor.urls).not.toContain(URL_OF("costa_rica"));
    expect(extractor.urls).not.toContain(URL_OF("last_year"));
    expect(extractor.urls.length).toBeLessThanOrEqual(testConfig().nimble.maxExtractsPerJob);
    expect(investigator.starts).toBeLessThanOrEqual(1);
    expect((await runsFor(ctx, eventId))[0]).toMatchObject({ searchCount: 3, decisionRuleId: "no_qualifying_evidence" });
  });

  it("never treats a provider outage as evidence that the event is false", async () => {
    const clock = new FakeClock();
    const eventId = await festival();
    const { retriever } = nimble(clock, () => json({}, 503));
    const outcome = await processJob(deps(ctx, clock, { retriever, investigator: fakeInvestigator() }), await claimFor(ctx, clock, eventId));
    expect(outcome).toBe("retry_scheduled");
    expect((await eventRow(ctx, eventId)).status).toBe("UNVERIFIED");
    expect((await jobsFor(ctx, eventId)).at(-1)!.status).toBe("pending");
  });

  it("respects the per-job search ceiling", async () => {
    const clock = new FakeClock();
    const eventId = await festival();
    const { mock, retriever } = nimble(clock);
    await processJob(deps(ctx, clock, { retriever, config: testConfig({ maxSearchesPerJob: 1 }), investigator: fakeInvestigator() }), await claimFor(ctx, clock, eventId));
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.body!.query).toBe('"Día San José" Plaza de César Chávez 2026');
  });
});
