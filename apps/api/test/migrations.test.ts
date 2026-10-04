import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { ReportEventPayload } from "@verity/contracts";
import { buildDemoEvents } from "@verity/contracts/demo";
import { sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client";
import * as schema from "../src/db/schema";
import { insertDemoEvents } from "../src/db/seed";
import { createReport } from "../src/domain/reports";
import { SUPABASE_LIKE_SETUP, validReport } from "./helpers";

// Production (Supabase) is already at 0002 with real rows. This upgrades a
// database in that state, under Supabase-like roles, to the current migrations.

const MIGRATIONS = resolve(__dirname, "../drizzle");

/** A copy of the migrations folder whose journal stops after `lastTag`. */
function migrationsUpTo(lastTag: string): string {
  const dir = mkdtempSync(join(tmpdir(), "verity-migrations-"));
  cpSync(MIGRATIONS, dir, { recursive: true });
  const journalPath = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
  const cut = journal.entries.findIndex((e) => e.tag === lastTag);
  if (cut < 0) throw new Error(`unknown migration ${lastTag}`);
  journal.entries = journal.entries.slice(0, cut + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

async function rows<T>(db: Database, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as T[] | { rows: T[] };
  return Array.isArray(result) ? result : result.rows;
}

interface TableCounts {
  events: number;
  reports: number;
  sources: number;
  jobs: number;
}

async function tableCounts(db: Database): Promise<TableCounts> {
  const [counts] = await rows<TableCounts>(
    db,
    sql`select (select count(*) from events)::int as events, (select count(*) from reports)::int as reports,
               (select count(*) from source_records)::int as sources, (select count(*) from verification_jobs)::int as jobs`,
  );
  if (!counts) throw new Error("no counts");
  return counts;
}

describe("upgrading a populated 0002 database to the current schema", () => {
  let client: PGlite;
  let db: Database;
  let phase2Dir: string;
  let before: TableCounts;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Database;
    for (const statement of SUPABASE_LIKE_SETUP) await db.execute(sql.raw(statement));

    phase2Dir = migrationsUpTo("0002_lock_down_supabase_data_api");
    await migrate(db as never, { migrationsFolder: phase2Dir });

    // Phase 2 data: demo events with URL evidence, and a real community report
    // (event, report, URL-less community evidence, timeline, pending job).
    await insertDemoEvents(db, buildDemoEvents(new Date()));
    const [user] = await rows<{ id: string }>(db, sql`insert into users (email) values ('upgrade@example.com') returning id`);
    await createReport(db, user!.id, validReport as ReportEventPayload);

    before = await tableCounts(db);
  });

  afterAll(async () => {
    await client.close();
    rmSync(phase2Dir, { recursive: true, force: true });
  });

  it("applies 0003 on top of existing data without losing rows", async () => {
    await migrate(db as never, { migrationsFolder: MIGRATIONS });

    const [applied] = await rows<{ n: number }>(db, sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(applied!.n).toBe(6);
    expect(await tableCounts(db)).toEqual(before);
    // The fixture really had data in every affected table.
    expect(Math.min(before.events, before.reports, before.sources, before.jobs)).toBeGreaterThan(0);
  });

  it.each(["verification_runs", "geocode_cache"])("protects the new table %s like every other Verity table", async (name) => {
    const [table] = await rows<{ rls: boolean; owner: string; anon: boolean; authenticated: boolean }>(
      db,
      sql`select c.relrowsecurity as rls, pg_get_userbyid(c.relowner) as owner,
                 has_table_privilege('anon', c.oid, 'SELECT') as anon,
                 has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = ${name}`,
    );
    expect(table).toEqual({ rls: true, owner: "verity_service", anon: false, authenticated: false });
  });

  it("enables the new reason and the canonical-URL rule on the upgraded data", async () => {
    const [job] = await rows<{ event_id: string }>(db, sql`select event_id from verification_jobs limit 1`);
    await db.execute(
      sql`insert into verification_jobs (kind, event_id, reason, status, idempotency_key)
          values ('VERIFY_EVENT', ${job!.event_id}, 'RECHECK', 'succeeded', 'upgrade:recheck')`,
    );
    const [dupes] = await rows<{ n: number }>(
      db,
      sql`select count(*)::int as n from (select event_id, source_url from source_records
          where source_url is not null group by 1, 2 having count(*) > 1) d`,
    );
    expect(dupes!.n).toBe(0);
  });

  it("0005 adds the extraction counter and agent-resource columns, with their constraints, to existing runs", async () => {
    const [job] = await rows<{ id: string; event_id: string }>(db, sql`select id, event_id from verification_jobs limit 1`);
    const [run] = await rows<{ id: string; extract_count: number; agent_id: string | null; agent_cleaned_up_at: string | null }>(
      db,
      sql`insert into verification_runs (job_id, event_id) values (${job!.id}, ${job!.event_id})
          returning id, extract_count, agent_id, agent_cleaned_up_at`,
    );
    expect(run).toMatchObject({ extract_count: 0, agent_id: null, agent_cleaned_up_at: null });
    // A resource id never exists without the run id it came with, and cleanup needs a resource.
    await expect(db.execute(sql`update verification_runs set agent_id = 'agent_x' where id = ${run!.id}`)).rejects.toThrow();
    await expect(db.execute(sql`update verification_runs set agent_cleaned_up_at = now() where id = ${run!.id}`)).rejects.toThrow();
    await expect(db.execute(sql`update verification_runs set extract_count = 51 where id = ${run!.id}`)).rejects.toThrow();
  });
});
