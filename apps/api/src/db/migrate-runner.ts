import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { z } from "zod";
import { ConfigError, presentEnv } from "../config";
import { createDatabase, migrationsFolder, postgresOptions } from "./client";
import * as schema from "./schema";
import { DatabaseTlsError } from "./tls";

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

/** The safety check refused the connection before any migration SQL ran. */
export class MigrationGateError extends Error {}

/**
 * A failure while connecting or migrating. `started` is true once the
 * migrator was invoked: from then on, migration SQL may have reached the
 * server, so a failure without a server answer has an UNKNOWN outcome.
 */
export class MigrationRunError extends Error {
  constructor(
    readonly started: boolean,
    options: { cause: unknown },
  ) {
    super(started ? "migration failed after it started" : "migration failed before it started", options);
  }
}

/**
 * The migrator's session name, so operators can find it in pg_stat_activity
 * (`WHERE application_name = 'verity-migrate'`). Migrator connection only;
 * the API and worker pools keep the driver default. Informational: a pooler
 * may rewrite it, so a different value is logged, never a reason to refuse.
 */
export const MIGRATOR_APPLICATION_NAME = "verity-migrate";

/** Startup parameters for the migrator's single connection (applied again on any reconnect). */
export function migratorConnectionParameters(timeouts: MigrationTimeouts): { application_name: string; lock_timeout: number; statement_timeout: number } {
  return { application_name: MIGRATOR_APPLICATION_NAME, lock_timeout: timeouts.lockTimeoutMs, statement_timeout: timeouts.statementTimeoutMs };
}

/** A server-reported name, printable only if it looks like a name (anything else is shown as "(other)"). */
export function printableApplicationName(value: string | null | undefined): string {
  return value && /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : "(other)";
}

export interface MigrationResult {
  /** The effective settings as the server reported them (SHOW), or null for an embedded database. */
  lockTimeout: string | null;
  statementTimeout: string | null;
  /** The session's application_name as the server reported it (SHOW), or null for an embedded database. */
  applicationName: string | null;
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
    } catch (error) {
      throw new MigrationRunError(true, { cause: error });
    } finally {
      await database.close();
    }
    log("Embedded database: migration timeouts not applicable.");
    return { lockTimeout: null, statementTimeout: null, applicationName: null };
  }

  // Throws DatabaseTlsError (a configuration refusal) for a remote database without a CA, before connecting.
  const options = postgresOptions(input.url, input.ca);
  const sql = postgres(input.url, {
    ...options,
    max: 1,
    // Startup parameters (timeouts in milliseconds): applied by the server to the session, and again on any reconnect.
    connection: migratorConnectionParameters(input.timeouts),
  });
  let started = false;
  try {
    const [lock] = await sql<Array<{ lock_timeout: string }>>`show lock_timeout`;
    const [statement] = await sql<Array<{ statement_timeout: string }>>`show statement_timeout`;
    const [application] = await sql<Array<{ application_name: string }>>`show application_name`;
    const effective = { lockTimeout: lock!.lock_timeout, statementTimeout: statement!.statement_timeout };
    log(`Migration timeouts in effect: lock_timeout=${effective.lockTimeout} statement_timeout=${effective.statementTimeout}`);
    // Logged only: a pooler may rewrite the name, and it isn't a safety property.
    log(`Migration session application_name=${printableApplicationName(application?.application_name)}`);
    if (!timeoutsInEffect(effective, input.timeouts)) {
      throw new MigrationGateError("the connection did not keep the requested lock_timeout/statement_timeout");
    }
    // From here on migration SQL may reach the server.
    started = true;
    await migrate(drizzle(sql, { schema }) as never, { migrationsFolder: folder });
    return { ...effective, applicationName: application?.application_name ?? null };
  } catch (error) {
    if (error instanceof MigrationGateError) throw error;
    throw new MigrationRunError(started, { cause: error });
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Failure classification (scripts/migrate.ts). Pure; tested in
// test/migrate-runner.test.ts. Messages never include a URL, host, user,
// password or driver message (those can embed connection details): only the
// outcome, a SQLSTATE or a stable error-code name, and the next step.
// ---------------------------------------------------------------------------

export type MigrationOutcome = "refused" | "not_attempted" | "rolled_back" | "uncertain";

/** Process exit codes, one per outcome (0 is success). */
export const MIGRATION_EXIT_CODES: Record<MigrationOutcome, number> = { refused: 2, not_attempted: 3, rolled_back: 4, uncertain: 5 };

export interface MigrationFailure {
  outcome: MigrationOutcome;
  exitCode: number;
  /** SQLSTATE (server errors) or a stable error-code name (driver/network errors), else null. */
  code: string | null;
  message: string;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;
/** A stable error-code name ("ECONNRESET", "CONNECTION_ENDED", OpenSSL names like "ERR_SSL_..."): never free text. */
const CODE_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * SQLSTATEs where the server is ending or dropping the session (connection
 * exceptions, administrator/crash shutdown): if migration SQL was in flight,
 * a COMMIT may or may not have completed.
 */
function sessionLost(sqlstate: string): boolean {
  return sqlstate.startsWith("08") || sqlstate === "57P01" || sqlstate === "57P02" || sqlstate === "57P03";
}

/** The first server SQLSTATE, and else the first stable error-code name, along the error's cause chain. */
export function failureCodes(error: unknown): { sqlstate: string | null; codeName: string | null } {
  let sqlstate: string | null = null;
  let codeName: string | null = null;
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const e = current as { code?: unknown; name?: unknown; severity?: unknown; cause?: unknown };
    if (typeof e.code === "string") {
      // A server error (postgres.js PostgresError) carries a severity; a Node error code like "EPIPE" can also be 5 letters.
      const fromServer = e.name === "PostgresError" || typeof e.severity === "string";
      if (fromServer && SQLSTATE.test(e.code)) sqlstate ??= e.code;
      else if (CODE_NAME.test(e.code)) codeName ??= e.code;
    }
    current = e.cause;
  }
  return { sqlstate, codeName };
}

const failure = (outcome: MigrationOutcome, code: string | null, message: string): MigrationFailure => ({ outcome, exitCode: MIGRATION_EXIT_CODES[outcome], code, message });

export function classifyMigrationFailure(error: unknown, context: { started: boolean }): MigrationFailure {
  if (error instanceof MigrationGateError) {
    return failure(
      "refused",
      null,
      "Migration refused: safety check failed (the connection did not keep the requested lock_timeout/statement_timeout). Nothing was applied. Use a direct or session-mode connection, then run again.",
    );
  }
  if (error instanceof ConfigError || error instanceof DatabaseTlsError) {
    return failure("refused", null, "Migration refused: invalid or incomplete database configuration. Nothing was applied. Fix the configuration, then run again.");
  }
  const { sqlstate, codeName } = failureCodes(error);
  const code = sqlstate ?? codeName;
  const shown = sqlstate ? `SQLSTATE ${sqlstate}` : codeName ?? "no error code";

  if (!context.started) {
    return failure(
      "not_attempted",
      code,
      `Migration not attempted: could not connect to or authenticate with the database (${shown}). Nothing was applied. Check the connection settings, then run again.`,
    );
  }
  if (sqlstate && !sessionLost(sqlstate)) {
    return failure(
      "rolled_back",
      sqlstate,
      `Migration failed: the server rejected a statement (SQLSTATE ${sqlstate}). PostgreSQL rolled back the migration transaction; nothing from it was applied. Resolve the cause (for 55P03 or 57014, wait until the blocking session is gone), then run again.`,
    );
  }
  return failure(
    "uncertain",
    code,
    `Migration outcome UNKNOWN: the connection failed while migrations were running (${shown}). Do not retry yet. Confirm the previous migration session has ended (pg_stat_activity), then inspect drizzle.__drizzle_migrations and the schema to see whether the migration was applied before deciding to run again.`,
  );
}
