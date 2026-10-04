import { describe, expect, it } from "vitest";
import { databaseTargetProblems, isLocalDatabase } from "../src/db/target-guard";
import { loadWorkerConfig } from "../src/worker/config";

/**
 * Development commands must not casually operate on a remote (production)
 * database, even when apps/api/.env points at one.
 */

const REMOTE = "postgres://user:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require";
const LOCAL = "postgres://postgres@127.0.0.1:55432/verity_test";

describe("database target guard", () => {
  it("treats PGlite and loopback Postgres as local, everything else as remote", () => {
    for (const url of ["pglite:memory", "pglite:.data/pglite", LOCAL, "postgres://u@localhost/x", "postgresql://u@[::1]:5432/x"]) expect(isLocalDatabase(url)).toBe(true);
    for (const url of [REMOTE, "postgres://u@db.internal/x", "postgres://u@10.0.0.5/x"]) expect(isLocalDatabase(url)).toBe(false);
  });

  it("allows every development command on a local database", () => {
    for (const purpose of ["worker", "migrate", "seed"] as const) expect(databaseTargetProblems(purpose, LOCAL, {})).toEqual([]);
  });

  it("refuses a development worker on a remote database, even with the acknowledgement", () => {
    expect(databaseTargetProblems("worker", REMOTE, {})).toHaveLength(2);
    expect(databaseTargetProblems("worker", REMOTE, { VERITY_DATABASE_ACK: "aws-0-us-east-1.pooler.supabase.com" })).toHaveLength(1);
    expect(databaseTargetProblems("worker", REMOTE, { NODE_ENV: "production", VERITY_DATABASE_ACK: "aws-0-us-east-1.pooler.supabase.com" })).toEqual([]);
  });

  it("migrates a remote database only with an acknowledgement naming exactly its host", () => {
    expect(databaseTargetProblems("migrate", REMOTE, {})).toHaveLength(1);
    expect(databaseTargetProblems("migrate", REMOTE, { VERITY_DATABASE_ACK: "yes" })).toHaveLength(1);
    expect(databaseTargetProblems("migrate", REMOTE, { VERITY_DATABASE_ACK: "other.pooler.supabase.com" })).toHaveLength(1);
    expect(databaseTargetProblems("migrate", REMOTE, { VERITY_DATABASE_ACK: "AWS-0-us-east-1.pooler.supabase.com" })).toEqual([]);
  });

  it("never seeds a remote database", () => {
    expect(databaseTargetProblems("seed", REMOTE, { NODE_ENV: "production", VERITY_DATABASE_ACK: "aws-0-us-east-1.pooler.supabase.com" })).toHaveLength(1);
  });

  it("never echoes the database URL or its credentials", () => {
    const text = databaseTargetProblems("worker", REMOTE, {}).join(" ");
    expect(text).not.toMatch(/secret|user:|supabase\.com/);
  });

  it("is enforced by the worker configuration", () => {
    expect(() => loadWorkerConfig({ DATABASE_URL: REMOTE, NIMBLE_API_KEY: "k" })).toThrow(/NODE_ENV=production/);
    expect(() => loadWorkerConfig({ DATABASE_URL: LOCAL })).not.toThrow();
  });
});
