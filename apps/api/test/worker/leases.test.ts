import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventStateTransitions, sourceRecords, verificationJobs, verificationRuns } from "../../src/db/schema";
import { applyVerification, triggerCounts } from "../../src/worker/apply";
import { claimJobs, heartbeat } from "../../src/worker/jobs";
import { processJob } from "../../src/worker/process";
import { claimAgentSlot, ensureRun } from "../../src/worker/runs";
import { reapExpiredLeases, settleFailure } from "../../src/worker/settle";
import { createTestContext, type TestContext } from "../helpers";
import { claimFor, deps, eventRow, FakeClock, fakeRetriever, jobsFor, newEvent, newsAt, results, runsFor, testConfig } from "./harness";

let ctx: TestContext;
let token: string;
beforeAll(async () => {
  ctx = await createTestContext();
  token = await ctx.signIn("leases@example.com");
});
afterAll(async () => ctx.close());

const LEASE = testConfig().leaseSeconds;

describe("claiming", () => {
  it("claims a ready job exactly once, increments attempts and records the owner", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token);
    const lease = await claimFor(ctx, clock, eventId, "w_a");
    expect(lease).toMatchObject({ eventId, attempt: 1, workerId: "w_a", maxAttempts: 3 });
    const [job] = await jobsFor(ctx, eventId);
    expect(job).toMatchObject({ status: "running", attempts: 1, lockedBy: "w_a" });
    // Nobody else can claim it now.
    const again = await claimJobs(ctx.db, { workerId: "w_b", limit: 50, now: clock.now() });
    expect(again.find((l) => l.jobId === lease.jobId)).toBeUndefined();
  });

  it("does not claim a job before its available_at", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token);
    const [job] = await jobsFor(ctx, eventId);
    await ctx.db.update(verificationJobs).set({ availableAt: new Date(clock.now().getTime() + 60_000) }).where(eq(verificationJobs.id, job!.id));
    const early = await claimJobs(ctx.db, { workerId: "w", limit: 50, now: clock.now() });
    expect(early.find((l) => l.eventId === eventId)).toBeUndefined();
    clock.minutes(2);
    const later = await claimJobs(ctx.db, { workerId: "w", limit: 50, now: clock.now() });
    expect(later.find((l) => l.eventId === eventId)).toBeDefined();
  });
});

describe("leases, crash recovery and fencing", () => {
  it("recovers a crashed worker's job and resumes the SAME logical run on the next attempt", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token);
    // Worker A claims, starts the run, and crashes.
    const leaseA = await claimFor(ctx, clock, eventId, "w_a");
    const runA = await ctx.db.transaction((tx) => ensureRun(tx, leaseA, clock.now()));

    clock.advance((LEASE + 1) * 1000);
    const reaped = await reapExpiredLeases(ctx.db, { now: clock.now(), leaseSeconds: LEASE, random: () => 0.5 });
    expect(reaped).toContainEqual({ jobId: leaseA.jobId, outcome: "retry_scheduled" });
    const [pending] = await jobsFor(ctx, eventId);
    expect(pending).toMatchObject({ status: "pending", attempts: 1, lockedBy: null, lastError: "lease_expired" });
    expect(pending!.availableAt.getTime()).toBeGreaterThan(clock.now().getTime());

    // Worker B picks it up after the backoff and finishes it.
    clock.minutes(5);
    const leaseB = await claimFor(ctx, clock, eventId, "w_b");
    expect(leaseB.attempt).toBe(2);
    const outcome = await processJob(deps(ctx, clock, { retriever: fakeRetriever(() => results.found([newsAt(clock)])) }), leaseB);
    expect(outcome).toBe("state_changed");
    const runs = await runsFor(ctx, eventId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: runA.id, outcome: "state_changed" });
    expect(runs[0]!.completedAt).not.toBeNull();
  });

  it("fences out a worker whose lease was reaped: it can change nothing", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token);
    const stale = await claimFor(ctx, clock, eventId, "w_slow");
    const run = await ctx.db.transaction((tx) => ensureRun(tx, stale, clock.now()));
    const seen = await triggerCounts(ctx.db, eventId);

    clock.advance((LEASE + 1) * 1000);
    await reapExpiredLeases(ctx.db, { now: clock.now(), leaseSeconds: LEASE, random: () => 0.5 });
    clock.minutes(5);
    const current = await claimFor(ctx, clock, eventId, "w_new");
    expect(current.attempt).toBe(2);

    // The slow worker comes back: every write path refuses it.
    expect(await heartbeat(ctx.db, stale, clock.now())).toBe(false);
    expect(
      await applyVerification(ctx.db, { lease: stale, runId: run.id, evidence: [newsAt(clock)], retrieval: "ok", note: null, now: clock.now(), seen }),
    ).toEqual({ outcome: "lost_lease" });
    expect(await settleFailure(ctx.db, stale, { kind: "permanent", errorCode: "x", now: clock.now() })).toBe("lost_lease");
    expect(await claimAgentSlot(ctx.db, { lease: stale, runId: run.id, reason: "insufficient_independent", config: testConfig(), now: clock.now() })).toEqual({ status: "lost_lease" });
    // Even the same worker id with the old attempt number is fenced.
    expect(await heartbeat(ctx.db, { ...current, attempt: 1 }, clock.now())).toBe(false);

    const [{ n }] = (await ctx.db.select({ n: count() }).from(sourceRecords).where(eq(sourceRecords.eventId, eventId))) as [{ n: number }];
    expect(n).toBe(1); // only the community report
    expect((await eventRow(ctx, eventId)).status).toBe("UNVERIFIED");
    const [job] = await jobsFor(ctx, eventId);
    expect(job).toMatchObject({ status: "running", lockedBy: "w_new", attempts: 2 });
    const [r] = await runsFor(ctx, eventId);
    expect(r).toMatchObject({ agentRunCount: 0, agentRequestedAt: null });
  });

  it("applies duplicate execution once: the second attempt is fenced and no transition repeats", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token);
    const lease = await claimFor(ctx, clock, eventId);
    const retriever = fakeRetriever(() => results.found([newsAt(clock)]));
    expect(await processJob(deps(ctx, clock, { retriever }), lease)).toBe("state_changed");
    // The same lease again (e.g. a duplicated message): nothing happens.
    expect(await processJob(deps(ctx, clock, { retriever }), lease)).toBe("lost_lease");
    const transitions = await ctx.db.select().from(eventStateTransitions).where(eq(eventStateTransitions.eventId, eventId));
    // Community report + one independent source = two lineages = LIKELY.
    expect(transitions.map((t) => t.toStatus)).toEqual(["UNVERIFIED", "LIKELY"]);
    expect(retriever.calls).toBe(1);
  });

  it("fails a job whose lease expires on its last attempt, without touching the event's status", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token);
    const [job] = await jobsFor(ctx, eventId);
    await ctx.db.update(verificationJobs).set({ attempts: 2 }).where(eq(verificationJobs.id, job!.id));
    const lease = await claimFor(ctx, clock, eventId);
    expect(lease.attempt).toBe(3);
    await ctx.db.transaction((tx) => ensureRun(tx, lease, clock.now()));
    clock.advance((LEASE + 1) * 1000);
    expect(await reapExpiredLeases(ctx.db, { now: clock.now(), leaseSeconds: LEASE })).toContainEqual({ jobId: lease.jobId, outcome: "failed" });
    expect((await jobsFor(ctx, eventId))[0]).toMatchObject({ status: "failed", lastError: "lease_expired" });
    expect(await eventRow(ctx, eventId)).toMatchObject({ status: "UNVERIFIED", verificationState: "unavailable" });
    expect((await runsFor(ctx, eventId))[0]).toMatchObject({ outcome: "failed", errorCode: "lease_expired" });
  });

  it("does not reap a lease that was renewed by a heartbeat", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token);
    const lease = await claimFor(ctx, clock, eventId);
    clock.advance((LEASE - 10) * 1000);
    expect(await heartbeat(ctx.db, lease, clock.now())).toBe(true);
    clock.advance(20_000);
    const reaped = await reapExpiredLeases(ctx.db, { now: clock.now(), leaseSeconds: LEASE });
    expect(reaped.find((r) => r.jobId === lease.jobId)).toBeUndefined();
  });
});

describe("budget deferral", () => {
  it("defers when the daily search budget is exhausted, refunds the attempt, and cannot spin", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, token);
    const lease = await claimFor(ctx, clock, eventId);
    const retriever = fakeRetriever(() => results.found([newsAt(clock)]));
    const outcome = await processJob(deps(ctx, clock, { retriever, config: testConfig({ dailySearchBudget: 0 }) }), lease);
    expect(outcome).toBe("deferred");
    expect(retriever.calls).toBe(0);

    const [job] = await jobsFor(ctx, eventId);
    expect(job).toMatchObject({ status: "pending", attempts: 0, lastError: "search_budget_exhausted" });
    expect(job!.availableAt.getTime()).toBeGreaterThanOrEqual(clock.now().getTime() + 15 * 60_000);
    expect((await runsFor(ctx, eventId))[0]).toMatchObject({ outcome: "deferred" });
    expect(await eventRow(ctx, eventId)).toMatchObject({ status: "UNVERIFIED", verificationState: "queued" });

    // Immediately afterwards (and for the next minutes) nothing is claimable: no claim/defer loop.
    for (const minutes of [0, 1, 10]) {
      const claims = await claimJobs(ctx.db, { workerId: "w_spin", limit: 50, now: new Date(clock.now().getTime() + minutes * 60_000) });
      expect(claims.find((l) => l.eventId === eventId), `${minutes} min`).toBeUndefined();
    }
    // Once the budget window resets it runs again, resuming the same run.
    clock.advance(job!.availableAt.getTime() - clock.now().getTime() + 1000);
    const resumed = await claimFor(ctx, clock, eventId);
    expect(resumed.attempt).toBe(1);
    expect(await processJob(deps(ctx, clock, { retriever }), resumed)).toBe("state_changed");
    expect(await runsFor(ctx, eventId)).toHaveLength(1);
    const [run] = await ctx.db.select().from(verificationRuns).where(eq(verificationRuns.eventId, eventId));
    expect(run!.searchCount).toBe(2);
  });
});
