import type { ReportEventPayload } from "@verity/contracts";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events } from "../../src/db/schema";
import { createReport } from "../../src/domain/reports";
import { DEFAULT_POLICY } from "../../src/verification/policy";
import { createWorker } from "../../src/worker/loop";
import { sweepAging } from "../../src/worker/sweep";
import { createTestContext, type TestContext } from "../helpers";
import { deps, eventRow, FakeClock, jobsFor, testConfig } from "./harness";

/**
 * V1: the aging sweep selects a batch ordered by last_checked_at, but never
 * changes last_checked_at for events it leaves alone. With more sweepable
 * events than one batch, the same batch repeats and events beyond it are
 * never swept.
 */

let ctx: TestContext;
let token: string;
beforeAll(async () => {
  ctx = await createTestContext();
  token = await ctx.signIn("sweep-starvation@example.com");
});
afterAll(async () => ctx.close());

const BATCH = 2;
const HOUR = 3600_000;

let spot = 0;
/** Report straight through the domain service (no HTTP rate limits), each at its own place. */
async function report(category: "road_closure" | "festival", title: string): Promise<string> {
  spot += 1;
  const userId = await ctx.userIdFor(token);
  const result = await createReport(ctx.db, userId, {
    category,
    title,
    location: { coordinates: { latitude: 10 + spot * 0.05, longitude: 10 + spot * 0.05 } },
  } as ReportEventPayload);
  return result.event_id;
}

/** Five untouched UNVERIFIED events, then one festival whose KNOWN scheduled end has passed (the sweep should resolve it). */
async function setUp() {
  const idle: string[] = [];
  for (let i = 0; i < 5; i++) idle.push(await report("road_closure", `Idle event number ${spot}`));
  const target = await report("festival", `Ended street fair ${spot}`);
  const now = new Date();
  await ctx.db.update(events).set({ scheduledStartAt: new Date(now.getTime() - 5 * HOUR), scheduledEndAt: new Date(now.getTime() - 3 * HOUR) }).where(eq(events.id, target));
  // The ended event was checked once, so "last_checked_at asc nulls first" puts it after every never-checked event.
  await ctx.db.update(events).set({ lastCheckedAt: new Date(now.getTime() - HOUR) }).where(eq(events.id, target));
  return { idle, target, now };
}

async function clearAll() {
  // Each case starts from its own events only: earlier cases' events become non-sweepable.
  const rows = await ctx.db.select({ id: events.id }).from(events).where(eq(events.isDemo, false));
  if (rows.length > 0) await ctx.db.update(events).set({ isDemo: true }).where(inArray(events.id, rows.map((r) => r.id)));
}

describe("aging sweep with more sweepable events than one batch", () => {
  it("without a cursor (one-off calls), each call only ever sees the first batch", async () => {
    await clearAll();
    const { target, now } = await setUp();
    for (let tick = 0; tick < 5; tick++) await sweepAging(ctx.db, { now: new Date(now.getTime() + tick * 60_000), limit: BATCH });
    // The same first batch every time: the ended event is never reached.
    expect((await eventRow(ctx, target)).status).toBe("UNVERIFIED");
  });

  it("with the worker's cursor, every event is reached within ceil(N / batch) sweeps", async () => {
    await clearAll();
    const { idle, target, now } = await setUp();
    const cursor = { after: null as string | null };
    const swept: string[] = [];
    const rounds = Math.ceil((idle.length + 1) / BATCH);
    for (let tick = 0; tick < rounds; tick++) {
      const applied = await sweepAging(ctx.db, { now: new Date(now.getTime() + tick * 60_000), limit: BATCH, cursor });
      swept.push(...applied.map((a) => a.eventId));
    }
    expect(swept).toEqual([target]);
    expect((await eventRow(ctx, target)).status).toBe("RESOLVED");
  });

  it("the worker loop carries the cursor from one sweep to the next", async () => {
    await clearAll();
    const { target, now } = await setUp();
    const clock = new FakeClock(now.getTime());
    const policy = { ...DEFAULT_POLICY, sweep: { intervalMinutes: 1, batchSize: BATCH } };
    // No job claims (concurrency 0): only the sweep can resolve the event.
    const worker = createWorker({ ...deps(ctx, clock, { config: testConfig({}, { concurrency: 0 }) }), policy, workerId: "w_sweep" });
    for (let tick = 0; tick < 3; tick++) {
      await worker.tick();
      clock.minutes(2);
    }
    await worker.drain();
    expect((await eventRow(ctx, target)).status).toBe("RESOLVED");
    expect((await jobsFor(ctx, target)).every((j) => j.attempts === 0)).toBe(true); // resolved by the sweep, not a job
  });

  it("wraps around: a pass that ends short restarts from the beginning", async () => {
    await clearAll();
    await setUp();
    const cursor = { after: null as string | null };
    const seen = new Set<string | null>();
    for (let tick = 0; tick < 4; tick++) {
      await sweepAging(ctx.db, { now: new Date(), limit: BATCH, cursor });
      seen.add(cursor.after);
    }
    // 6 events, batch 2: three full batches advance through three positions, then the fourth call finds nothing past the last id and resets.
    expect([...seen].filter((s) => s !== null)).toHaveLength(3);
    expect(seen).toContain(null);
  });
});
