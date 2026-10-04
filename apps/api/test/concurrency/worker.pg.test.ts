import type { ReportEventPayload } from "@verity/contracts";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, eventStateTransitions, eventTimeline, reports, users, verificationJobs, verificationRuns } from "../../src/db/schema";
import { enqueueVerification } from "../../src/domain/outbox";
import { createReport } from "../../src/domain/reports";
import { transitionEvent } from "../../src/domain/transitions";
import { applyVerification, triggerCounts } from "../../src/worker/apply";
import { enqueueWorkerJob } from "../../src/worker/effects";
import { claimJobs, heartbeat, lockOwnedJob, type Lease } from "../../src/worker/jobs";
import { processJob, type WorkerDeps } from "../../src/worker/process";
import { ensureRun, reserveExtract } from "../../src/worker/runs";
import { reapExpiredLeases } from "../../src/worker/settle";
import { fakeExtractor, fakeInvestigator, fakeRetriever, newsAt, FakeClock, officialAt, pageRead, results, silentLog, testConfig } from "../worker/harness";
import { sweepAgentResources } from "../../src/worker/escalate";
import { sweepAging } from "../../src/worker/sweep";
import { unconfiguredExtractor } from "../../src/worker/ports";
import { target, throwawayDatabase, type Throwaway } from "./pg-target";

/**
 * OPT-IN (S6B): worker correctness on a REAL PostgreSQL server with two
 * independent connection pools (two "workers"). Needs TEST_DATABASE_URL on a
 * local disposable server; see pg-target.ts. Providers are fakes: this suite
 * never calls Nimble.
 */

describe.skipIf(!target)("worker on real PostgreSQL", () => {
  let t: Throwaway;
  let place = 0;
  let userIds: string[] = [];

  beforeAll(async () => {
    t = await throwawayDatabase("verity_worker");
    const rows = await t.a.db
      .insert(users)
      .values(Array.from({ length: 12 }, (_, i) => ({ email: `pg-${i}-${t.name}@example.com` })))
      .returning({ id: users.id });
    userIds = rows.map((r) => r.id);
  }, 180_000);
  afterAll(async () => t?.drop());

  const payload = (over: Partial<ReportEventPayload> = {}): ReportEventPayload => {
    place += 1;
    return {
      category: "road_closure",
      title: `Road closed near test site ${place}`,
      description: "Two lanes closed, police directing traffic.",
      location: { coordinates: { latitude: 20 + place * 0.05, longitude: -90 - place * 0.05 }, label: `Test St & ${place}th Ave` },
      ...over,
    } as ReportEventPayload;
  };

  async function claimOne(db: Throwaway["a"]["db"], eventId: string, workerId: string, now: Date): Promise<Lease> {
    await t.a.db.execute(sql`update verification_jobs set available_at = ${now.toISOString()} where event_id = ${eventId} and status = 'pending'`);
    const leases = await claimJobs(db, { workerId, limit: 50, now });
    const lease = leases.find((l) => l.eventId === eventId);
    for (const other of leases.filter((l) => l.eventId !== eventId)) {
      await t.a.db.update(verificationJobs).set({ status: "pending", lockedBy: null, lockedAt: null, attempts: sql`attempts - 1` }).where(eq(verificationJobs.id, other.jobId));
    }
    if (!lease) throw new Error("no job to claim");
    return lease;
  }

  it("applied migrations 0000-0005 to the throwaway database", async () => {
    const [m] = (await t.a.db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)) as unknown as Array<{ n: number }>;
    expect(m!.n).toBe(6);
    const [cols] = (await t.a.db.execute(
      sql`select count(*)::int as n from information_schema.columns where table_name = 'verification_runs' and column_name in ('extract_count', 'agent_id', 'agent_cleaned_up_at')`,
    )) as unknown as Array<{ n: number }>;
    expect(cols!.n).toBe(3);
  });

  it("serializes concurrent reports at one place (advisory lock): one event, every report attached", async () => {
    const shared = payload();
    const outcomes = await Promise.all(userIds.slice(0, 10).map((user, i) => createReport(i % 2 ? t.a.db : t.b.db, user, shared)));
    expect(new Set(outcomes.map((o) => o.event_id)).size).toBe(1);
    const eventId = outcomes[0]!.event_id;
    const [r] = (await t.a.db.execute(sql`select count(*)::int as n from reports where event_id = ${eventId}`)) as unknown as Array<{ n: number }>;
    expect(r!.n).toBe(10);
    // Duplicate wakeups: one open job, however many reports tried to enqueue.
    const open = await t.a.db.select().from(verificationJobs).where(and(eq(verificationJobs.eventId, eventId), sql`status in ('pending','running')`));
    expect(open).toHaveLength(1);
  });

  it("keeps at most one open job per event under concurrent enqueues from both connections", async () => {
    const { event_id: eventId } = await createReport(t.a.db, userIds[0]!, payload());
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? t.a.db : t.b.db).transaction((tx) => enqueueVerification(tx, { eventId, reason: "REPORT_ATTACHED", idempotencyKey: `wake:${eventId}:${i}` })),
      ),
    );
    const open = await t.a.db.select().from(verificationJobs).where(and(eq(verificationJobs.eventId, eventId), sql`status in ('pending','running')`));
    expect(open).toHaveLength(1);
  });

  it("keeps one logical run per job when attempts race, and across a retry", async () => {
    const { event_id: eventId } = await createReport(t.a.db, userIds[1]!, payload());
    const lease = await claimOne(t.a.db, eventId, "w_run", new Date());
    const runs = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? t.a.db : t.b.db).transaction((tx) => ensureRun(tx, lease, new Date()))));
    expect(new Set(runs.map((r) => r.id)).size).toBe(1);
    const retry = await t.b.db.transaction((tx) => ensureRun(tx, { ...lease, attempt: lease.attempt + 1 }, new Date()));
    expect(retry.id).toBe(runs[0]!.id);
    const all = await t.a.db.select().from(verificationRuns).where(eq(verificationRuns.jobId, lease.jobId));
    expect(all).toHaveLength(1);
  });

  it("expires a lease, lets another worker reclaim it, and fences the stale worker out of every write", async () => {
    const { event_id: eventId } = await createReport(t.a.db, userIds[2]!, payload());
    const start = new Date();
    const stale = await claimOne(t.a.db, eventId, "w_stale", start);
    const run = await t.a.db.transaction((tx) => ensureRun(tx, stale, start));
    const seen = await triggerCounts(t.a.db, eventId);

    // The lease expires; the reaper (another worker's connection) returns the job for a retry.
    const later = new Date(start.getTime() + (testConfig().leaseSeconds + 5) * 1000);
    await reapExpiredLeases(t.b.db, { now: later, leaseSeconds: testConfig().leaseSeconds });
    const fresh = await claimOne(t.b.db, eventId, "w_fresh", new Date(later.getTime() + 24 * 60 * 60_000));
    expect(fresh.attempt).toBe(stale.attempt + 1);

    // The stale worker can neither heartbeat, lock, reserve, nor apply.
    expect(await heartbeat(t.a.db, stale, later)).toBe(false);
    expect(await t.a.db.transaction((tx) => lockOwnedJob(tx, stale))).toBe(false);
    expect(await reserveExtract(t.a.db, stale, run.id, testConfig(), later)).toEqual({ status: "lost_lease" });
    const applied = await applyVerification(t.a.db, { lease: stale, runId: run.id, evidence: [], retrieval: "no_results", note: null, now: later, seen });
    expect(applied.outcome).toBe("lost_lease");
    // The owner still can.
    expect(await heartbeat(t.b.db, fresh, later)).toBe(true);
  });

  it("recovers a lost wakeup: a report arriving mid-attempt gets a follow-up job at apply time", async () => {
    const { event_id: eventId } = await createReport(t.a.db, userIds[3]!, payload());
    const lease = await claimOne(t.a.db, eventId, "w_wake", new Date());
    const run = await t.a.db.transaction((tx) => ensureRun(tx, lease, new Date()));
    const seen = await triggerCounts(t.a.db, eventId);
    // Another user's report attaches on the other connection while the job runs: its enqueue is a no-op (job open).
    const [row] = await t.a.db.select().from(events).where(eq(events.id, eventId));
    const attached = await createReport(t.b.db, userIds[4]!, {
      category: "road_closure",
      title: row!.title,
      description: "Still closed.",
      location: { coordinates: { latitude: row!.latitude, longitude: row!.longitude }, label: row!.approximateLocation },
    } as ReportEventPayload);
    expect(attached.event_id).toBe(eventId);
    const applied = await applyVerification(t.a.db, { lease, runId: run.id, evidence: [], retrieval: "no_results", note: null, now: new Date(), seen });
    expect(applied.outcome === "lost_lease" ? null : applied.followUp).toBe(true);
    const pending = await t.a.db.select().from(verificationJobs).where(and(eq(verificationJobs.eventId, eventId), eq(verificationJobs.status, "pending")));
    expect(pending).toHaveLength(1);
  });

  it("moves an existing open job earlier instead of adding a second one (real Postgres parameter encoding)", async () => {
    const { event_id: eventId } = await createReport(t.a.db, userIds[0]!, payload());
    const now = new Date();
    const [open] = await t.a.db.select().from(verificationJobs).where(and(eq(verificationJobs.eventId, eventId), eq(verificationJobs.status, "pending")));
    await t.a.db.update(verificationJobs).set({ availableAt: new Date(now.getTime() + 60 * 60_000) }).where(eq(verificationJobs.id, open!.id));
    const soon = new Date(now.getTime() + 5 * 60_000);
    const inserted = await t.b.db.transaction((tx) => enqueueWorkerJob(tx, { eventId, reason: "RECHECK", idempotencyKey: `recheck:${eventId}`, availableAt: soon, now }));
    expect(inserted).toBe(false);
    const jobs = await t.a.db.select().from(verificationJobs).where(eq(verificationJobs.eventId, eventId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.availableAt.getTime()).toBe(soon.getTime());
  });

  it("makes concurrent transitions atomic: one wins, the audit and timeline get exactly one entry", async () => {
    const { event_id: eventId } = await createReport(t.a.db, userIds[5]!, payload());
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 ? t.a.db : t.b.db).transaction((tx) =>
          transitionEvent(tx, { eventId, to: "DEVELOPING", reason: "concurrency test", actor: { type: "verifier" }, expectedFrom: "UNVERIFIED" }),
        ),
      ),
    );
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    const transitions = await t.a.db.select().from(eventStateTransitions).where(and(eq(eventStateTransitions.eventId, eventId), eq(eventStateTransitions.toStatus, "DEVELOPING")));
    expect(transitions).toHaveLength(1);
    const timeline = await t.a.db.select().from(eventTimeline).where(and(eq(eventTimeline.eventId, eventId), eq(eventTimeline.kind, "status_changed")));
    expect(timeline).toHaveLength(1);
    // The status trigger still rejects a direct write that bypasses the transition service.
    await expect(t.b.db.update(events).set({ status: "VERIFIED" }).where(eq(events.id, eventId))).rejects.toThrow();
  });

  it("runs the full S5 path on real Postgres: extract reservations, agent claim/save/cleanup, sweeps (mocked providers)", async () => {
    const clock = new FakeClock(Date.now() + 5_000);
    const { event_id: eventId } = await createReport(t.a.db, userIds[7]!, payload({ location: { coordinates: { latitude: 41.5, longitude: -88.5 }, label: "Test St & 1st Ave" } } as Partial<ReportEventPayload>));
    const searchUrl = `https://outlet-pg-${clock.now().getTime()}.example/story`;
    const agentUrl = `https://dot.ca.gov/alerts/pg-${clock.now().getTime()}`;
    const retriever = fakeRetriever(() => results.found([newsAt(clock, { canonicalUrl: searchUrl, excerpt: null, stance: "context", locationMatch: "near", publishedAt: null, publishedAtPrecision: null })]));
    const extractor = fakeExtractor({
      [searchUrl]: pageRead(searchUrl, "Lanes of Test St are closed near 1st Ave.", clock.ago(6)),
      [agentUrl]: pageRead(agentUrl, "All lanes of Test St are closed for emergency repairs.", clock.ago(4)),
    });
    const investigator = fakeInvestigator({ poll: () => ({ status: "completed", citations: [{ url: agentUrl, title: "Test St", excerpts: [], providerCategory: null, providerSourceType: null }], proposals: [] }) });
    const lease = await claimOne(t.b.db, eventId, "w_full", clock.now());
    const outcome = await processJob(
      { db: t.b.db, config: testConfig(), retriever, extractor, investigator, geocoder: null, now: clock.now, random: () => 0.5, sleep: async () => undefined, log: silentLog },
      lease,
    );
    expect(outcome).toBe("state_changed");
    const [run] = await t.a.db.select().from(verificationRuns).where(eq(verificationRuns.jobId, lease.jobId));
    expect(run).toMatchObject({ extractCount: 2, agentRunCount: 1, agentRunId: "task_run_1", agentId: "agent_1" });
    expect(run!.agentCleanedUpAt).not.toBeNull();
    expect(extractor.urls).toEqual([searchUrl, agentUrl]);
    const [event] = await t.a.db.select().from(events).where(eq(events.id, eventId));
    expect(event!.status).toBe("VERIFIED");
    // Daily budgets were counted in the real database.
    const budgets = (await t.a.db.execute(sql`select key, count from rate_limit_counters where key like 'budget:%' order by key`)) as unknown as Array<{ key: string; count: number }>;
    expect(budgets.map((b) => b.key)).toEqual(expect.arrayContaining(["budget:agent", "budget:extract", "budget:search"]));
    // Both sweeps run cleanly on real Postgres.
    expect(await sweepAgentResources(t.a.db, fakeInvestigator(), clock.now)).toBe(0);
    await sweepAging(t.a.db, { now: clock.now() });
  });

  it("runs two workers end to end on separate connections: every job processed exactly once (mocked providers)", async () => {
    const clock = new FakeClock(Date.now() + 5_000);
    const created: string[] = [];
    for (let i = 0; i < 8; i++) created.push((await createReport(t.a.db, userIds[6 + (i % 6)]!, payload())).event_id);
    await t.a.db.execute(sql`update verification_jobs set available_at = ${clock.now().toISOString()} where status = 'pending'`);
    const deps = (db: Throwaway["a"]["db"]): WorkerDeps => ({
      db,
      config: testConfig(),
      retriever: fakeRetriever(() => results.found([officialAt(clock), newsAt(clock)])),
      extractor: unconfiguredExtractor,
      investigator: fakeInvestigator(),
      geocoder: null,
      now: clock.now,
      random: () => 0.5,
      sleep: async () => undefined,
      log: silentLog,
    });
    const worker = async (db: Throwaway["a"]["db"], id: string) => {
      const processed: string[] = [];
      for (;;) {
        const leases = (await claimJobs(db, { workerId: id, limit: 2, now: clock.now() })).filter((l) => created.includes(l.eventId));
        if (leases.length === 0) break;
        for (const lease of leases) {
          await processJob(deps(db), lease);
          processed.push(lease.jobId);
        }
      }
      return processed;
    };
    const [fromA, fromB] = await Promise.all([worker(t.a.db, "w_e2e_a"), worker(t.b.db, "w_e2e_b")]);
    const all = [...fromA, ...fromB];
    expect(new Set(all).size).toBe(all.length);
    // The report jobs ran once each; each run then scheduled its own RECHECK (pending, not yet attempted).
    const jobs = await t.a.db.select().from(verificationJobs).where(sql`event_id in ${created}`);
    const original = jobs.filter((j) => j.reason === "NEW_REPORT");
    expect(original).toHaveLength(created.length);
    expect(original.every((j) => j.status === "succeeded" && j.attempts === 1)).toBe(true);
    expect(jobs.filter((j) => j.reason === "RECHECK").every((j) => j.status === "pending" && j.attempts === 0)).toBe(true);
    const runs = await t.a.db.select().from(verificationRuns).where(sql`event_id in ${created}`);
    expect(runs).toHaveLength(created.length);
    const statuses = await t.a.db.select({ status: events.status }).from(events).where(sql`id in ${created}`);
    expect(statuses.every((s) => s.status === "VERIFIED")).toBe(true);
    // Reports are untouched by verification.
    const [r] = (await t.a.db.execute(sql`select count(*)::int as n from reports where event_id in ${created}`)) as unknown as Array<{ n: number }>;
    expect(r!.n).toBe(created.length);
    expect(reports).toBeDefined();
  }, 120_000);
});
