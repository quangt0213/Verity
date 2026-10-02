import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema";

export type Schema = typeof schema;
export type Database = PgDatabase<PgQueryResultHKT, Schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Anything queries can run on: the pool or an open transaction. */
export type Queryable = Database | Tx;

export interface DatabaseHandle {
  db: Database;
  kind: "postgres" | "pglite";
  migrate(): Promise<void>;
  close(): Promise<void>;
}

function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.MIGRATIONS_DIR,
    resolve(process.cwd(), "drizzle"),
    resolve(here, "../../drizzle"),
    resolve(here, "../drizzle"),
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => existsSync(resolve(p, "meta/_journal.json")));
  if (!found) throw new Error("Migrations folder not found (set MIGRATIONS_DIR)");
  return found;
}

/**
 * Production uses Postgres (postgres.js, parameterized queries only). Local
 * development and tests can use PGlite, real Postgres compiled to WASM, so no
 * database server is required: "pglite:memory" or "pglite:<directory>".
 */
export function createDatabase(url: string): DatabaseHandle {
  if (url.startsWith("pglite:")) {
    const target = url.slice("pglite:".length);
    let client: PGlite;
    if (target === "memory" || target === "") {
      client = new PGlite();
    } else {
      mkdirSync(target, { recursive: true });
      client = new PGlite(target);
    }
    const db = drizzlePglite(client, { schema }) as unknown as Database;
    return {
      db,
      kind: "pglite",
      migrate: () => migratePglite(db as never, { migrationsFolder: migrationsFolder() }),
      close: () => client.close(),
    };
  }

  const sql = postgres(url, { max: 10, idle_timeout: 20, connect_timeout: 10, onnotice: () => undefined });
  const db = drizzlePostgres(sql, { schema }) as unknown as Database;
  return {
    db,
    kind: "postgres",
    migrate: () => migratePostgres(db as never, { migrationsFolder: migrationsFolder() }),
    close: () => sql.end({ timeout: 5 }),
  };
}
