import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { budgetUsed } from "../../src/worker/budget";
import { processJob } from "../../src/worker/process";
import { createTestContext, type TestContext } from "../helpers";
import { claimFor, defaultBudgetConfig, deps, eventRow, FakeClock, fakeExtractor, fakeInvestigator, fakeRetriever, jobsFor, newEvent, newsAt, pageRead, results, runsFor } from "./harness";

/**
 * Paid Nimble work is opt-in: with no budget variables set, the worker makes
 * no paid calls at all. Fakes record every call; the job still settles.
 */

let ctx: TestContext;
let token: string;
beforeAll(async () => {
  ctx = await createTestContext();
  token = await ctx.signIn("zero-budgets@example.com");
});
afterAll(async () => ctx.close());

/** A result that would normally be read (Extract) and, still unconfirmed, escalate to the Agent. */
function providers(clock: FakeClock) {
  const url = `https://outlet-zero-${clock.now().getTime()}.example/story`;
  const retriever = fakeRetriever(() => results.found([newsAt(clock, { canonicalUrl: url, excerpt: null, stance: "context", publishedAt: null, publishedAtPrecision: null })]));
  const extractor = fakeExtractor({ [url]: pageRead(url, "Lanes of Test St are closed at the corner, police said.", clock.ago(5)) });
  const investigator = fakeInvestigator();
  return { retriever, extractor, investigator };
}

describe("zero (default) budgets", () => {
  it("with no budget configured, no search, extract or agent call is made and the job is deferred, not concluded", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token);
    const { retriever, extractor, investigator } = providers(clock);
    const outcome = await processJob(deps(ctx, clock, { config: defaultBudgetConfig(), retriever, extractor, investigator }), await claimFor(ctx, clock, eventId));

    expect(outcome).toBe("deferred");
    expect([retriever.calls, extractor.urls.length, investigator.starts, investigator.polls]).toEqual([0, 0, 0, 0]);
    expect((await jobsFor(ctx, eventId))[0]).toMatchObject({ status: "pending", attempts: 0, lastError: "search_budget_exhausted" });
    expect((await runsFor(ctx, eventId))[0]).toMatchObject({ outcome: "deferred", searchCount: 0, extractCount: 0, agentRunCount: 0 });
    // A budget deferral is never evidence: the event is untouched.
    expect(await eventRow(ctx, eventId)).toMatchObject({ status: "UNVERIFIED", verificationState: "queued" });
    for (const kind of ["search", "extract", "agent"] as const) expect(await budgetUsed(ctx.db, kind, clock.now())).toBe(0);
  });

  it("opting in to search only: searches run, but no page is read and no Agent run is bought", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token);
    const { retriever, extractor, investigator } = providers(clock);
    const config = defaultBudgetConfig();
    const outcome = await processJob(
      deps(ctx, clock, { config: { ...config, nimble: { ...config.nimble, dailySearchBudget: 200 } }, retriever, extractor, investigator }),
      await claimFor(ctx, clock, eventId),
    );

    expect(outcome).toBe("no_change");
    expect(retriever.calls).toBe(1);
    expect([extractor.urls.length, investigator.starts]).toEqual([0, 0]);
    expect((await runsFor(ctx, eventId))[0]).toMatchObject({ outcome: "no_change", extractCount: 0, agentRunCount: 0 });
    expect((await jobsFor(ctx, eventId))[0]!.status).toBe("succeeded");
    expect((await eventRow(ctx, eventId)).status).toBe("UNVERIFIED");
  });
});
