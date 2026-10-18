import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { ReportEventPayload } from "@verity/contracts";
import { buildDemoEvents } from "@verity/contracts/demo";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client";
import * as schema from "../src/db/schema";
import { insertDemoEvents } from "../src/db/seed";
import { createReport } from "../src/domain/reports";
import { verificationSchemaReady } from "../src/worker/schema-ready";
import { createTestContext, SUPABASE_LIKE_SETUP, validReport, type TestContext } from "./helpers";
import { MIGRATIONS, migrationsUpTo, rows, snapshotTables } from "./migration-helpers";

/**
 * Migration 0006 (report_schedules) regression coverage, on PGlite with
 * Supabase-like roles (client roles granted every new table by default, the
 * service as a non-superuser, non-BYPASSRLS owner). The real-PostgreSQL
 * concurrency suite separately checks 0000-0006 apply and RLS is on.
 */

const LAST_BEFORE = "0005_extract_count_agent_resource";
const CLIENT_ROLES = ["anon", "authenticated"] as const;
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

const historyCount = async (db: Database) => (await rows<{ n: number }>(db, sql`select count(*)::int as n from drizzle.__drizzle_migrations`))[0]!.n;
const publicTables = async (db: Database) =>
  (await rows<{ t: string }>(db, sql`select tablename as t from pg_tables where schemaname = 'public' order by 1`)).map((r) => r.t);

/** Runs `query` as a client role in a transaction that is always rolled back; returns the SQLSTATE it failed with. */
async function asClientRole(db: Database, role: string, query: ReturnType<typeof sql>): Promise<string | undefined> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE ${role}`));
      await tx.execute(query);
      throw Object.assign(new Error("query was allowed"), { code: "allowed" });
    });
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

describe("0006 on a populated 0005 database (Supabase-like roles)", () => {
  let client: PGlite;
  let db: Database;
  let dir: string;
  let tablesBefore: string[];
  let before: Record<string, string[]>;
  let reportId: string;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Database;
    for (const statement of SUPABASE_LIKE_SETUP) await db.execute(sql.raw(statement));
    dir = migrationsUpTo(LAST_BEFORE);
    await migrate(db as never, { migrationsFolder: dir });

    // Data in every kind of table the service writes: demo events with URL evidence, a community report
    // (event, report, community evidence, timeline, audit, pending job), a run, a signal, a follow,
    // a geocode cache entry and a rate-limit counter.
    await insertDemoEvents(db, buildDemoEvents(new Date()));
    const [user] = await rows<{ id: string }>(db, sql`insert into users (email) values ('upgrade-0005@example.com') returning id`);
    const created = await createReport(db, user!.id, validReport as ReportEventPayload);
    reportId = created.report_id!;
    const [job] = await rows<{ id: string }>(db, sql`select id from verification_jobs where event_id = ${created.event_id}`);
    await db.execute(sql`insert into verification_runs (job_id, event_id, extract_count) values (${job!.id}, ${created.event_id}, 2)`);
    await db.execute(sql`insert into community_signals (event_id, user_id, type, signal_group) values (${created.event_id}, ${user!.id}, 'CONFIRM', 'validity')`);
    await db.execute(sql`insert into event_follows (user_id, event_id) values (${user!.id}, ${created.event_id})`);
    await db.execute(sql`insert into geocode_cache (provider, cell_key, status, city, expires_at) values ('test', '37.760,-122.419', 'ok', 'San Francisco', now() + interval '1 day')`);
    await db.execute(sql`insert into rate_limit_counters (key, window_start, count, expires_at) values ('budget:search', date_trunc('day', now()), 3, now() + interval '2 days')`);

    tablesBefore = await publicTables(db);
    before = await snapshotTables(db, tablesBefore);
  });

  afterAll(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts at 0005: six migrations, no report_schedules, and the worker is not ready", async () => {
    expect(await historyCount(db)).toBe(6);
    expect(tablesBefore).not.toContain("report_schedules");
    for (const t of ["events", "reports", "source_records", "verification_jobs", "verification_runs", "community_signals", "event_follows", "geocode_cache", "rate_limit_counters"]) {
      expect(before[t]!.length, t).toBeGreaterThan(0);
    }
    expect(await verificationSchemaReady(db)).toBe(false);
  });

  it("applies 0006 without changing any existing row, and the worker becomes ready", async () => {
    await migrate(db as never, { migrationsFolder: MIGRATIONS });
    expect(await historyCount(db)).toBe(7);
    expect(await publicTables(db)).toEqual([...tablesBefore, "report_schedules"].sort());
    expect(await snapshotTables(db, tablesBefore)).toEqual(before);
    expect(await rows(db, sql`select * from report_schedules`)).toEqual([]);
    expect(await verificationSchemaReady(db)).toBe(true);
  });

  it("is a no-op when migrations run again", async () => {
    const columns = sql`select column_name, data_type, is_nullable from information_schema.columns where table_name = 'report_schedules' order by ordinal_position`;
    const shape = await rows(db, columns);
    await migrate(db as never, { migrationsFolder: MIGRATIONS });
    await migrate(db as never, { migrationsFolder: MIGRATIONS });
    expect(await historyCount(db)).toBe(7);
    expect(await rows(db, columns)).toEqual(shape);
    expect(await snapshotTables(db, tablesBefore)).toEqual(before);
  });

  it("enforces its constraints: start required, end not before start, an existing report, cascade on report delete", async () => {
    await db.execute(sql`insert into report_schedules (report_id, scheduled_start_at, scheduled_end_at) values (${reportId}, now(), now() + interval '2 hours')`);
    await expect(db.execute(sql`update report_schedules set scheduled_end_at = scheduled_start_at - interval '1 minute' where report_id = ${reportId}`)).rejects.toThrow();
    await expect(db.execute(sql`update report_schedules set scheduled_start_at = null where report_id = ${reportId}`)).rejects.toThrow();
    await expect(db.execute(sql`insert into report_schedules (report_id, scheduled_start_at) values (gen_random_uuid(), now())`)).rejects.toThrow();
    // A start equal to the end (a point in time) is allowed.
    await db.execute(sql`update report_schedules set scheduled_end_at = scheduled_start_at where report_id = ${reportId}`);

    // Cascade: a report without evidence rows, with a schedule, deleted.
    const [event] = await rows<{ id: string }>(db, sql`select event_id as id from reports where id = ${reportId}`);
    const [user] = await rows<{ id: string }>(db, sql`select id from users limit 1`);
    const [bare] = await rows<{ id: string }>(
      db,
      sql`insert into reports (event_id, reporter_user_id, category, title, latitude, longitude, attach_outcome)
          values (${event!.id}, ${user!.id}, 'festival', 'A bare festival report', 37.76, -122.42, 'attached_to_existing') returning id`,
    );
    await db.execute(sql`insert into report_schedules (report_id, scheduled_start_at) values (${bare!.id}, now())`);
    await db.execute(sql`delete from reports where id = ${bare!.id}`);
    expect(await rows(db, sql`select 1 from report_schedules where report_id = ${bare!.id}`)).toEqual([]);
  });

  it("has RLS on, no policies, the service as owner, and no effective privilege for client roles", async () => {
    const [table] = await rows<{ rls: boolean; owner: string; policies: number }>(
      db,
      sql`select c.relrowsecurity as rls, pg_get_userbyid(c.relowner) as owner,
                 (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = 'report_schedules') as policies
          from pg_class c where c.oid = to_regclass('public.report_schedules')`,
    );
    expect(table).toEqual({ rls: true, owner: "verity_service", policies: 0 });
    // has_table_privilege reports EFFECTIVE privileges (including role membership and PUBLIC), not just rows in the grants table.
    for (const role of CLIENT_ROLES) {
      for (const privilege of PRIVILEGES) {
        const [p] = await rows<{ ok: boolean }>(db, sql`select has_table_privilege(${role}, 'public.report_schedules', ${privilege}) as ok`);
        expect(p!.ok, `${role} ${privilege}`).toBe(false);
      }
      expect(await asClientRole(db, role, sql`select * from report_schedules`)).toBe("42501");
      expect(await asClientRole(db, role, sql`insert into report_schedules (report_id, scheduled_start_at) values (${reportId}, now())`)).toBe("42501");
      expect(await asClientRole(db, role, sql`delete from report_schedules`)).toBe("42501");
    }
    // Control: the probe does detect a privilege (a mistaken grant, rolled back), and RLS still hides every row then.
    let detected: { ok: boolean; visible: number } | undefined;
    await db
      .transaction(async (tx) => {
        await tx.execute(sql`grant select on report_schedules to anon`);
        const [p] = await rows<{ ok: boolean }>(tx, sql`select has_table_privilege('anon', 'public.report_schedules', 'SELECT') as ok`);
        await tx.execute(sql`set local role anon`);
        const [v] = await rows<{ n: number }>(tx, sql`select count(*)::int as n from report_schedules`);
        detected = { ok: p!.ok, visible: v!.n };
        throw new Error("rollback");
      })
      .catch(() => undefined);
    expect(detected).toEqual({ ok: true, visible: 0 });
    const [after] = await rows<{ ok: boolean }>(db, sql`select has_table_privilege('anon', 'public.report_schedules', 'SELECT') as ok`);
    expect(after!.ok).toBe(false);
  });
});

describe("partial deploy: new API code on a 0005 database", () => {
  let ctx: TestContext;
  let dir: string;
  let token: string;
  const COUNTED = ["events", "reports", "source_records", "verification_jobs", "event_timeline", "event_state_transitions"] as const;
  const counts = async () =>
    Object.fromEntries(await Promise.all(COUNTED.map(async (t) => [t, (await rows<{ n: number }>(ctx.db, sql.raw(`select count(*)::int as n from ${t}`)))[0]!.n] as const))) as Record<
      (typeof COUNTED)[number],
      number
    >;

  beforeAll(async () => {
    dir = migrationsUpTo(LAST_BEFORE);
    ctx = await createTestContext({}, { migrate: (db) => migrate(db as never, { migrationsFolder: dir }) });
    token = await ctx.signIn("partial-deploy@example.com");
  });
  afterAll(async () => {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rolls a schedule-bearing report back completely and answers a generic 500 that names nothing internal", async () => {
    const start = new Date(Date.now() + 24 * 3600_000);
    const payload = {
      category: "festival",
      title: "Partial deploy fair",
      location: { coordinates: { latitude: 37.3328, longitude: -121.8901 }, label: "Plaza de César Chávez, San Jose, CA" },
      scheduled_start_at: start.toISOString(),
      scheduled_end_at: new Date(start.getTime() + 6 * 3600_000).toISOString(),
    };
    const before = await counts();
    const res = await ctx.request({ method: "POST", url: "/api/v1/reports", token, payload });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "internal", message: "Something went wrong.", request_id: expect.any(String) } });
    expect(res.body).not.toMatch(/report_schedules|relation|does not exist|insert into|42P01|select |drizzle|pglite/i);
    // One transaction: no orphan event, report, evidence, timeline, audit or job rows.
    expect(await counts()).toEqual(before);
  });

  it("still accepts a report without a schedule", async () => {
    const before = await counts();
    const res = await ctx.request({ method: "POST", url: "/api/v1/reports", token, payload: validReport });
    expect(res.statusCode).toBe(201);
    const after = await counts();
    expect(after.reports).toBe(before.reports + 1);
    expect(after.verification_jobs).toBe(before.verification_jobs + 1);
  });
});
