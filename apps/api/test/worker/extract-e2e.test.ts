import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sourceRecords } from "../../src/db/schema";
import { createNimbleExtractor } from "../../src/providers/nimble/extract";
import { createNimbleRetriever } from "../../src/providers/nimble/retriever";
import { processJob } from "../../src/worker/process";
import { createTestContext, type TestContext } from "../helpers";
import { extractResponse, json, mockFetch, nimbleResult, type RecordedCall } from "../providers/mock-fetch";
import { budgetUsed } from "../../src/worker/budget";
import { claimFor, deps, eventRow, FakeClock, fakeInvestigator, newEvent, runsFor, testConfig } from "./harness";

/**
 * S5B end to end: worker + Nimble lite Search + Nimble Extract over mocked
 * HTTP, on PGlite. One record per resource, accurate cost counters, early
 * stopping, the extraction ceiling, and the Agent held back while cheaper
 * deterministic options remain unused.
 */

let ctx: TestContext;
let token: string;
beforeAll(async () => {
  ctx = await createTestContext();
  token = await ctx.signIn("extract-e2e@example.com");
});
afterAll(async () => ctx.close());

type Page = { text: string; published?: string; status?: number; finalUrl?: string };

/** Route mocked Nimble calls: /v2/search gets `search(i)`, /v2/extract gets the page registered for its URL. */
function nimble(clock: FakeClock, search: (call: RecordedCall, index: number) => Response, pages: Record<string, Page | Response>) {
  let searches = 0;
  const mock = mockFetch((call) => {
    if (call.url.endsWith("/v2/search")) return search(call, searches++);
    const page = pages[String(call.body!.url)];
    if (!page) return json(extractResponse({ status: "failed" }));
    if (page instanceof Response) return page;
    const html = page.published ? `<meta property="article:published_time" content="${page.published}">` : "<p></p>";
    return json(extractResponse({ url: page.finalUrl ?? call.body!.url, status_code: page.status ?? 200 }, { html, markdown: page.text }));
  });
  const options = { apiKey: "fake-nimble-key-0123", baseUrl: "https://sdk.nimbleway.com", now: clock.now, fetch: mock.fetch };
  return {
    mock,
    retriever: createNimbleRetriever(options),
    extractor: createNimbleExtractor(options),
    searchCalls: () => mock.calls.filter((c) => c.url.endsWith("/v2/search")),
    extractCalls: () => mock.calls.filter((c) => c.url.endsWith("/v2/extract")),
  };
}

/** A lite news result: a short snippet (no usable sentence), a date-only publication date. */
const liteHit = (clock: FakeClock, url: string, over: Record<string, unknown> = {}) =>
  nimbleResult({ url, title: "Traffic update", description: "Updates on the closure near the intersection.", content: "", additional_data: { publish_date: clock.now().toISOString().slice(0, 10), source: "Outlet" }, ...over });

const external = (eventId: string) => ctx.db.select().from(sourceRecords).where(and(eq(sourceRecords.eventId, eventId), isNotNull(sourceRecords.sourceUrl)));

describe("worker + lite Search + Extract (mocked HTTP)", () => {
  it("enriches each Search result in place: one record per resource, exact times from the page, accurate counts", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token, { label: "Valencia St & 9th Ave" });
    const a = "https://outlet-a.example/valencia";
    const b = "https://outlet-b.example/valencia-closure";
    const n = nimble(clock, () => json({ request_id: "req-1", results: [liteHit(clock, a), liteHit(clock, b)] }), {
      [a]: { text: "Valencia St is closed at 9th Ave after a water main break, crews said.", published: clock.ago(20).toISOString() },
      [b]: { text: "Drivers report that lanes of Valencia St are blocked near 9th Ave this morning.", published: clock.ago(15).toISOString() },
    });
    await processJob(deps(ctx, clock, { retriever: n.retriever, extractor: n.extractor, investigator: fakeInvestigator() }), await claimFor(ctx, clock, eventId));

    const rows = await external(eventId);
    expect(rows.map((r) => r.sourceUrl).sort()).toEqual([a, b]);
    for (const row of rows) {
      expect(row.extractionMetadata).toMatchObject({ v: 2, retrieval_steps: ["search", "extract"], retrieval_method: "extract", published_at_precision: "instant", extract_ref: "task_abc" });
      expect(row.locationMatch).toBe("exact");
    }
    // Two UNKNOWN sources, however good, stay below VERIFIED (S4.1 product rule).
    expect((await eventRow(ctx, eventId)).status).toBe("LIKELY");
    const [run] = await runsFor(ctx, eventId);
    expect(run).toMatchObject({ searchCount: n.searchCalls().length, extractCount: n.extractCalls().length });
    expect(n.extractCalls()).toHaveLength(2);
    // The page fetch request carried nothing about the reporter or the event location.
    for (const call of n.extractCalls()) expect(JSON.stringify(call.body)).not.toMatch(/extract-e2e@example\.com|Valencia|9th Ave|latitude/);
  });

  it("extracts nothing when Search alone is already decisive", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token, { label: "Guerrero St & 5th Ave" });
    const n = nimble(
      clock,
      () =>
        json({
          results: [
            nimbleResult({ url: "https://dot.ca.gov/alerts/guerrero", content: "All lanes of Guerrero St are closed at 5th Ave for emergency repairs.", additional_data: { publish_date: clock.ago(10).toISOString() } }),
            liteHit(clock, "https://outlet-c.example/guerrero"),
          ],
        }),
      {},
    );
    await processJob(deps(ctx, clock, { retriever: n.retriever, extractor: n.extractor, investigator: fakeInvestigator() }), await claimFor(ctx, clock, eventId));
    expect((await eventRow(ctx, eventId)).status).toBe("VERIFIED");
    expect(n.extractCalls()).toHaveLength(0);
    expect((await runsFor(ctx, eventId))[0]!.extractCount).toBe(0);
  });

  it("never exceeds 4 extractions per job, however many candidates remain", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token, { label: "Harrison St & 7th Ave" });
    const urls = Array.from({ length: 7 }, (_, i) => `https://outlet-${i}.example/harrison`);
    const pages = Object.fromEntries(urls.map((u, i) => [u, { text: `Report ${i}: Harrison St remains closed at 7th Ave, witness ${i} said, as detour signs went up on block ${i * 13}.`, published: clock.ago(10 + i).toISOString() }]));
    const n = nimble(clock, () => json({ results: urls.map((u) => liteHit(clock, u, { description: "Harrison St closure near 7th Ave." })) }), pages);
    await processJob(deps(ctx, clock, { retriever: n.retriever, extractor: n.extractor, investigator: fakeInvestigator() }), await claimFor(ctx, clock, eventId));
    expect(n.extractCalls()).toHaveLength(4);
    expect((await runsFor(ctx, eventId))[0]!.extractCount).toBe(4);
  });

  it("does not spend extractions on obvious duplicates (one page per lineage)", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token, { label: "Bryant St & 2nd Ave" });
    const wire = (i: number) => liteHit(clock, `https://paper-${i}.example/bryant`, { description: "SAN FRANCISCO (AP) — Bryant St is closed near 2nd Ave." });
    const n = nimble(clock, () => json({ results: [wire(1), wire(2), wire(3), liteHit(clock, "https://radio.example/bryant", { description: "Bryant St closure at 2nd Ave." })] }), {});
    await processJob(deps(ctx, clock, { retriever: n.retriever, extractor: n.extractor, investigator: fakeInvestigator() }), await claimFor(ctx, clock, eventId));
    expect(n.extractCalls().map((c) => c.body!.url)).toEqual(["https://paper-1.example/bryant", "https://radio.example/bryant"]);
  });

  it("skips a page whose redirect leaves the site, and moves on to the next candidate", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token, { label: "Taylor St & 4th Ave" });
    const a = "https://outlet-x.example/taylor";
    const b = "https://outlet-y.example/taylor";
    const n = nimble(clock, () => json({ results: [liteHit(clock, a, { description: "Taylor St closed at 4th Ave." }), liteHit(clock, b, { description: "Taylor St closure near 4th Ave." })] }), {
      [a]: { text: "Taylor St is closed at 4th Ave.", published: clock.ago(5).toISOString(), finalUrl: "https://elsewhere.example/landing" },
      [b]: { text: "Taylor St is closed at 4th Ave, officials said.", published: clock.ago(5).toISOString() },
    });
    await processJob(deps(ctx, clock, { retriever: n.retriever, extractor: n.extractor, investigator: fakeInvestigator() }), await claimFor(ctx, clock, eventId));
    const rows = await external(eventId);
    expect(rows.find((r) => r.sourceUrl === a)!.extractionMetadata).toMatchObject({ retrieval_steps: ["search"] });
    expect(rows.find((r) => r.sourceUrl === b)!.extractionMetadata).toMatchObject({ retrieval_steps: ["search", "extract"] });
  });

  it("holds the Agent back while extraction is blocked (outage or budget), keeping the Search evidence", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token, { label: "Mason St & 6th Ave" });
    const url = "https://outlet-m.example/mason";
    const n = nimble(clock, () => json({ results: [liteHit(clock, url, { description: "Mason St closure near 6th Ave." })] }), { [url]: json({}, 429, { "retry-after": "30" }) });
    const investigator = fakeInvestigator();
    await processJob(deps(ctx, clock, { retriever: n.retriever, extractor: n.extractor, investigator }), await claimFor(ctx, clock, eventId));
    expect(investigator.starts).toBe(0);
    const [run] = await runsFor(ctx, eventId);
    expect(run).toMatchObject({ extractCount: 1, agentRunCount: 0, errorCode: "extract_rate_limited" });
    expect((await external(eventId)).map((r) => r.sourceUrl)).toEqual([url]);
  });

  it("stops extraction when today's extract budget is spent, without failing the job, and holds the Agent back", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token, { label: "Jones St & 8th Ave" });
    const url = "https://outlet-j.example/jones";
    const n = nimble(clock, () => json({ results: [liteHit(clock, url, { description: "Jones St closure near 8th Ave." })] }), {});
    const investigator = fakeInvestigator();
    const spent = await budgetUsed(ctx.db, "extract", clock.now());
    const config = testConfig({ dailyExtractBudget: Math.max(1, spent) });
    if (spent === 0) await processJob(deps(ctx, clock, { retriever: n.retriever, extractor: n.extractor, investigator, config }), await claimFor(ctx, clock, await newEvent(ctx, token, { label: "Jones St & 9th Ave" })));
    const before = n.extractCalls().length;
    const outcome = await processJob(deps(ctx, clock, { retriever: n.retriever, extractor: n.extractor, investigator, config }), await claimFor(ctx, clock, eventId));
    expect(["no_change", "state_changed"]).toContain(outcome);
    expect(n.extractCalls().length).toBe(before);
    expect((await runsFor(ctx, eventId))[0]).toMatchObject({ extractCount: 0, agentRunCount: 0, errorCode: "extract_budget_exhausted" });
  });

  it("exposes a date-only Search time as day precision through the API (no false clock time)", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token, { label: "Polk St & 3rd Ave" });
    const url = "https://outlet-p.example/polk";
    const n = nimble(clock, () => json({ results: [liteHit(clock, url, { description: "Polk St is closed at 3rd Ave." })] }), {});
    await processJob(deps(ctx, clock, { retriever: n.retriever, extractor: n.extractor, investigator: fakeInvestigator(), config: testConfig({ maxExtractsPerJob: 0 }) }), await claimFor(ctx, clock, eventId));
    const detail = (await ctx.request({ method: "GET", url: `/api/v1/events/${eventId}` })).json();
    const record = detail.evidence.find((e: { source_url: string | null }) => e.source_url === url);
    expect(record).toMatchObject({ published_at_precision: "day", published_at: `${clock.now().toISOString().slice(0, 10)}T00:00:00.000Z` });
    expect(n.extractCalls()).toHaveLength(0);
  });
});
