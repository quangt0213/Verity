import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, loadDatabaseConfig } from "../src/config";
import { createDatabase, postgresOptions } from "../src/db/client";
import { DatabaseTlsError, resolveDatabaseCa } from "../src/db/tls";
import { loadWorkerConfig } from "../src/worker/config";
import { caFixture } from "./ca-fixture";

// ".invalid" never resolves, so nothing here can reach a real server.
const HOST = "db.verity.invalid";
const PASSWORD = "db-secret-pass-0123";
const REMOTE = `postgres://verity:${PASSWORD}@${HOST}:5432/verity?sslmode=require`;
const LOCALS = ["pglite:memory", "postgres://postgres@127.0.0.1:55432/verity", "postgres://u@localhost/x", "postgresql://u@[::1]:5432/x"];

const ca = caFixture();
const notPem = ca.write("not-pem.pem", "this is not a certificate\n");
const empty = ca.write("empty.pem", "");
const corrupt = ca.write("corrupt.pem", "-----BEGIN CERTIFICATE-----\nAAAAnot-a-real-certificate\n-----END CERTIFICATE-----\n");
// A key marker is enough: the file is refused before anything is parsed.
const withKey = ca.write("with-key.pem", `${ca.bundle}-----BEGIN ${"PRIVATE"} KEY-----\nAAAA\n-----END ${"PRIVATE"} KEY-----\n`);
const missing = join(ca.dir, "missing.pem");
afterAll(() => ca.cleanup());

function problemsFor(url: string, caPath: string | undefined) {
  const problems: string[] = [];
  const result = resolveDatabaseCa(url, caPath, problems);
  return { result, problems };
}

function configError(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected a ConfigError");
}

const invalidCaFiles: Array<[string, string, RegExp]> = [
  ["a missing file", missing, /VERITY_DB_CA_PATH could not be read/],
  ["an empty file", empty, /does not contain a PEM certificate/],
  ["a file that isn't PEM", notPem, /does not contain a PEM certificate/],
  ["a corrupt certificate", corrupt, /cannot be parsed/],
  ["a file with a private key", withKey, /never a private key/],
];

describe("database CA resolution (db/tls.ts)", () => {
  it("needs no CA for a local database", () => {
    for (const url of LOCALS) expect(problemsFor(url, undefined)).toEqual({ result: null, problems: [] });
  });

  it.each([undefined, "", "   "])("requires VERITY_DB_CA_PATH for a remote database (%j)", (caPath) => {
    const { result, problems } = problemsFor(REMOTE, caPath);
    expect(result).toBeNull();
    expect(problems).toEqual([expect.stringMatching(/VERITY_DB_CA_PATH is required for a remote database/)]);
  });

  it.each(invalidCaFiles)("refuses %s, without echoing the path", (_label, path, message) => {
    const { result, problems } = problemsFor(REMOTE, path);
    expect(result).toBeNull();
    expect(problems).toEqual([expect.stringMatching(message)]);
    expect(problems.join()).not.toContain(ca.dir);
  });

  it("returns every certificate of a valid bundle", () => {
    const { result, problems } = problemsFor(REMOTE, ca.valid);
    expect(problems).toEqual([]);
    expect(result?.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
  });
});

describe("postgres connection options (db/client.ts)", () => {
  it("refuses a remote database without a CA, before connecting", () => {
    expect(() => postgresOptions(REMOTE, null)).toThrow(DatabaseTlsError);
    expect(() => createDatabase(REMOTE)).toThrow(DatabaseTlsError);
    expect(() => createDatabase(REMOTE, { ca: "" })).toThrow(DatabaseTlsError);
    try {
      createDatabase(REMOTE);
    } catch (error) {
      expect(String(error)).not.toContain(PASSWORD);
      expect(String(error)).not.toContain(HOST);
    }
  });

  it("verifies the certificate chain and host name of a remote database", () => {
    expect(postgresOptions(REMOTE, ca.bundle).ssl).toEqual({ ca: ca.bundle, rejectUnauthorized: true });
  });

  // postgres.js reads sslmode from the URL; "require" means encrypt WITHOUT verifying.
  // The explicit ssl option must win over every sslmode, including one that disables TLS.
  it.each(["require", "prefer", "allow", "disable", "verify-full"])("can't be weakened by sslmode=%s in the URL", async (mode) => {
    const url = `postgres://verity:${PASSWORD}@${HOST}:5432/verity?sslmode=${mode}`;
    const sql = postgres(url, postgresOptions(url, ca.bundle));
    try {
      expect(sql.options.ssl).toEqual({ ca: ca.bundle, rejectUnauthorized: true });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("creates a remote handle with a CA without connecting", async () => {
    const database = createDatabase(REMOTE, { ca: ca.bundle });
    expect(database.kind).toBe("postgres");
    await database.close();
  });

  it("leaves a local Postgres as its URL configures it", () => {
    expect(postgresOptions("postgres://postgres@127.0.0.1:55432/verity", null)).not.toHaveProperty("ssl");
  });
});

describe("every configuration requires a verified CA for a remote database", () => {
  it.each(["development", "test", "production"])("migrations (loadDatabaseConfig) with NODE_ENV=%s", (NODE_ENV) => {
    expect(configError(() => loadDatabaseConfig({ NODE_ENV, DATABASE_URL: REMOTE }))).toMatch(/VERITY_DB_CA_PATH is required/);
    expect(loadDatabaseConfig({ NODE_ENV, DATABASE_URL: REMOTE, VERITY_DB_CA_PATH: ca.valid }).databaseCa).toContain("BEGIN CERTIFICATE");
  });

  it.each(invalidCaFiles)("migrations refuse %s without leaking the URL", (_label, path, message) => {
    const error = configError(() => loadDatabaseConfig({ NODE_ENV: "production", DATABASE_URL: REMOTE, VERITY_DB_CA_PATH: path }));
    expect(error).toMatch(message);
    expect(error).not.toContain(PASSWORD);
    expect(error).not.toContain(ca.dir);
  });

  it("migrations in production need only the database settings, not the API's secrets", () => {
    const config = loadDatabaseConfig({ NODE_ENV: "production", DATABASE_URL: REMOTE, VERITY_DB_CA_PATH: ca.valid });
    expect(config).toMatchObject({ env: "production", databaseUrl: REMOTE });
    expect(loadDatabaseConfig({ NODE_ENV: "development" })).toEqual({ env: "development", databaseUrl: "pglite:.data/pglite", databaseCa: null });
  });

  it.each(["development", "production"])("the API with NODE_ENV=%s", (NODE_ENV) => {
    const production = {
      SESSION_SECRET: "a".repeat(48),
      VERITY_PUBLIC_URL: "https://api.verity.example",
      VERITY_ALLOWED_ORIGINS: "https://app.verity.example",
      SMTP_URL: "smtps://user:pass@smtp.example.com:465",
      AUTH_EMAIL_FROM: "Verity <no-reply@verity.example>",
    };
    const env = { NODE_ENV, DATABASE_URL: REMOTE, ...(NODE_ENV === "production" ? production : {}) };
    expect(configError(() => loadConfig(env))).toMatch(/VERITY_DB_CA_PATH is required/);
    expect(loadConfig({ ...env, VERITY_DB_CA_PATH: ca.valid }).databaseCa).toContain("BEGIN CERTIFICATE");
  });

  it("the worker, and its serialized config doesn't carry the bundle", () => {
    const env = { NODE_ENV: "production", DATABASE_URL: REMOTE, VERITY_DATABASE_ACK: HOST, NIMBLE_API_KEY: "nimble-test-key-0123456789abcdef" };
    expect(configError(() => loadWorkerConfig(env))).toMatch(/VERITY_DB_CA_PATH is required/);
    const config = loadWorkerConfig({ ...env, VERITY_DB_CA_PATH: ca.valid });
    expect(config.databaseCa).toContain("BEGIN CERTIFICATE");
    expect(JSON.stringify(config)).not.toContain("BEGIN CERTIFICATE");
    expect(JSON.parse(JSON.stringify(config)).databaseCa).toBe("[set]");
  });
});

describe("the migration runner (src/scripts/migrate.ts)", () => {
  const apiRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");

  // Runs the real script in a child process with only the variables given (plus PATH/system ones).
  function runMigrate(vars: Record<string, string>) {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]) if (process.env[key]) env[key] = process.env[key];
    return spawnSync(process.execPath, [tsx, "src/scripts/migrate.ts"], { cwd: apiRoot, env: { ...env, ...vars }, encoding: "utf8", timeout: 60_000 });
  }

  it.each([
    ["no CA", "", /VERITY_DB_CA_PATH is required/],
    ["a corrupt CA", corrupt, /cannot be parsed/],
  ])("refuses a remote database with %s, even with the acknowledgement and outside production", (_label, caPath, message) => {
    const run = runMigrate({ NODE_ENV: "development", DATABASE_URL: REMOTE, VERITY_DATABASE_ACK: HOST, VERITY_DB_CA_PATH: caPath });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(message);
    expect(run.stdout).not.toContain("Migrations applied");
    expect(`${run.stdout}${run.stderr}`).not.toContain(PASSWORD);
  });
});
