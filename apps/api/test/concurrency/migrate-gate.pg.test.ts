import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyMigrationFailure, MIGRATION_TIMEOUT_DEFAULTS, MigrationRunError, runMigrations, type MigrationFailure } from "../../src/db/migrate-runner";
import { MIGRATIONS, migrationsUpTo } from "../migration-helpers";
import { target } from "./pg-target";

/**
 * OPT-IN: the db:migrate gate on a REAL PostgreSQL server (TEST_DATABASE_URL,
 * local and disposable; see pg-target.ts). Proves that the lock and statement
 * timeouts set on the migrator's single connection are in force INSIDE the
 * drizzle migration transaction, and that a timeout leaves nothing behind.
 */

describe.skipIf(!target)("migration gate on real PostgreSQL", () => {
  let admin: postgres.Sql;
  let probe: postgres.Sql;
  let url: string;
  let name: string;
  const folders: string[] = [];

  const history = async () => (await probe`select count(*)::int as n from drizzle.__drizzle_migrations`)[0]!.n as number;
  const hasSchedules = async () => (await probe`select to_regclass('public.report_schedules') is not null as present`)[0]!.present as boolean;
  const migrateTo = (folder: string, timeouts = MIGRATION_TIMEOUT_DEFAULTS, at = url) => runMigrations({ url: at, ca: null, timeouts, migrationsFolder: folder });
  /** What scripts/migrate.ts would report for a failed run (null when it succeeded). */
  const outcomeOf = (run: Promise<unknown>): Promise<MigrationFailure | null> =>
    run.then(
      () => null,
      (error: unknown) => classifyMigrationFailure(error instanceof MigrationRunError ? error.cause : error, { started: error instanceof MigrationRunError ? error.started : true }),
    );

  beforeAll(async () => {
    name = `verity_migrate_${randomBytes(4).toString("hex")}`;
    admin = postgres(target!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const u = new URL(target!);
    u.pathname = `/${name}`;
    url = u.toString();
    probe = postgres(url, { max: 2, onnotice: () => undefined });
    const upTo0005 = migrationsUpTo("0005_extract_count_agent_resource");
    folders.push(upTo0005);
    // The gate itself applies 0000-0005 and reports the effective settings.
    expect(await migrateTo(upTo0005)).toEqual({ lockTimeout: "5s", statementTimeout: "1min" });
  }, 120_000);

  afterAll(async () => {
    await probe?.end({ timeout: 5 });
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end({ timeout: 5 });
    for (const f of folders) rmSync(f, { recursive: true, force: true });
  });

  it("starts at 0005", async () => {
    expect(await history()).toBe(6);
    expect(await hasSchedules()).toBe(false);
  });

  it("gives up within the lock timeout when another session holds reports, and leaves no partial 0006", async () => {
    const holder = await probe.reserve();
    try {
      await holder`begin`;
      await holder`lock table reports in access exclusive mode`;
      const started = Date.now();
      const failure = await outcomeOf(migrateTo(MIGRATIONS, { lockTimeoutMs: 500, statementTimeoutMs: 60_000 }));
      const elapsed = Date.now() - started;
      // lock_not_available, reported as a confirmed rollback.
      expect(failure).toMatchObject({ outcome: "rolled_back", exitCode: 4, code: "55P03" });
      expect(failure!.message).toContain("PostgreSQL rolled back the migration transaction; nothing from it was applied.");
      expect(elapsed).toBeLessThan(10_000); // bounded by the 500 ms lock timeout plus connection setup, not the held lock
      await holder`rollback`;
    } finally {
      holder.release();
    }
    // The whole migration transaction rolled back: no table, no history row.
    expect(await hasSchedules()).toBe(false);
    expect(await history()).toBe(6);
  });

  it("applies 0006 once the lock is gone, with the bounds still in effect", async () => {
    expect(await migrateTo(MIGRATIONS, { lockTimeoutMs: 2_000, statementTimeoutMs: 30_000 })).toEqual({ lockTimeout: "2s", statementTimeout: "30s" });
    expect(await hasSchedules()).toBe(true);
    expect(await history()).toBe(7);
  });

  it("stops a migration statement at the statement timeout and records nothing", async () => {
    // A probe migration after 0006 that sleeps longer than the bound.
    const folder = migrationsUpTo("0006_report_schedules");
    folders.push(folder);
    const journalPath = join(folder, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<Record<string, unknown>> };
    journal.entries.push({ idx: journal.entries.length, version: "7", when: Date.now() + 60_000, tag: "9999_sleep_probe", breakpoints: true });
    writeFileSync(journalPath, JSON.stringify(journal));
    writeFileSync(join(folder, "9999_sleep_probe.sql"), "CREATE TABLE sleep_probe (id int);--> statement-breakpoint\nSELECT pg_sleep(5);");

    const failure = await outcomeOf(migrateTo(folder, { lockTimeoutMs: 5_000, statementTimeoutMs: 1_000 }));
    // query_canceled (statement_timeout), reported as a confirmed rollback.
    expect(failure).toMatchObject({ outcome: "rolled_back", exitCode: 4, code: "57014" });
    expect((await probe`select to_regclass('public.sleep_probe') is not null as present`)[0]!.present).toBe(false);
    expect(await history()).toBe(7);
  });

  it("reports an UNKNOWN outcome when the migration session is lost mid-run (never a rollback claim)", async () => {
    // A probe migration that waits on a lock held by another session; meanwhile the migrator's backend is terminated.
    await probe`create table if not exists lock_probe (id int)`;
    const folder = migrationsUpTo("0006_report_schedules");
    folders.push(folder);
    const journalPath = join(folder, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<Record<string, unknown>> };
    journal.entries.push({ idx: journal.entries.length, version: "7", when: Date.now() + 120_000, tag: "9998_lock_probe", breakpoints: true });
    writeFileSync(journalPath, JSON.stringify(journal));
    writeFileSync(join(folder, "9998_lock_probe.sql"), "CREATE TABLE after_lock_probe (id int);--> statement-breakpoint\nLOCK TABLE lock_probe IN ACCESS EXCLUSIVE MODE;");

    const holder = await probe.reserve();
    try {
      await holder`begin`;
      await holder`lock table lock_probe in access exclusive mode`;
      const run = outcomeOf(migrateTo(folder, { lockTimeoutMs: 30_000, statementTimeoutMs: 60_000 }));
      // Wait until the migrator is blocked on the lock, then end its session like an outage would.
      let terminated = false;
      for (let i = 0; i < 100 && !terminated; i++) {
        const waiting = await admin`select pid from pg_stat_activity where datname = ${name} and wait_event_type = 'Lock' and query ilike '%lock_probe%'`;
        if (waiting.length > 0) {
          await admin`select pg_terminate_backend(${waiting[0]!.pid})`;
          terminated = true;
        } else await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(terminated).toBe(true);
      const failure = await run;
      expect(failure).toMatchObject({ outcome: "uncertain", exitCode: 5 });
      // postgres.js reports the dropped session as CONNECTION_CLOSED (observed); the server may also get 57P01 out first.
      expect(["CONNECTION_CLOSED", "57P01"]).toContain(failure!.code);
      expect(failure!.message).toMatch(/^Migration outcome UNKNOWN: the connection failed while migrations were running \(/);
      expect(failure!.message).not.toContain("rolled back");
      await holder`rollback`;
    } finally {
      holder.release();
    }
    // (Here the server did roll back; the client can't know that, which is why the operator inspects.)
    expect((await probe`select to_regclass('public.after_lock_probe') is not null as present`)[0]!.present).toBe(false);
    expect(await history()).toBe(7);
  });

  it("reports 'not attempted' when it can't connect to the database at all", async () => {
    const missing = new URL(url);
    missing.pathname = `/${name}_missing`;
    const failure = await outcomeOf(migrateTo(MIGRATIONS, MIGRATION_TIMEOUT_DEFAULTS, missing.toString()));
    expect(failure).toMatchObject({ outcome: "not_attempted", exitCode: 3, code: "3D000" });
    expect(failure!.message).not.toContain(name);
    expect(failure!.message).not.toContain("127.0.0.1");
  });
});
