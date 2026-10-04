import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "../../src/db/client";
import { verificationJobs } from "../../src/db/schema";
import { claimJobs, heartbeat, type Lease } from "../../src/worker/jobs";
import { claimAgentSlot, ensureRun } from "../../src/worker/runs";
import { testConfig } from "../worker/harness";
import { target } from "./pg-target";

/**
 * OPT-IN: true concurrency against a real PostgreSQL server (PGlite has one
 * connection, so the normal suite can't prove this). Runs only when
 * TEST_DATABASE_URL points at a LOCAL disposable server, e.g.
 *
 *   docker run --rm -d -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=test postgres:17
 *   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm run test:concurrency -w @verity/api
 *
 * It creates its own throwaway database, migrates it, and drops it afterwards.
 * It never reads DATABASE_URL and refuses hosted/remote servers.
 */

describe.skipIf(!target)("job claiming on real PostgreSQL (separate connections)", () => {
  const dbName = `verity_concurrency_${randomBytes(4).toString("hex")}`;
  let admin: ReturnType<typeof postgres>;
  let a: DatabaseHandle;
  let b: DatabaseHandle;

  beforeAll(async () => {
    admin = postgres(target!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(target!);
    url.pathname = `/${dbName}`;
    a = createDatabase(url.toString());
    b = createDatabase(url.toString());
    await a.migrate();
  }, 120_000);

  afterAll(async () => {
    await a?.close();
    await b?.close();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  let seeded = 0;
  async function seedJobs(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const [event] = (await a.db.execute(
        sql`insert into events (title, category, latitude, longitude, approximate_location, origin)
            values (${`Concurrency ${i}`}, 'crash', ${i * 0.01}, 0, 'x', 'community_report') returning id`,
      )) as unknown as Array<{ id: string }>;
      const [job] = await a.db
        .insert(verificationJobs)
        .values({ kind: "VERIFY_EVENT", eventId: event!.id, reason: "NEW_REPORT", idempotencyKey: `conc:${dbName}:${seeded++}:${i}`, availableAt: new Date(0) })
        .returning({ id: verificationJobs.id });
      ids.push(job!.id);
    }
    return ids;
  }

  it("never lets two connections claim the same job", async () => {
    const ids = await seedJobs(40);
    const now = new Date();
    const claimed: Lease[] = [];
    // 40 concurrent claim calls, alternating between two independent pools.
    const batches = await Promise.all(
      Array.from({ length: 40 }, (_, i) => claimJobs(i % 2 ? a.db : b.db, { workerId: `w_${i % 2 ? "a" : "b"}_${i}`, limit: 3, now })),
    );
    for (const batch of batches) claimed.push(...batch);
    const mine = claimed.filter((l) => ids.includes(l.jobId));
    expect(new Set(mine.map((l) => l.jobId)).size).toBe(mine.length);
    expect(mine.length).toBe(40);
    const rows = (await a.db.execute(sql`select attempts, locked_by from verification_jobs where id in ${ids}`)) as unknown as Array<{ attempts: number; locked_by: string }>;
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
    for (const lease of mine) expect(rows.some((r) => r.locked_by === lease.workerId)).toBe(true);
  });

  it("gives a single job to exactly one of many racing workers", async () => {
    const [id] = await seedJobs(1);
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => claimJobs(i % 2 ? a.db : b.db, { workerId: `racer_${i}`, limit: 1, now })));
    const winners = results.flat().filter((l) => l.jobId === id);
    expect(winners).toHaveLength(1);
  });

  it("claims the agent slot exactly once under concurrent attempts, and fences stale leases", async () => {
    const [id] = await seedJobs(1);
    const [lease] = (await claimJobs(a.db, { workerId: "w_owner", limit: 50, now: new Date() })).filter((l) => l.jobId === id);
    const run = await a.db.transaction((tx) => ensureRun(tx, lease!, new Date()));
    const config = testConfig({ dailyAgentBudget: 500, agentMaxPerEvent: 10 });
    const attempts = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        claimAgentSlot(i % 2 ? a.db : b.db, { lease: lease!, runId: run.id, reason: "insufficient_independent", config, now: new Date() }),
      ),
    );
    expect(attempts.filter((s) => s.status === "claimed")).toHaveLength(1);
    // A stale lease (older attempt) cannot heartbeat from either connection.
    expect(await heartbeat(b.db, { ...lease!, attempt: lease!.attempt - 1 }, new Date())).toBe(false);
    expect(await heartbeat(b.db, lease!, new Date())).toBe(true);
  });
});
