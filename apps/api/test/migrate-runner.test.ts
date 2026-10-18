import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config";
import { loadMigrationTimeouts, MIGRATION_TIMEOUT_DEFAULTS, parseShownDuration, runMigrations, timeoutsInEffect } from "../src/db/migrate-runner";

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
