import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config";
import {
  classifyMigrationFailure,
  failureCodes,
  loadMigrationTimeouts,
  MIGRATION_EXIT_CODES,
  MIGRATION_TIMEOUT_DEFAULTS,
  MigrationGateError,
  parseShownDuration,
  runMigrations,
  timeoutsInEffect,
} from "../src/db/migrate-runner";
import { DatabaseTlsError } from "../src/db/tls";

// A connection string a driver message might embed. None of it may ever be printed.
const SECRET_URL = "postgres://admin:hunter2-secret@db.prod.example.com:6543/verity";
const SECRET_PARTS = ["hunter2", "admin", "db.prod.example.com", "postgres://", "6543", "10.0.0.5"];

/** A server error as postgres.js raises it (name PostgresError, a severity, a SQLSTATE) with a revealing message. */
const serverError = (code: string, severity = "ERROR") =>
  Object.assign(new Error(`server said something about ${SECRET_URL} for user "admin"`), { name: "PostgresError", code, severity });
/** Drizzle wraps query failures; the driver error is the cause. */
const wrapped = (cause: unknown) => new Error(`Failed query: insert into t ... (${SECRET_URL})`, { cause });
/** A Node or postgres.js transport error: a code name, no severity. */
const transportError = (code: string) => Object.assign(new Error(`write ${code} 10.0.0.5:5432 ${SECRET_URL}`), { code });

describe("migration failure classification", () => {
  it("uses one exit code per outcome", () => {
    expect(MIGRATION_EXIT_CODES).toEqual({ refused: 2, not_attempted: 3, rolled_back: 4, uncertain: 5 });
  });

  it("refused: the timeout safety check failed; nothing attempted", () => {
    const r = classifyMigrationFailure(new MigrationGateError("x"), { started: false });
    expect(r).toEqual({
      outcome: "refused",
      exitCode: 2,
      code: null,
      message:
        "Migration refused: safety check failed (the connection did not keep the requested lock_timeout/statement_timeout). Nothing was applied. Use a direct or session-mode connection, then run again.",
    });
  });

  it.each([
    ["invalid configuration", new ConfigError(`Invalid environment: DATABASE_URL (${SECRET_URL})`)],
    ["missing CA", new DatabaseTlsError(`Refusing to connect ${SECRET_URL}`)],
  ])("refused: %s; nothing attempted", (_label, error) => {
    expect(classifyMigrationFailure(error, { started: false })).toEqual({
      outcome: "refused",
      exitCode: 2,
      code: null,
      message: "Migration refused: invalid or incomplete database configuration. Nothing was applied. Fix the configuration, then run again.",
    });
  });

  it.each([
    ["authentication failed", serverError("28P01", "FATAL"), "SQLSTATE 28P01"],
    ["role not permitted", serverError("28000", "FATAL"), "SQLSTATE 28000"],
    ["database missing", serverError("3D000", "FATAL"), "SQLSTATE 3D000"],
    ["connection refused", transportError("ECONNREFUSED"), "ECONNREFUSED"],
    ["TLS verification at connect", transportError("UNABLE_TO_VERIFY_LEAF_SIGNATURE"), "UNABLE_TO_VERIFY_LEAF_SIGNATURE"],
    ["connect timeout", transportError("CONNECT_TIMEOUT"), "CONNECT_TIMEOUT"],
  ])("not attempted: %s before migrations started", (_label, error, shown) => {
    const r = classifyMigrationFailure(error, { started: false });
    expect(r.outcome).toBe("not_attempted");
    expect(r.exitCode).toBe(3);
    expect(r.message).toBe(
      `Migration not attempted: could not connect to or authenticate with the database (${shown}). Nothing was applied. Check the connection settings, then run again.`,
    );
  });

  it.each(["55P03", "57014", "23505", "42601", "42P07", "40P01", "XX000"])("rolled back: the server returned SQLSTATE %s inside the migration transaction", (code) => {
    const r = classifyMigrationFailure(wrapped(serverError(code)), { started: true });
    expect(r).toEqual({
      outcome: "rolled_back",
      exitCode: 4,
      code,
      message: `Migration failed: the server rejected a statement (SQLSTATE ${code}). PostgreSQL rolled back the migration transaction; nothing from it was applied. Resolve the cause (for 55P03 or 57014, wait until the blocking session is gone), then run again.`,
    });
  });

  it.each([
    ["connection reset", transportError("ECONNRESET"), "ECONNRESET"],
    ["broken pipe (a 5-letter Node code is not a SQLSTATE)", transportError("EPIPE"), "EPIPE"],
    ["postgres.js connection ended", transportError("CONNECTION_ENDED"), "CONNECTION_ENDED"],
    ["postgres.js connection destroyed", transportError("CONNECTION_DESTROYED"), "CONNECTION_DESTROYED"],
    ["postgres.js connection closed", transportError("CONNECTION_CLOSED"), "CONNECTION_CLOSED"],
    ["TLS failure mid-run", transportError("ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC"), "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC"],
    ["timeout waiting for the server", transportError("ETIMEDOUT"), "ETIMEDOUT"],
    ["administrator shutdown", serverError("57P01", "FATAL"), "SQLSTATE 57P01"],
    ["crash shutdown", serverError("57P02", "FATAL"), "SQLSTATE 57P02"],
    ["connection exception", serverError("08006", "FATAL"), "SQLSTATE 08006"],
    ["no error code at all", new Error(`socket hang up ${SECRET_URL}`), "no error code"],
  ])("uncertain: %s once migrations started", (_label, error, shown) => {
    const r = classifyMigrationFailure(wrapped(error), { started: true });
    expect(r.outcome).toBe("uncertain");
    expect(r.exitCode).toBe(5);
    expect(r.message).toBe(
      `Migration outcome UNKNOWN: the connection failed while migrations were running (${shown}). Do not retry yet. Confirm the previous migration session has ended (pg_stat_activity), then inspect drizzle.__drizzle_migrations and the schema to see whether the migration was applied before deciding to run again.`,
    );
  });

  it("never prints a URL, host, user, password or driver message, whatever the error says", () => {
    const errors: Array<[unknown, boolean]> = [
      [new MigrationGateError(SECRET_URL), false],
      [new ConfigError(SECRET_URL), false],
      [serverError("28P01", "FATAL"), false],
      [wrapped(serverError("55P03")), true],
      [wrapped(transportError("ECONNRESET")), true],
      [new Error(SECRET_URL), true],
      // A hostile "code" is never echoed: only SQLSTATEs and code-like names are.
      [Object.assign(new Error("x"), { code: SECRET_URL }), true],
      [Object.assign(new Error("x"), { code: "admin:hunter2" }), false],
    ];
    for (const [error, started] of errors) {
      const { message, code } = classifyMigrationFailure(error, { started });
      for (const part of SECRET_PARTS) {
        expect(message, message).not.toContain(part);
        expect(String(code)).not.toContain(part);
      }
    }
  });

  it("finds codes through the cause chain and tells SQLSTATEs from Node codes", () => {
    expect(failureCodes(wrapped(serverError("55P03")))).toEqual({ sqlstate: "55P03", codeName: null });
    expect(failureCodes(transportError("EPIPE"))).toEqual({ sqlstate: null, codeName: "EPIPE" });
    expect(failureCodes(new Error("x"))).toEqual({ sqlstate: null, codeName: null });
  });
});

describe("migration timeouts (db:migrate only)", () => {
  it("defaults to a 5 s lock timeout and a 60 s statement timeout; blank means the default", () => {
    expect(MIGRATION_TIMEOUT_DEFAULTS).toEqual({ lockTimeoutMs: 5_000, statementTimeoutMs: 60_000 });
    expect(loadMigrationTimeouts({})).toEqual(MIGRATION_TIMEOUT_DEFAULTS);
    expect(loadMigrationTimeouts({ MIGRATE_LOCK_TIMEOUT_MS: "", MIGRATE_STATEMENT_TIMEOUT_MS: "  " })).toEqual(MIGRATION_TIMEOUT_DEFAULTS);
  });

  it("accepts explicit values within bounds", () => {
    expect(loadMigrationTimeouts({ MIGRATE_LOCK_TIMEOUT_MS: "100", MIGRATE_STATEMENT_TIMEOUT_MS: "3600000" })).toEqual({ lockTimeoutMs: 100, statementTimeoutMs: 3_600_000 });
    expect(loadMigrationTimeouts({ MIGRATE_LOCK_TIMEOUT_MS: "600000", MIGRATE_STATEMENT_TIMEOUT_MS: "1000" })).toEqual({ lockTimeoutMs: 600_000, statementTimeoutMs: 1_000 });
  });

  it.each([
    ["MIGRATE_LOCK_TIMEOUT_MS", "0"], // 0 would mean "no limit"
    ["MIGRATE_LOCK_TIMEOUT_MS", "99"],
    ["MIGRATE_LOCK_TIMEOUT_MS", "600001"],
    ["MIGRATE_LOCK_TIMEOUT_MS", "5s"],
    ["MIGRATE_STATEMENT_TIMEOUT_MS", "0"],
    ["MIGRATE_STATEMENT_TIMEOUT_MS", "999"],
    ["MIGRATE_STATEMENT_TIMEOUT_MS", "3600001"],
    ["MIGRATE_STATEMENT_TIMEOUT_MS", "1500.5"],
    ["MIGRATE_STATEMENT_TIMEOUT_MS", "-1"],
  ])("refuses %s=%s, naming the variable but not the value", (name, value) => {
    try {
      loadMigrationTimeouts({ [name]: value });
      throw new Error("accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain(name);
      expect((error as Error).message).not.toContain(`=${value}`);
    }
  });

  it("reads durations the way SHOW prints them", () => {
    expect(parseShownDuration("5s")).toBe(5_000);
    expect(parseShownDuration("1min")).toBe(60_000);
    expect(parseShownDuration("250ms")).toBe(250);
    expect(parseShownDuration("1h")).toBe(3_600_000);
    expect(parseShownDuration("0")).toBe(0);
    expect(parseShownDuration("1500")).toBe(1_500);
    expect(parseShownDuration("five seconds")).toBeNull();
  });

  it("refuses unless the server reports exactly the requested bounds", () => {
    const wanted = { lockTimeoutMs: 5_000, statementTimeoutMs: 60_000 };
    expect(timeoutsInEffect({ lockTimeout: "5s", statementTimeout: "1min" }, wanted)).toBe(true);
    // E.g. a transaction-mode pooler that dropped the startup parameters: the server default "0" (no limit).
    expect(timeoutsInEffect({ lockTimeout: "0", statementTimeout: "1min" }, wanted)).toBe(false);
    expect(timeoutsInEffect({ lockTimeout: "5s", statementTimeout: "0" }, wanted)).toBe(false);
    expect(timeoutsInEffect({ lockTimeout: "2s", statementTimeout: "2min" }, wanted)).toBe(false);
    expect(timeoutsInEffect({ lockTimeout: "", statementTimeout: "garbage" }, wanted)).toBe(false);
  });

  it("migrates an embedded (PGlite) database without timeouts", async () => {
    const messages: string[] = [];
    expect(await runMigrations({ url: "pglite:memory", ca: null, timeouts: MIGRATION_TIMEOUT_DEFAULTS, log: (m) => messages.push(m) })).toEqual({ lockTimeout: null, statementTimeout: null });
    expect(messages).toEqual(["Embedded database: migration timeouts not applicable."]);
  });
});
