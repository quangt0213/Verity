import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventStateTransitions, eventTimeline } from "../../src/db/schema";
import { processJob, sanitizeEvidence } from "../../src/worker/process";
import { createTestContext, type TestContext } from "../helpers";
import { claimFor, deps, eventRow, FakeClock, fakeRetriever, jobsFor, newEvent, newsAt, results, runsFor } from "./harness";

let ctx: TestContext;
let token: string;
beforeAll(async () => {
  ctx = await createTestContext();
  token = await ctx.signIn("failures@example.com");
});
afterAll(async () => ctx.close());

async function statusHistory(eventId: string) {
  const rows = await ctx.db.select().from(eventStateTransitions).where(eq(eventStateTransitions.eventId, eventId));
  return rows.map((r) => r.toStatus);
}

describe("retrieval failures are not evidence", () => {
  it.each([
    ["a provider 5xx / outage", () => results.unavailable("provider_5xx")],
    ["a rate limit", () => ({ ...results.unavailable("rate_limited"), retryAfterSeconds: 600 })],
    ["a timeout (thrown)", () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }))],
    ["an adapter crash (thrown)", () => Promise.reject(new Error("boom"))],
  ])("%s schedules a bounded retry and never changes the event's status", async (_label, script) => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token);
    const lease = await claimFor(ctx, clock, eventId);
    expect(await processJob(deps(ctx, clock, { retriever: fakeRetriever(script) }), lease)).toBe("retry_scheduled");

    const [job] = await jobsFor(ctx, eventId);
    expect(job).toMatchObject({ status: "pending", attempts: 1 });
    const delay = job!.availableAt.getTime() - clock.now().getTime();
    expect(delay).toBeGreaterThanOrEqual(24_000); // 30 s base, ±20 % jitter (or Retry-After)
    expect(delay).toBeLessThanOrEqual(30 * 60_000);
    expect(await eventRow(ctx, eventId)).toMatchObject({ status: "UNVERIFIED", verificationState: "queued" });
    expect(await statusHistory(eventId)).toEqual(["UNVERIFIED"]);
    expect((await runsFor(ctx, eventId))[0]).toMatchObject({ outcome: "retry_scheduled", completedAt: null });
  });

  it("honors a provider's Retry-After", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token);
    const lease = await claimFor(ctx, clock, eventId);
    await processJob(deps(ctx, clock, { retriever: fakeRetriever(() => ({ ...results.unavailable("rate_limited"), retryAfterSeconds: 900 })) }), lease);
    const [job] = await jobsFor(ctx, eventId);
    expect(job!.availableAt.getTime() - clock.now().getTime()).toBeGreaterThanOrEqual(900_000);
  });

  it("fails permanently on a permanent provider error, marking verification unavailable but never REJECTED", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token);
    const lease = await claimFor(ctx, clock, eventId);
    expect(await processJob(deps(ctx, clock, { retriever: fakeRetriever(() => results.permanent()) }), lease)).toBe("failed");
    expect((await jobsFor(ctx, eventId))[0]).toMatchObject({ status: "failed", lastError: "provider_rejected" });
    expect(await eventRow(ctx, eventId)).toMatchObject({ status: "UNVERIFIED", verificationState: "unavailable" });
    expect(await statusHistory(eventId)).toEqual(["UNVERIFIED"]);
    const timeline = await ctx.db.select().from(eventTimeline).where(eq(eventTimeline.eventId, eventId));
    expect(timeline.map((t) => t.kind)).toContain("verification_unavailable");
  });

  it("marks verification unavailable once attempts are exhausted, after bounded backoff", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token);
    const retriever = fakeRetriever(() => results.unavailable());
    const outcomes: string[] = [];
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const lease = await claimFor(ctx, clock, eventId);
      expect(lease.attempt).toBe(attempt);
      outcomes.push(await processJob(deps(ctx, clock, { retriever }), lease));
      const [job] = await jobsFor(ctx, eventId);
      if (job!.status === "pending") {
        delays.push(job!.availableAt.getTime() - clock.now().getTime());
        clock.advance(job!.availableAt.getTime() - clock.now().getTime() + 1000);
      }
    }
    expect(outcomes).toEqual(["retry_scheduled", "retry_scheduled", "failed"]);
    expect(delays[1]!).toBeGreaterThan(delays[0]!); // exponential
    expect(await eventRow(ctx, eventId)).toMatchObject({ status: "UNVERIFIED", verificationState: "unavailable" });
    expect(retriever.calls).toBe(3);
  });

  it("treats no results as no new evidence: the job succeeds and the status stays", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token);
    const lease = await claimFor(ctx, clock, eventId);
    expect(await processJob(deps(ctx, clock, { retriever: fakeRetriever(() => results.none()) }), lease)).toBe("no_change");
    expect((await jobsFor(ctx, eventId))[0]).toMatchObject({ status: "succeeded" });
    const event = await eventRow(ctx, eventId);
    expect(event).toMatchObject({ status: "UNVERIFIED", verificationState: "idle" });
    expect(event.evidenceSummary).toMatch(/found no new sources/);
    expect((await runsFor(ctx, eventId))[0]).toMatchObject({ outcome: "no_change", decisionRuleId: "no_qualifying_evidence", searchCount: 3 });
  });

  it("drops malformed adapter output instead of guessing", async () => {
    const clock = new FakeClock();
    expect(
      sanitizeEvidence([
        newsAt(clock, { canonicalUrl: "javascript:alert(1)" }),
        newsAt(clock, { canonicalUrl: "http://127.0.0.1/x" }),
        newsAt(clock, { canonicalUrl: null }),
        newsAt(clock, { canonicalUrl: "https://ok.example/a?utm_source=x" }),
        newsAt(clock, { canonicalUrl: "https://ok.example/a" }),
      ]).map((e) => e.canonicalUrl),
    ).toEqual(["https://ok.example/a"]);

    const eventId = await newEvent(ctx, token);
    const lease = await claimFor(ctx, clock, eventId);
    const garbage = fakeRetriever(() => results.found([newsAt(clock, { canonicalUrl: "not a url" })]));
    expect(await processJob(deps(ctx, clock, { retriever: garbage }), lease)).toBe("no_change");
    expect((await eventRow(ctx, eventId)).status).toBe("UNVERIFIED");
  });

  it("reports an unconfigured retriever as unavailable rather than inventing evidence", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token);
    const lease = await claimFor(ctx, clock, eventId);
    const unconfigured = { ...fakeRetriever(() => results.found([newsAt(clock)])), configured: false };
    expect(await processJob(deps(ctx, clock, { retriever: unconfigured }), lease)).toBe("retry_scheduled");
    expect(unconfigured.calls).toBe(0);
    expect((await jobsFor(ctx, eventId))[0]).toMatchObject({ lastError: "retriever_not_configured" });
  });
});
