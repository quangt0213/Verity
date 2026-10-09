import { z } from "zod";
import { resolveDatabaseCa } from "./db/tls";

/**
 * Service configuration from environment variables, validated at startup.
 * Production refuses to start with insecure or missing settings rather than
 * falling back to development defaults.
 */

const DEV_SESSION_SECRET = "dev-only-insecure-session-secret-change-me-0000";

function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** An exact web origin: scheme + host (+ port), no path, no wildcard. */
export function isExactOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value && !value.includes("*");
  } catch {
    return false;
  }
}

export type TrustProxy = boolean | string[] | ((address: string, hop: number) => boolean);

/** "false" | "true" | hop count ("1") | comma-separated proxy addresses/CIDRs. */
function parseTrustProxy(raw: string | undefined): TrustProxy {
  if (!raw || raw === "false") return false;
  if (raw === "true") return true;
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    return (_address, hop) => hop < hops;
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
  DATABASE_URL: z.string().optional(),
  /** CA bundle (PEM) that verifies a remote database's TLS certificate (db/tls.ts). */
  VERITY_DB_CA_PATH: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  VERITY_PUBLIC_URL: z.string().optional(),
  VERITY_ALLOWED_ORIGINS: z.string().optional(),
  TRUST_PROXY: z.string().optional(),
  AUTH_EMAIL_TRANSPORT: z.enum(["smtp", "dev-outbox", "memory"]).optional(),
  AUTH_EMAIL_FROM: z.string().optional(),
  SMTP_URL: z.string().optional(),
  DEV_OUTBOX_DIR: z.string().optional(),
  INTERNAL_API_TOKEN: z.string().optional(),
  // Read only by the verification worker (src/worker/config.ts), never by the
  // API. Accepted here so a shared environment file doesn't fail validation.
  NIMBLE_API_KEY: z.string().optional(),
  NIMBLE_BASE_URL: z.string().optional(),
  RAWTREE_API_KEY: z.string().optional(),
  RAWTREE_DATABASE: z.string().optional(),
});

export type EmailTransport = "smtp" | "dev-outbox" | "memory";

export interface AppConfig {
  env: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: string;
  /** postgres:// URL, or a PGlite target ("pglite:memory" or "pglite:<dir>") outside production. */
  databaseUrl: string;
  /** PEM CA bundle for a remote database; null for a local one. */
  databaseCa: string | null;
  sessionSecret: string;
  publicUrl: string;
  allowedOrigins: string[];
  trustProxy: TrustProxy;
  email: { transport: EmailTransport; from: string; smtpUrl?: string; outboxDir: string };
  internalApiToken: string | null;
}

export class ConfigError extends Error {}

/** Empty variables (e.g. "PORT=" copied from .env.example) mean "not set". */
export function presentEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1].trim() !== ""),
  );
}

/** Database URL rules shared by the API and the worker. Problems name the variable, never its value. */
export function resolveDatabaseUrl(
  raw: string | undefined,
  nodeEnv: "development" | "test" | "production",
  problems: string[],
): string {
  const production = nodeEnv === "production";
  const databaseUrl = raw || (production ? "" : nodeEnv === "test" ? "pglite:memory" : "pglite:.data/pglite");
  if (!databaseUrl) problems.push("DATABASE_URL is required in production");
  if (production && databaseUrl.startsWith("pglite:")) problems.push("PGlite is for development only; use Postgres in production");
  if (databaseUrl && !databaseUrl.startsWith("pglite:") && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push("DATABASE_URL must be a postgres:// URL");
  }
  return databaseUrl;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(presentEnv(env));
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === "production";
  const problems: string[] = [];

  const databaseUrl = resolveDatabaseUrl(e.DATABASE_URL, e.NODE_ENV, problems);
  const databaseCa = resolveDatabaseCa(databaseUrl, e.VERITY_DB_CA_PATH, problems);

  const sessionSecret = e.SESSION_SECRET || (production ? "" : DEV_SESSION_SECRET);
  if (production && (sessionSecret.length < 32 || sessionSecret === DEV_SESSION_SECRET)) {
    problems.push("SESSION_SECRET must be a random value of at least 32 characters");
  }

  const port = e.PORT;
  const publicUrl = (e.VERITY_PUBLIC_URL || (production ? "" : `http://localhost:${port}`)).replace(/\/+$/, "");
  if (!publicUrl) problems.push("VERITY_PUBLIC_URL is required in production");
  else if (production && !publicUrl.startsWith("https://")) problems.push("VERITY_PUBLIC_URL must use https in production");

  const allowedOrigins = parseOrigins(e.VERITY_ALLOWED_ORIGINS);
  if (allowedOrigins.length === 0 && !production) allowedOrigins.push("http://localhost:5173", "http://127.0.0.1:5173");
  for (const origin of allowedOrigins) {
    if (!isExactOrigin(origin)) problems.push(`VERITY_ALLOWED_ORIGINS entry is not an exact origin: ${origin}`);
    if (production && !origin.startsWith("https://")) problems.push(`Production origins must use https: ${origin}`);
  }
  if (production && allowedOrigins.length === 0) problems.push("VERITY_ALLOWED_ORIGINS is required in production");

  const transport: EmailTransport = e.AUTH_EMAIL_TRANSPORT ?? (production ? "smtp" : e.NODE_ENV === "test" ? "memory" : "dev-outbox");
  if (production && transport !== "smtp") problems.push("AUTH_EMAIL_TRANSPORT must be smtp in production");
  if (transport === "smtp" && !e.SMTP_URL) problems.push("SMTP_URL is required for the smtp email transport");
  const from = e.AUTH_EMAIL_FROM || (production ? "" : "Verity <no-reply@verity.localhost>");
  if (!from) problems.push("AUTH_EMAIL_FROM is required in production");

  const internalApiToken = e.INTERNAL_API_TOKEN || null;
  if (internalApiToken && internalApiToken.length < 32) problems.push("INTERNAL_API_TOKEN must be at least 32 characters");

  if (problems.length > 0) throw new ConfigError(`Refusing to start:\n- ${problems.join("\n- ")}`);

  return {
    env: e.NODE_ENV,
    host: e.HOST || (production ? "0.0.0.0" : "127.0.0.1"),
    port,
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === "test" ? "silent" : "info"),
    databaseUrl,
    databaseCa,
    sessionSecret,
    publicUrl,
    allowedOrigins,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    email: { transport, from, smtpUrl: e.SMTP_URL, outboxDir: e.DEV_OUTBOX_DIR || ".data/dev-outbox" },
    internalApiToken,
  };
}

export interface DatabaseConfig {
  env: "development" | "test" | "production";
  databaseUrl: string;
  /** PEM CA bundle for a remote database; null for a local one. */
  databaseCa: string | null;
}

const databaseEnvSchema = envSchema.pick({ NODE_ENV: true, DATABASE_URL: true, VERITY_DB_CA_PATH: true });

/**
 * Only what a database command (migrations) needs: the URL and, for a remote
 * database, a verified CA. No session secret, SMTP or origins, so migrating
 * in production mode doesn't require the API's secrets.
 */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const parsed = databaseEnvSchema.safeParse(presentEnv(env));
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  const e = parsed.data;
  const problems: string[] = [];
  const databaseUrl = resolveDatabaseUrl(e.DATABASE_URL, e.NODE_ENV, problems);
  const databaseCa = resolveDatabaseCa(databaseUrl, e.VERITY_DB_CA_PATH, problems);
  if (problems.length > 0) throw new ConfigError(`Refusing to start:\n- ${problems.join("\n- ")}`);
  return { env: e.NODE_ENV, databaseUrl, databaseCa };
}
