import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, eventStateTransitions, eventTimeline, sourceRecords, verificationJobs } from "../../src/db/schema";
import { detectAttributions } from "../../src/verification/attribution";
import { scheduleRecheck } from "../../src/worker/apply";
import { createWorker } from "../../src/worker/loop";
import { processJob } from "../../src/worker/process";
import { sweepAging } from "../../src/worker/sweep";
import { createTestContext, type TestContext } from "../helpers";
import { claimFor, deps, eventRow, FakeClock, fakeRetriever, jobsFor, newEvent, newsAt, officialAt, results, runsFor } from "./harness";

let ctx: TestContext;
let tokens: string[];
let next = 0;
beforeAll(async () => {
  ctx = await createTestContext();
  tokens = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => ctx.signIn(`lifecycle-${n}@example.com`)));
});
afterAll(async () => ctx.close());
const reporter = () => tokens[next++ % tokens.length]!;

async function transitions(eventId: string) {
  return (await ctx.db.select().from(eventStateTransitions).where(eq(eventStateTransitions.eventId, eventId)).orderBy(eventStateTransitions.createdAt)).map((t) => [t.toStatus, t.actorType]);
}
async function timelineKinds(eventId: string) {
  return (await ctx.db.select().from(eventTimeline).where(eq(eventTimeline.eventId, eventId)).orderBy(eventTimeline.at)).map((t) => t.kind);
}
/** A second report for the same event (same place, same wording), from another account. */
async function attachReport(eventId: string, token: string, remote: string) {
  const event = await eventRow(ctx, eventId);
  const res = await ctx.request({
    method: "POST",
    url: "/api/v1/reports",
    token,
    remoteAddress: remote,
    payload: { category: event.category, title: event.title, location: { coordinates: { latitude: event.latitude, longitude: event.longitude } } },
  });
  expect(res.json().event_id).toBe(eventId);
}
async function verify(clock: FakeClock, eventId: string, evidence = () => [officialAt(clock)]) {
  return processJob(deps(ctx, clock, { retriever: fakeRetriever(() => results.found(evidence())) }), await claimFor(ctx, clock, eventId));
}

describe("lost wakeup", () => {
  it("enqueues an immediate follow-up when a report arrives while the job runs", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const lease = await claimFor(ctx, clock, eventId);
    const retriever = fakeRetriever(async () => {
      // Arrives mid-run: its own enqueue hits the one-open-job index.
      await attachReport(eventId, reporter(), "10.250.0.1");
      return results.none();
    });
    await processJob(deps(ctx, clock, { retriever }), lease);
    const jobs = await jobsFor(ctx, eventId);
    expect(jobs.map((j) => [j.status, j.reason])).toEqual([["succeeded", "NEW_REPORT"], ["pending", "REPORT_ATTACHED"]]);
    expect(jobs[1]!.idempotencyKey).toBe(`followup:${lease.jobId}`);
    expect(jobs[1]!.availableAt.getTime()).toBeLessThanOrEqual(clock.now().getTime());
    expect((await eventRow(ctx, eventId)).verificationState).toBe("queued");
  });

  it("enqueues a follow-up for a dispute that arrives while the job runs", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const lease = await claimFor(ctx, clock, eventId);
    const retriever = fakeRetriever(async () => {
      const res = await ctx.request({ method: "POST", url: `/api/v1/events/${eventId}/signals`, token: reporter(), payload: { type: "DISPUTE" } });
      expect(res.statusCode).toBe(201);
      return results.none();
    });
    await processJob(deps(ctx, clock, { retriever }), lease);
    expect((await jobsFor(ctx, eventId)).map((j) => [j.status, j.reason])).toEqual([["succeeded", "NEW_REPORT"], ["pending", "COMMUNITY_DISPUTE"]]);
  });

  it("does not create a follow-up when nothing new arrived, and schedules a recheck instead", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    await processJob(deps(ctx, clock), await claimFor(ctx, clock, eventId));
    expect((await jobsFor(ctx, eventId)).map((j) => [j.status, j.reason])).toEqual([["succeeded", "NEW_REPORT"], ["pending", "RECHECK"]]);
  });

  it("pulls a scheduled recheck forward when a new report arrives before it", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    await processJob(deps(ctx, clock), await claimFor(ctx, clock, eventId));
    const recheck = (await jobsFor(ctx, eventId)).find((j) => j.reason === "RECHECK")!;
    expect(recheck.availableAt.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    await attachReport(eventId, reporter(), "10.250.0.2");
    const [pulled] = await ctx.db.select().from(verificationJobs).where(eq(verificationJobs.id, recheck.id));
    expect(pulled!.availableAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect((await jobsFor(ctx, eventId)).filter((j) => j.status === "pending")).toHaveLength(1);
  });
});

describe("rechecks and reconfirmation", () => {
  it("schedules one bucketed RECHECK per event from the central policy", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    await verify(clock, eventId, () => [newsAt(clock)]); // → LIKELY
    const recheck = (await jobsFor(ctx, eventId)).find((j) => j.reason === "RECHECK")!;
    expect(recheck.idempotencyKey).toMatch(new RegExp(`^recheck:${eventId}:\\d+$`));
    expect(recheck.availableAt.getTime() - clock.now().getTime()).toBe(30 * 60_000); // policy.recheckMinutes.confirmed
    // Another path asking for a recheck around then creates nothing new.
    const created = await ctx.db.transaction((tx) => scheduleRecheck(tx, eventId, new Date(clock.now().getTime() + 31 * 60_000), clock.now()));
    expect(created).toBe(false);
    expect((await jobsFor(ctx, eventId)).filter((j) => j.status === "pending")).toHaveLength(1);
  });

  it("reconfirms a VERIFIED event by refreshing last_verified_at, with no VERIFIED → VERIFIED transition", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const url = "https://dot.ca.gov/alerts/reconfirm";
    await verify(clock, eventId, () => [officialAt(clock, { canonicalUrl: url })]);
    const first = await eventRow(ctx, eventId);
    expect(first.status).toBe("VERIFIED");

    clock.minutes(31);
    const outcome = await verify(clock, eventId, () => [officialAt(clock, { canonicalUrl: url, publishedAt: clock.ago(2) })]);
    expect(outcome).toBe("no_change");
    const after = await eventRow(ctx, eventId);
    expect(after.status).toBe("VERIFIED");
    expect(after.lastVerifiedAt!.getTime()).toBe(clock.now().getTime());
    expect(after.lastVerifiedAt!.getTime()).toBeGreaterThan(first.lastVerifiedAt!.getTime());
    expect(after.lastCheckedAt!.getTime()).toBe(clock.now().getTime());
    expect(await transitions(eventId)).toEqual([["UNVERIFIED", "community"], ["VERIFIED", "verifier"]]);
    expect((await runsFor(ctx, eventId)).at(-1)).toMatchObject({ outcome: "no_change", decisionRuleId: "verified_primary_source", transitionId: null });
    const [entry] = await ctx.db.select().from(eventTimeline).where(and(eq(eventTimeline.eventId, eventId), eq(eventTimeline.kind, "checked_no_change")));
    expect(entry!.label).toBe("Checked again: the evidence still supports this");
  });
});

describe("aging sweep (no provider calls)", () => {
  it("moves aged-out support to STALE as the system, never to RESOLVED", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    await verify(clock, eventId);
    clock.minutes(30 * 60); // road_closure evidence is stale after 24 h
    const swept = await sweepAging(ctx.db, { now: clock.now() });
    expect(swept).toContainEqual({ eventId, to: "STALE" });
    expect((await transitions(eventId)).at(-1)).toEqual(["STALE", "system"]);
    // Much later, old evidence still does not mean "it ended".
    clock.minutes(10 * 24 * 60);
    await sweepAging(ctx.db, { now: clock.now() });
    expect((await eventRow(ctx, eventId)).status).toBe("STALE");
    expect((await transitions(eventId)).map(([to]) => to)).not.toContain("RESOLVED");
  });

  it("resolves a scheduled event only once its KNOWN scheduled end has passed", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter(), { category: "concert", title: "Concert crowds at test arena" });
    await ctx.db
      .update(events)
      .set({ scheduledStartAt: new Date(clock.now().getTime() + 60 * 60_000), scheduledEndAt: new Date(clock.now().getTime() + 3 * 60 * 60_000) })
      .where(eq(events.id, eventId));
    await verify(clock, eventId);
    expect((await eventRow(ctx, eventId)).status).toBe("VERIFIED");

    clock.minutes(2 * 60); // during the event
    await sweepAging(ctx.db, { now: clock.now() });
    expect((await eventRow(ctx, eventId)).status).toBe("VERIFIED");
    clock.minutes(3 * 60); // past end + grace
    expect(await sweepAging(ctx.db, { now: clock.now() })).toContainEqual({ eventId, to: "RESOLVED" });
    expect((await transitions(eventId)).at(-1)).toEqual(["RESOLVED", "system"]);
  });

  it("never infers an end from a start time alone: start-only events go STALE, not RESOLVED", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter(), { category: "concert", title: "Concert crowds at another arena" });
    await ctx.db.update(events).set({ scheduledStartAt: new Date(clock.now().getTime() + 60 * 60_000), scheduledEndAt: null }).where(eq(events.id, eventId));
    await verify(clock, eventId);
    clock.minutes(5 * 24 * 60);
    await sweepAging(ctx.db, { now: clock.now() });
    expect((await eventRow(ctx, eventId)).status).toBe("STALE");
    expect((await transitions(eventId)).map(([to]) => to)).not.toContain("RESOLVED");
  });
});

describe("evidence storage", () => {
  it("upserts by canonical URL: tracking variants and rechecks never duplicate a source", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    await verify(clock, eventId, () => [newsAt(clock, { canonicalUrl: "https://paper.example/a?id=4&utm_source=x" })]);
    clock.minutes(31);
    await verify(clock, eventId, () => [newsAt(clock, { canonicalUrl: "https://paper.example/a?utm_medium=y&id=4" })]);
    const external = await ctx.db.select().from(sourceRecords).where(and(eq(sourceRecords.eventId, eventId), sql`source_url is not null`));
    expect(external).toHaveLength(1);
    expect(external[0]).toMatchObject({ sourceUrl: "https://paper.example/a?id=4" });
    expect(external[0]!.retrievedAt.getTime()).toBe(clock.now().getTime());
  });

  it("recomputes lineage over all of an event's records: one independent record per lineage", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const wire = (publisher: string) => newsAt(clock, { publisher, attributions: detectAttributions("SAN FRANCISCO (AP) — Lanes closed") });
    await verify(clock, eventId, () => [newsAt(clock, { publisher: "AP News", canonicalUrl: "https://apnews.com/article/x1" }), wire("NBC"), wire("ABC")]);
    let detail = (await ctx.request({ method: "GET", url: `/api/v1/events/${eventId}` })).json();
    expect(detail).toMatchObject({ source_count: 4, independent_source_count: 2 }); // community + the AP lineage

    clock.minutes(31);
    await verify(clock, eventId, () => [newsAt(clock, { publisher: "Local Radio" })]);
    detail = (await ctx.request({ method: "GET", url: `/api/v1/events/${eventId}` })).json();
    expect(detail).toMatchObject({ source_count: 5, independent_source_count: 3 });
    // Two independent news lineages plus the community, but no identified (official or first-party) source: LIKELY, never VERIFIED (S4.1 product rule).
    expect(detail.status).toBe("LIKELY");
  });
});

describe("cost scales with events, not reports", () => {
  it("collapses 50 reports of one incident into one event with one open job and one run", async () => {
    const clock = new FakeClock();
    // Fresh accounts: each may file 10 reports an hour (the API's own rate limit).
    const crowd = await Promise.all([1, 2, 3, 4, 5].map((n) => ctx.signIn(`crowd-${n}@example.com`)));
    const first = await newEvent(ctx, crowd[0]!, { title: "Flooding closes the underpass" });
    for (let i = 0; i < 49; i++) await attachReport(first, crowd[(i + 1) % crowd.length]!, `10.251.${i >> 8}.${i & 255}`);
    expect((await ctx.db.select().from(events).where(eq(events.title, "Flooding closes the underpass")))).toHaveLength(1);
    const open = (await jobsFor(ctx, first)).filter((j) => j.status === "pending" || j.status === "running");
    expect(open).toHaveLength(1);
    const retriever = fakeRetriever(() => results.none());
    await processJob(deps(ctx, clock, { retriever }), await claimFor(ctx, clock, first));
    expect(retriever.calls).toBe(1);
    expect(await runsFor(ctx, first)).toHaveLength(1);
  });
});

describe("timeline quiet periods", () => {
  it("coalesces repeated no-change checks; every check is still a verification run", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const check = async () => processJob(deps(ctx, clock), await claimFor(ctx, clock, eventId));
    await check();
    for (let i = 0; i < 3; i++) {
      clock.minutes(61);
      await check();
    }
    expect((await timelineKinds(eventId)).filter((k) => k === "checked_no_change")).toHaveLength(1);
    expect(await runsFor(ctx, eventId)).toHaveLength(4);
    clock.minutes(6 * 60);
    await check();
    expect((await timelineKinds(eventId)).filter((k) => k === "checked_no_change")).toHaveLength(2);
  });

  it("adds one source_found entry per check, however many sources arrived", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    await verify(clock, eventId, () => [newsAt(clock), newsAt(clock), newsAt(clock), newsAt(clock), newsAt(clock)]);
    const found = (await ctx.db.select().from(eventTimeline).where(and(eq(eventTimeline.eventId, eventId), eq(eventTimeline.kind, "source_found"))));
    expect(found).toHaveLength(1);
    expect(found[0]!.label).toMatch(/^5 new sources found: .+ and 2 more$/);
  });
});

describe("worker process", () => {
  it("runs as its own loop: claims, processes and sweeps", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    await ctx.db.update(verificationJobs).set({ availableAt: clock.now() }).where(eq(verificationJobs.eventId, eventId));
    const worker = createWorker({ ...deps(ctx, clock, { retriever: fakeRetriever(() => results.found([officialAt(clock)])) }), workerId: "w_loop" });
    const { claimed } = await worker.tick();
    expect(claimed).toBeGreaterThan(0);
    await worker.drain();
    expect((await eventRow(ctx, eventId)).status).toBe("VERIFIED");
  });

  it("is never started by the API process", () => {
    for (const file of ["src/server.ts", "src/app.ts"]) {
      expect(readFileSync(resolve(__dirname, "../..", file), "utf8"), file).not.toMatch(/worker/);
    }
  });
});
