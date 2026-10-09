import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config";
import { loadWorkerConfig } from "../src/worker/config";
import { caFixture } from "./ca-fixture";

const KEY = "nimble-test-key-0123456789abcdef";
const DB = "postgres://verity:db-password@db.internal:5432/verity?sslmode=require";

// The worker needs only the database and Nimble: no session secret, SMTP or origins.
// A remote database needs the explicit acknowledgement naming its host (db/target-guard.ts)
// and a CA that verifies its certificate (db/tls.ts).
const ca = caFixture();
afterAll(() => ca.cleanup());
const goodProduction = { NODE_ENV: "production", DATABASE_URL: DB, NIMBLE_API_KEY: KEY, VERITY_DATABASE_ACK: "db.internal", VERITY_DB_CA_PATH: ca.valid };

function errorMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected a ConfigError");
}

describe("verification worker configuration", () => {
  it("accepts a minimal production configuration with conservative defaults", () => {
    const config = loadWorkerConfig(goodProduction);
    expect(config.nimble).toMatchObject({
      apiKey: KEY,
      baseUrl: "https://sdk.nimbleway.com",
      maxSearchesPerJob: 3,
      dailySearchBudget: 200,
      dailyAgentBudget: 20,
      agentEffort: "low",
      agentConflictEffort: "low",
      agentEventCooldownHours: 6,
      agentMaxPerEvent: 2,
      agentPollTimeoutSeconds: 90,
    });
    expect(config).toMatchObject({ concurrency: 2, pollIntervalMs: 5_000, leaseSeconds: 600 });
  });

  it.each([
    ["missing NIMBLE_API_KEY", { NIMBLE_API_KEY: "" }],
    ["embedded database", { DATABASE_URL: "pglite:.data" }],
    ["remote database without a CA", { VERITY_DB_CA_PATH: "" }],
    ["missing DATABASE_URL", { DATABASE_URL: "" }],
    ["http Nimble URL", { NIMBLE_BASE_URL: "http://sdk.nimbleway.com" }],
    ["unknown Nimble host", { NIMBLE_BASE_URL: "https://nimble.attacker.example" }],
    ["look-alike Nimble host", { NIMBLE_BASE_URL: "https://sdk.nimbleway.com.attacker.example" }],
    ["credentials in the Nimble URL", { NIMBLE_BASE_URL: "https://user:pw@sdk.nimbleway.com" }],
    ["local Nimble stand-in", { NIMBLE_BASE_URL: "http://127.0.0.1:9999" }],
    ["high agent effort", { NIMBLE_AGENT_CONFLICT_EFFORT: "high" }],
    ["lease shorter than the agent poll", { VERIFICATION_LEASE_SECONDS: "180", NIMBLE_AGENT_POLL_TIMEOUT_SECONDS: "120" }],
    ["out-of-range concurrency", { VERIFICATION_WORKER_CONCURRENCY: "50" }],
  ])("refuses production with %s", (_label, override) => {
    expect(() => loadWorkerConfig({ ...goodProduction, ...override })).toThrow(ConfigError);
  });

  it("allows medium effort for conflicts only when explicitly configured", () => {
    const config = loadWorkerConfig({ ...goodProduction, NIMBLE_AGENT_CONFLICT_EFFORT: "medium" });
    expect(config.nimble.agentEffort).toBe("low");
    expect(config.nimble.agentConflictEffort).toBe("medium");
  });

  it("runs in development without a key (retrieval unavailable) and allows a local Nimble stand-in", () => {
    const config = loadWorkerConfig({ NODE_ENV: "development", NIMBLE_BASE_URL: "http://127.0.0.1:9999" });
    expect(config.nimble.apiKey).toBeNull();
    expect(config.nimble.baseUrl).toBe("http://127.0.0.1:9999");
    expect(config.databaseUrl).toBe("pglite:.data/pglite");
  });

  it("never echoes secret values in errors", () => {
    const message = errorMessage(() =>
      loadWorkerConfig({ ...goodProduction, NIMBLE_BASE_URL: "https://user:pw@nimble.attacker.example" }),
    );
    expect(message).toContain("NIMBLE_BASE_URL");
    for (const secret of [KEY, "db-password", "pw@", "attacker"]) expect(message).not.toContain(secret);
  });

  it("redacts the key and database URL when serialized", () => {
    const serialized = JSON.stringify(loadWorkerConfig(goodProduction));
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain("db-password");
    expect(serialized).toContain("[redacted]");
  });

  it("does not require API-only settings, and the API does not require the Nimble key", () => {
    expect(() => loadWorkerConfig(goodProduction)).not.toThrow();
    const api = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: DB,
      VERITY_DB_CA_PATH: ca.valid,
      SESSION_SECRET: "a".repeat(48),
      VERITY_PUBLIC_URL: "https://api.verity.example",
      VERITY_ALLOWED_ORIGINS: "https://verity-app.maypop.example",
      SMTP_URL: "smtps://user:pass@smtp.example.com:465",
      AUTH_EMAIL_FROM: "Verity <no-reply@verity.example>",
    });
    expect(api).not.toHaveProperty("nimble");
  });
});
