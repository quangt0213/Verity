import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimJobs } from "../../src/worker/jobs";
import { createTestContext, type TestContext } from "../helpers";
import { FakeClock, newEvent } from "./harness";

/**
 * Regression (round 4): claimJobs must never claim more than `limit` jobs.
 *
 * The original single statement, UPDATE … WHERE id IN (SELECT … LIMIT n FOR
 * UPDATE SKIP LOCKED), was planned as a nested-loop semi-join that re-scans
 * the locking subquery for every outer row; each re-scan skips the rows the
 * same statement has just updated, so ONE call claimed every ready job
 * (6 of 6 here on PGlite, 30 of 30 on PostgreSQL 18) whatever the limit. The
 * worker's concurrency setting was therefore not enforced.
 */

let ctx: TestContext;
let token: string;
beforeAll(async () => {
  ctx = await createTestContext();
  token = await ctx.signIn("claim-limit@example.com");
});
afterAll(async () => ctx.close());

const status = async () =>
  (await ctx.db.execute(sql`select status, attempts from verification_jobs order by created_at`)) as unknown as { rows: Array<{ status: string; attempts: number }> };

describe("claimJobs respects its limit", () => {
  it("claims at most `limit` ready jobs per call, oldest first, and leaves the rest pending and untouched", async () => {
    const clock = new FakeClock();
    const eventIds: string[] = [];
    for (let i = 0; i < 6; i++) eventIds.push(await newEvent(ctx, token, { title: `Claim limit closure number ${i}` }));
    // Every job ready at the same moment: ties are broken by creation order.
    await ctx.db.execute(sql`update verification_jobs set available_at = ${clock.now().toISOString()}::timestamptz where status = 'pending'`);

    const first = await claimJobs(ctx.db, { workerId: "w_limit", limit: 2, now: clock.now() });
    expect(first).toHaveLength(2);
    expect(first.map((l) => l.eventId)).toEqual(eventIds.slice(0, 2));
    const after = (await status()).rows;
    expect(after.filter((j) => j.status === "running")).toHaveLength(2);
    expect(after.filter((j) => j.status === "pending" && j.attempts === 0)).toHaveLength(4);

    expect((await claimJobs(ctx.db, { workerId: "w_limit", limit: 3, now: clock.now() })).map((l) => l.eventId)).toEqual(eventIds.slice(2, 5));
    expect((await claimJobs(ctx.db, { workerId: "w_limit", limit: 5, now: clock.now() })).map((l) => l.eventId)).toEqual(eventIds.slice(5));
    expect(await claimJobs(ctx.db, { workerId: "w_limit", limit: 5, now: clock.now() })).toEqual([]);
    expect((await status()).rows.every((j) => j.status === "running" && j.attempts === 1)).toBe(true);
  });
});
