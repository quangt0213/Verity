import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rateLimitCounters } from "../../src/db/schema";
import { processJob } from "../../src/worker/process";
import { claimAgentSlot, ensureRun } from "../../src/worker/runs";
import { reapExpiredLeases } from "../../src/worker/settle";
import { createTestContext, type TestContext } from "../helpers";
import { claimFor, deps, eventRow, FakeClock, fakeInvestigator, fakeRetriever, jobsFor, newEvent, newsAt, officialAt, results, runsFor, testConfig } from "./harness";

let ctx: TestContext;
let tokens: string[];
let next = 0;
beforeAll(async () => {
  ctx = await createTestContext();
  tokens = await Promise.all([1, 2, 3].map((n) => ctx.signIn(`agent-${n}@example.com`)));
});
afterAll(async () => ctx.close());
const reporter = () => tokens[next++ % tokens.length]!;

/** One supporting source only: the engine asks for more ("insufficient_independent"). */
const oneSource = (clock: FakeClock) => fakeRetriever(() => results.found([newsAt(clock, { locationMatch: "near" })]));

describe("bounded agent escalation", () => {
  it("runs at most one investigation per run, at low effort, and uses its evidence", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const lease = await claimFor(ctx, clock, eventId);
    const investigator = fakeInvestigator({ poll: () => ({ status: "completed", evidence: [officialAt(clock)] }) });
    expect(await processJob(deps(ctx, clock, { retriever: oneSource(clock), investigator }), lease)).toBe("state_changed");
    expect(investigator.starts).toBe(1);
    expect(investigator.efforts).toEqual(["low"]);
    expect((await eventRow(ctx, eventId)).status).toBe("VERIFIED");
    expect((await runsFor(ctx, eventId))[0]).toMatchObject({ agentRunCount: 1, agentRunId: "task_run_1", escalationReason: "insufficient_independent" });
  });

  it("reuses the saved run id on a retry instead of buying a second investigation", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    // Attempt 1: the agent is still running when the poll timeout passes.
    const investigator = fakeInvestigator({ poll: (call) => (call < 100 ? { status: "running" } : { status: "completed", evidence: [] }) });
    const lease1 = await claimFor(ctx, clock, eventId);
    expect(await processJob(deps(ctx, clock, { retriever: oneSource(clock), investigator }), lease1)).toBe("retry_scheduled");
    expect((await jobsFor(ctx, eventId))[0]).toMatchObject({ lastError: "agent_poll_timeout" });
    expect(investigator.starts).toBe(1);

    // Attempt 2: polls the SAME run and finishes.
    const [job] = await jobsFor(ctx, eventId);
    clock.advance(job!.availableAt.getTime() - clock.now().getTime() + 1000);
    const done = fakeInvestigator({ poll: () => ({ status: "completed", evidence: [officialAt(clock)] }) });
    const lease2 = await claimFor(ctx, clock, eventId);
    expect(await processJob(deps(ctx, clock, { retriever: oneSource(clock), investigator: done }), lease2)).toBe("state_changed");
    expect(done.starts).toBe(0);
    expect(done.polls).toBeGreaterThan(0);
    const runs = await runsFor(ctx, eventId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentRunCount: 1, agentRunId: "task_run_1" });
  });

  it("fails closed when a slot was claimed but no run id was saved (crash window)", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    // Attempt 1 claims the slot and crashes before saving the provider's run id.
    const lease1 = await claimFor(ctx, clock, eventId, "w_crash");
    const run = await ctx.db.transaction((tx) => ensureRun(tx, lease1, clock.now()));
    expect(await claimAgentSlot(ctx.db, { lease: lease1, runId: run.id, reason: "insufficient_independent", config: testConfig(), now: clock.now() })).toEqual({ status: "claimed" });
    clock.advance((testConfig().leaseSeconds + 1) * 1000);
    await reapExpiredLeases(ctx.db, { now: clock.now(), leaseSeconds: testConfig().leaseSeconds });

    clock.minutes(5);
    const investigator = fakeInvestigator();
    const lease2 = await claimFor(ctx, clock, eventId);
    expect(await processJob(deps(ctx, clock, { retriever: oneSource(clock), investigator }), lease2)).toBe("state_changed");
    expect(investigator.starts).toBe(0);
    expect(investigator.polls).toBe(0);
    expect((await runsFor(ctx, eventId))[0]).toMatchObject({ agentRunCount: 1, agentRunId: null, errorCode: "agent_outcome_unknown" });
  });

  it("keeps the slot claimed when starting fails ambiguously (never retries the purchase)", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const lease = await claimFor(ctx, clock, eventId);
    const investigator = fakeInvestigator({ start: () => Promise.reject(new Error("socket hang up")) });
    expect(await processJob(deps(ctx, clock, { retriever: oneSource(clock), investigator }), lease)).toBe("state_changed");
    expect(investigator.starts).toBe(1);
    expect((await runsFor(ctx, eventId))[0]).toMatchObject({ agentRunCount: 1, agentRunId: null, errorCode: "agent_start_failed" });
  });

  it("respects the per-event cooldown, then the lifetime cap", async () => {
    const clock = new FakeClock();
    const eventId = await newEvent(ctx, reporter());
    const config = testConfig({ agentEventCooldownHours: 1, agentMaxPerEvent: 1 });
    const investigator = fakeInvestigator({ poll: () => ({ status: "completed", evidence: [] }) });
    const run = async () => processJob(deps(ctx, clock, { config, retriever: oneSource(clock), investigator }), await claimFor(ctx, clock, eventId));

    await run();
    expect(investigator.starts).toBe(1);
    // The scheduled recheck within the cooldown: no investigation.
    clock.minutes(30);
    await run();
    expect(investigator.starts).toBe(1);
    expect((await runsFor(ctx, eventId)).at(-1)).toMatchObject({ agentRunCount: 0, errorCode: "agent_cooldown" });
    // After the cooldown: the lifetime cap (1) stops it.
    clock.minutes(90);
    await run();
    expect(investigator.starts).toBe(1);
    expect((await runsFor(ctx, eventId)).at(-1)).toMatchObject({ errorCode: "agent_lifetime_cap" });
  });

  it("respects the global daily agent budget", async () => {
    const clock = new FakeClock();
    // Start from an unused budget for today (earlier tests in this file used some).
    await ctx.db.delete(rateLimitCounters).where(eq(rateLimitCounters.key, "budget:agent"));
    const config = testConfig({ dailyAgentBudget: 1 });
    const investigator = fakeInvestigator({ poll: () => ({ status: "completed", evidence: [] }) });
    const a = await newEvent(ctx, reporter());
    const b = await newEvent(ctx, reporter());
    await processJob(deps(ctx, clock, { config, retriever: oneSource(clock), investigator }), await claimFor(ctx, clock, a));
    await processJob(deps(ctx, clock, { config, retriever: oneSource(clock), investigator }), await claimFor(ctx, clock, b));
    expect(investigator.starts).toBe(1);
    expect((await runsFor(ctx, b))[0]).toMatchObject({ agentRunCount: 0, errorCode: "agent_budget_exhausted" });
    // Budget exhaustion is not evidence: the ordinary result still applied.
    expect((await eventRow(ctx, b)).status).toBe("LIKELY");
  });

  it("uses low effort for conflicts unless medium is explicitly enabled", async () => {
    const clock = new FakeClock();
    const conflict = (c: FakeClock) => fakeRetriever(() => results.found([newsAt(c), newsAt(c, { stance: "contradicts" })]));
    const low = fakeInvestigator();
    await processJob(deps(ctx, clock, { retriever: conflict(clock), investigator: low }), await claimFor(ctx, clock, await newEvent(ctx, reporter())));
    expect(low.efforts).toEqual(["low"]);
    const medium = fakeInvestigator();
    const config = testConfig({ agentConflictEffort: "medium" });
    await processJob(deps(ctx, clock, { config, retriever: conflict(clock), investigator: medium }), await claimFor(ctx, clock, await newEvent(ctx, reporter())));
    expect(medium.efforts).toEqual(["medium"]);
  });
});
