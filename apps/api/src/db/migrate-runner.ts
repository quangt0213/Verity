import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { z } from "zod";
import { ConfigError, presentEnv } from "../config";
import { createDatabase, migrationsFolder, postgresOptions } from "./client";
import * as schema from "./schema";

/**
 * The migration gate for `npm run db:migrate` (scripts/migrate.ts) ONLY. The
 * API/worker pools and MIGRATE_ON_START are untouched.
 *
 * Migrations run on ONE connection with bounded lock_timeout and
 * statement_timeout, set as connection startup parameters (so they also hold
 * after a reconnect). Postgres keeps session settings across transactions, so
 * they cover the migrator's transaction. They are read back with SHOW on that
 * same connection and the run is refused if they differ (e.g. a pooler that
 * drops startup parameters). A lock wait or statement beyond its bound fails
 * the migration transaction, which rolls back completely.
 *
 *   MIGRATE_LOCK_TIMEOUT_MS       100..600000, default 5000
 *   MIGRATE_STATEMENT_TIMEOUT_MS  1000..3600000, default 60000
 *
 * 0 (Postgres' "no limit") is deliberately not allowed.
 */

export interface MigrationTimeouts {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

export const MIGRATION_TIMEOUT_DEFAULTS: MigrationTimeouts = { lockTimeoutMs: 5_000, statementTimeoutMs: 60_000 };

const timeoutsSchema = z.object({
  MIGRATE_LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(MIGRATION_TIMEOUT_DEFAULTS.lockTimeoutMs),
  MIGRATE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(MIGRATION_TIMEOUT_DEFAULTS.statementTimeoutMs),
});

/** Missing or blank means the default; anything else must be an integer in range. Errors name the variable, never a value. */
export function loadMigrationTimeouts(env: NodeJS.ProcessEnv = process.env): MigrationTimeouts {
  const parsed = timeoutsSchema.safeParse(presentEnv(env));
  if (!parsed.success) throw new ConfigError(`Invalid environment: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  return { lockTimeoutMs: parsed.data.MIGRATE_LOCK_TIMEOUT_MS, statementTimeoutMs: parsed.data.MIGRATE_STATEMENT_TIMEOUT_MS };
}

const UNIT_MS: Record<string, number> = { us: 0.001, ms: 1, s: 1_000, min: 60_000, h: 3_600_000, d: 86_400_000 };

/** A duration as SHOW prints it ("5s", "1min", "250ms", "0") in milliseconds, or null if unreadable. */
export function parseShownDuration(value: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?\s*$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * UNIT_MS[m[2] ?? "ms"]!;
}

/** The values SHOW reported are exactly the requested bounds (anything unreadable, missing or different: no). */
export function timeoutsInEffect(shown: { lockTimeout: string; statementTimeout: string }, wanted: MigrationTimeouts): boolean {
  return parseShownDuration(shown.lockTimeout) === wanted.lockTimeoutMs && parseShownDuration(shown.statementTimeout) === wanted.statementTimeoutMs;
}

export class MigrationGateError extends Error {}

export interface MigrationResult {
  /** The effective settings as the server reported them (SHOW), or null for an embedded database. */
  lockTimeout: string | null;
  statementTimeout: string | null;
}

export async function runMigrations(input: {
  url: string;
  ca: string | null;
  timeouts: MigrationTimeouts;
  /** Defaults to the release's migrations folder. */
  migrationsFolder?: string;
  log?: (message: string) => void;
}): Promise<MigrationResult> {
  const log = input.log ?? (() => undefined);
  const folder = input.migrationsFolder ?? migrationsFolder();
  if (input.url.startsWith("pglite:")) {
    // Embedded, single-user development database: no other sessions, no lock waits.
    const database = createDatabase(input.url);
    try {
      await database.migrate();
    } finally {
      await database.close();
    }
    log("Embedded database: migration timeouts not applicable.");
    return { lockTimeout: null, statementTimeout: null };
  }

  const { lockTimeoutMs, statementTimeoutMs } = input.timeouts;
  const sql = postgres(input.url, {
    ...postgresOptions(input.url, input.ca),
    max: 1,
    // Startup parameters (milliseconds): applied by the server to the session, and again on any reconnect.
    connection: { lock_timeout: lockTimeoutMs, statement_timeout: statementTimeoutMs },
  });
  try {
    const [lock] = await sql<Array<{ lock_timeout: string }>>`show lock_timeout`;
    const [statement] = await sql<Array<{ statement_timeout: string }>>`show statement_timeout`;
    const effective = { lockTimeout: lock!.lock_timeout, statementTimeout: statement!.statement_timeout };
    log(`Migration timeouts in effect: lock_timeout=${effective.lockTimeout} statement_timeout=${effective.statementTimeout}`);
    if (!timeoutsInEffect(effective, input.timeouts)) {
      throw new MigrationGateError(
        "Refusing to migrate: the connection did not keep the requested lock_timeout/statement_timeout (use a direct or session-mode connection, not a transaction-mode pooler)",
      );
    }
    await migrate(drizzle(sql, { schema }) as never, { migrationsFolder: folder });
    return effective;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
