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
import { isLocalDatabase } from "./target-guard";
import { DatabaseTlsError } from "./tls";

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

export interface DatabaseOptions {
  /** PEM CA bundle from resolveDatabaseCa (db/tls.ts). Required for a non-local database. */
  ca?: string | null;
}

/**
 * postgres.js options. A non-local database always verifies the server's
 * certificate chain and host name against `ca`; the explicit `ssl` option
 * overrides any `sslmode` in the URL, so the URL can't turn verification off.
 */
export function postgresOptions(url: string, ca: string | null): NonNullable<Parameters<typeof postgres>[1]> {
  const base = { max: 10, idle_timeout: 20, connect_timeout: 10, onnotice: () => undefined };
  if (isLocalDatabase(url)) return base;
  if (!ca) throw new DatabaseTlsError("Refusing to connect: a remote database requires VERITY_DB_CA_PATH (certificate verification)");
  return { ...base, ssl: { ca, rejectUnauthorized: true } };
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
 *
 * A non-local Postgres needs `options.ca`, the CA bundle validated by the
 * configuration (db/tls.ts); without it this refuses before connecting.
 */
export function createDatabase(url: string, options: DatabaseOptions = {}): DatabaseHandle {
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

  const sql = postgres(url, postgresOptions(url, options.ca ?? null));
  const db = drizzlePostgres(sql, { schema }) as unknown as Database;
  return {
    db,
    kind: "postgres",
    migrate: () => migratePostgres(db as never, { migrationsFolder: migrationsFolder() }),
    close: () => sql.end({ timeout: 5 }),
  };
}
