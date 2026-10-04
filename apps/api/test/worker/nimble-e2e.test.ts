import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sourceRecords } from "../../src/db/schema";
import { createNimbleRetriever } from "../../src/providers/nimble/retriever";
import { processJob } from "../../src/worker/process";
import { createTestContext, type TestContext } from "../helpers";
import { json, mockFetch, nimbleResult } from "../providers/mock-fetch";
import { claimFor, deps, eventRow, FakeClock, fakeInvestigator, jobsFor, newEvent, runsFor } from "./harness";

let ctx: TestContext;
let token: string;
beforeAll(async () => {
  ctx = await createTestContext();
  token = await ctx.signIn("nimble-e2e@example.com");
});
afterAll(async () => ctx.close());

function nimble(clock: FakeClock, handler: Parameters<typeof mockFetch>[0]) {
  const mock = mockFetch(handler);
  const retriever = createNimbleRetriever({ apiKey: "fake-nimble-key-0123", baseUrl: "https://sdk.nimbleway.com", now: clock.now, fetch: mock.fetch });
  return { mock, retriever };
}

describe("worker + Nimble Search (mocked HTTP) end to end", () => {
  it("turns search results into stored evidence and a deterministic verdict", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token, { label: "Valencia St & 9th Ave" });
    const published = clock.ago(10).toISOString();
    const { mock, retriever } = nimble(clock, () =>
      json({
        request_id: "req-e2e",
        results: [
          nimbleResult({
            url: "https://dot.ca.gov/caltrans-near-me/d4/closure-9?utm_source=rss",
            title: "Caltrans: Valencia St closure",
            content: "All lanes of Valencia St are closed at 9th Ave while crews repair a water main.",
            additional_data: { publish_date: published },
          }),
          nimbleResult({ url: "https://news.example/valencia", content: "Valencia St is closed near 9th Ave, police said.", additional_data: { publish_date: published } }),
        ],
      }),
    );
    const outcome = await processJob(deps(ctx, clock, { retriever, investigator: fakeInvestigator() }), await claimFor(ctx, clock, eventId));
    expect(outcome).toBe("state_changed");
    expect((await eventRow(ctx, eventId)).status).toBe("VERIFIED");

    const stored = await ctx.db.select().from(sourceRecords).where(and(eq(sourceRecords.eventId, eventId), isNotNull(sourceRecords.sourceUrl)));
    const official = stored.find((r) => r.sourceUrl === "https://dot.ca.gov/caltrans-near-me/d4/closure-9")!;
    expect(official).toMatchObject({ sourceClass: "OFFICIAL", isPrimary: true, stance: "supports", locationMatch: "exact", publisher: "Caltrans" });
    expect(official.quote).toBe("All lanes of Valencia St are closed at 9th Ave while crews repair a water main.");
    expect(official.publishedAt!.toISOString()).toBe(published);

    // Every request carried only event wording and place names.
    for (const call of mock.calls) {
      const body = JSON.stringify(call.body);
      expect(body).not.toMatch(/nimble-e2e@example\.com|reporter|user_id|\b3\d\.\d{3}|-1\d\d\.\d{3}/);
      expect(call.headers.authorization).toBe("Bearer fake-nimble-key-0123");
    }
    expect((await runsFor(ctx, eventId))[0]).toMatchObject({ outcome: "state_changed", decisionRuleId: "verified_primary_source", searchCount: mock.calls.length });
  });

  it("applies partial results when a later search fails, and never treats the failure as contradiction", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token, { label: "Folsom St & 3rd Ave" });
    const published = clock.ago(5).toISOString();
    const { retriever } = nimble(clock, (_c, i) =>
      i === 0
        ? json({ results: [nimbleResult({ url: "https://radio.example/folsom", content: "Folsom St is closed at 3rd Ave after a crash.", additional_data: { publish_date: published } })] })
        : json({}, 503),
    );
    expect(await processJob(deps(ctx, clock, { retriever, investigator: fakeInvestigator() }), await claimFor(ctx, clock, eventId))).toBe("state_changed");
    expect((await eventRow(ctx, eventId)).status).toBe("LIKELY");
    expect((await runsFor(ctx, eventId))[0]!.errorCode).toMatch(/^(partial_nimble_5xx|agent_)/);
  });

  it("leaves results without a publication date out of the verdict (unknown freshness)", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token, { label: "Howard St & 4th Ave" });
    const { retriever } = nimble(clock, () => json({ results: [nimbleResult({ url: "https://undated.example/howard", content: "Howard St is closed at 4th Ave.", additional_data: null })] }));
    expect(await processJob(deps(ctx, clock, { retriever, investigator: fakeInvestigator() }), await claimFor(ctx, clock, eventId))).toBe("no_change");
    expect((await eventRow(ctx, eventId)).status).toBe("UNVERIFIED");
  });

  it("fails the job (verification unavailable) on rejected credentials without touching status", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token, { label: "Bryant St & 7th Ave" });
    const { mock, retriever } = nimble(clock, () => json({ message: "invalid key" }, 401));
    expect(await processJob(deps(ctx, clock, { retriever }), await claimFor(ctx, clock, eventId))).toBe("failed");
    expect(mock.calls).toHaveLength(1);
    expect(await eventRow(ctx, eventId)).toMatchObject({ status: "UNVERIFIED", verificationState: "unavailable" });
    expect((await jobsFor(ctx, eventId))[0]).toMatchObject({ status: "failed", lastError: "nimble_auth" });
  });
});
