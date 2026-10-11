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

  describe("resend email transport", () => {
    const resendProduction = {
      ...goodProduction,
      SMTP_URL: "",
      AUTH_EMAIL_TRANSPORT: "resend",
      RESEND_API_KEY: `re_test_${"k".repeat(24)}`,
      AUTH_EMAIL_FROM: "Verity <login@veritylive.app>",
    };

    it("accepts a complete production configuration without SMTP", () => {
      const config = loadConfig(resendProduction);
      expect(config.email).toMatchObject({ transport: "resend", from: "Verity <login@veritylive.app>", resendApiKey: resendProduction.RESEND_API_KEY });
    });

    it("keeps smtp as the production default", () => {
      expect(loadConfig({ ...goodProduction, RESEND_API_KEY: resendProduction.RESEND_API_KEY }).email.transport).toBe("smtp");
    });

    it.each([
      ["a missing key", { RESEND_API_KEY: "" }, "RESEND_API_KEY is required"],
      ["a placeholder key", { RESEND_API_KEY: "re_123456789" }, "RESEND_API_KEY is not a valid Resend API key"],
      ["a key from another provider", { RESEND_API_KEY: `sk_live_${"k".repeat(24)}` }, "RESEND_API_KEY is not a valid Resend API key"],
      ["a key with stray whitespace", { RESEND_API_KEY: `re_test_${"k".repeat(24)}\n` }, "RESEND_API_KEY is not a valid Resend API key"],
      ["a missing sender", { AUTH_EMAIL_FROM: "" }, "AUTH_EMAIL_FROM is required"],
      ["a sender without an address", { AUTH_EMAIL_FROM: "Verity" }, "AUTH_EMAIL_FROM must be an address"],
      ["a sender with a broken address", { AUTH_EMAIL_FROM: "Verity <login@veritylive>" }, "AUTH_EMAIL_FROM must be an address"],
    ])("refuses %s", (_label, override, problem) => {
      expect(() => loadConfig({ ...resendProduction, ...override })).toThrow(problem);
    });

    it("requires a valid key outside production too", () => {
      expect(() => loadConfig({ NODE_ENV: "development", AUTH_EMAIL_TRANSPORT: "resend" })).toThrow("RESEND_API_KEY is required");
    });

    it("does not echo the key in errors", () => {
      const almostKey = "re_secret value with spaces";
      expect(() => loadConfig({ ...resendProduction, RESEND_API_KEY: almostKey })).toThrow(ConfigError);
      try {
        loadConfig({ ...resendProduction, RESEND_API_KEY: almostKey });
      } catch (error) {
        expect(String(error)).not.toContain(almostKey);
      }
    });

    it.each(["Verity <login@veritylive.app>", "login@veritylive.app", "Verity Live <login@mail.veritylive.app>"])("accepts the sender %s", (from) => {
      expect(loadConfig({ ...resendProduction, AUTH_EMAIL_FROM: from }).email.from).toBe(from);
    });
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
