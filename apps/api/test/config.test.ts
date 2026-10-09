import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config";
import { caFixture } from "./ca-fixture";

const ca = caFixture();
afterAll(() => ca.cleanup());

const goodProduction = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://verity:secret@db.internal:5432/verity",
  VERITY_DB_CA_PATH: ca.valid,
  SESSION_SECRET: "a".repeat(48),
  VERITY_PUBLIC_URL: "https://api.verity.example",
  VERITY_ALLOWED_ORIGINS: "https://verity-app.maypop.example",
  SMTP_URL: "smtps://user:pass@smtp.example.com:465",
  AUTH_EMAIL_FROM: "Verity <no-reply@verity.example>",
};

describe("configuration", () => {
  it("accepts a complete, secure production configuration", () => {
    const config = loadConfig(goodProduction);
    expect(config.allowedOrigins).toEqual(["https://verity-app.maypop.example"]);
    expect(config.email.transport).toBe("smtp");
  });

  it.each([
    ["missing DATABASE_URL", { DATABASE_URL: "" }],
    ["embedded database", { DATABASE_URL: "pglite:.data" }],
    ["remote database without a CA", { VERITY_DB_CA_PATH: "" }],
    ["short session secret", { SESSION_SECRET: "short" }],
    ["missing allowed origins", { VERITY_ALLOWED_ORIGINS: "" }],
    ["wildcard origin", { VERITY_ALLOWED_ORIGINS: "https://*.maypop.example" }],
    ["http origin", { VERITY_ALLOWED_ORIGINS: "http://verity.example" }],
    ["origin with a path", { VERITY_ALLOWED_ORIGINS: "https://verity.example/app" }],
    ["http public URL", { VERITY_PUBLIC_URL: "http://api.verity.example" }],
    ["dev email outbox", { AUTH_EMAIL_TRANSPORT: "dev-outbox" }],
    ["missing SMTP_URL", { SMTP_URL: "" }],
    ["short internal token", { INTERNAL_API_TOKEN: "abc" }],
  ])("refuses production with %s", (_label, override) => {
    expect(() => loadConfig({ ...goodProduction, ...override })).toThrow(ConfigError);
  });

  it("does not echo secret values in errors", () => {
    try {
      loadConfig({ ...goodProduction, SESSION_SECRET: "tiny-secret-value" });
    } catch (error) {
      expect(String(error)).not.toContain("tiny-secret-value");
    }
  });

  it("treats empty variables as unset", () => {
    const config = loadConfig({ NODE_ENV: "development", PORT: "", AUTH_EMAIL_TRANSPORT: "", LOG_LEVEL: "", DATABASE_URL: "" });
    expect(config.port).toBe(8787);
    expect(config.email.transport).toBe("dev-outbox");
  });

  it("uses safe local defaults in development", () => {
    const config = loadConfig({ NODE_ENV: "development" });
    expect(config.databaseUrl.startsWith("pglite:")).toBe(true);
    expect(config.email.transport).toBe("dev-outbox");
    expect(config.allowedOrigins).toContain("http://localhost:5173");
    expect(config.host).toBe("127.0.0.1");
  });
});
