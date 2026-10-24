import { sql } from "drizzle-orm";
import type { Queryable } from "../db/client";

/**
 * Whether the database has the verification schema the worker needs
 * (migrations 0003 to 0006). The worker refuses to start otherwise (e.g. an
 * un-migrated production database).
 *
 * This is a PRESENCE check only: it proves the tables (and one marker column)
 * exist. It does not prove that columns, constraints, grants or row level
 * security are correct; the migration tests cover those.
 */
export async function verificationSchemaReady(db: Queryable): Promise<boolean> {
  const result = (await db.execute(
    sql`select to_regclass('public.verification_runs') is not null
          and to_regclass('public.geocode_cache') is not null
          and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'verification_runs' and column_name = 'extract_count')
          and to_regclass('public.report_schedules') is not null
          as ready`,
  )) as unknown as Array<{ ready: boolean }> | { rows: Array<{ ready: boolean }> };
  const rows = Array.isArray(result) ? result : result.rows;
  return rows[0]?.ready === true;
}
