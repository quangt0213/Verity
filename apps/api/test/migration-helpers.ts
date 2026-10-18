import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sql, type SQL } from "drizzle-orm";
import type { Queryable } from "../src/db/client";

export const MIGRATIONS = resolve(__dirname, "../drizzle");

/** A temporary copy of the migrations folder whose journal stops after `lastTag` (the caller removes it). */
export function migrationsUpTo(lastTag: string): string {
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

/** Rows of a raw query on PGlite (`{ rows }`) or postgres-js (an array). */
export async function rows<T>(db: Queryable, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as T[] | { rows: T[] };
  return Array.isArray(result) ? result : result.rows;
}

/** Every row of every listed table, as sorted JSON text: equal snapshots mean no row was added, removed or changed. */
export async function snapshotTables(db: Queryable, tables: readonly string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of tables) {
    if (!/^[a-z_]+$/.test(table)) throw new Error(`unsafe table name ${table}`);
    const found = await rows<{ row: string }>(db, sql.raw(`select row_to_json(t)::text as row from public.${table} t`));
    out[table] = found.map((r) => r.row).sort();
  }
  return out;
}
