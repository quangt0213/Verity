import { z } from "zod";
import { ConfigError, presentEnv, resolveDatabaseUrl } from "../config";

/**
 * Configuration for the verification worker, a separate process from the API.
 * Only the worker holds NIMBLE_API_KEY; it needs no session secret, SMTP or
 * origin settings. Budgets bound what verification can spend; the defaults are
 * deliberately conservative.
 */

/** Nimble API hosts the key may be sent to. Anything else is refused. */
export const NIMBLE_ALLOWED_HOSTS = ["sdk.nimbleway.com"] as const;
export const NIMBLE_DEFAULT_BASE_URL = "https://sdk.nimbleway.com";

/**
 * Agent investigations always use "low" effort. "medium" may later be allowed
 * for conflicting evidence only; it is off unless explicitly configured.
 */
export const AGENT_EFFORTS = ["low", "medium"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

const int = (min: number, max: number, fallback: number) => z.coerce.number().int().min(min).max(max).default(fallback);

const workerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
  DATABASE_URL: z.string().optional(),
  NIMBLE_API_KEY: z.string().optional(),
  NIMBLE_BASE_URL: z.string().optional(),
  VERIFICATION_WORKER_CONCURRENCY: int(1, 8, 2),
  VERIFICATION_POLL_INTERVAL_MS: int(1_000, 60_000, 5_000),
  VERIFICATION_LEASE_SECONDS: int(120, 3_600, 600),
  NIMBLE_MAX_SEARCHES_PER_JOB: int(1, 5, 3),
  NIMBLE_DAILY_SEARCH_BUDGET: int(0, 10_000, 200),
  NIMBLE_DAILY_AGENT_BUDGET: int(0, 500, 20),
  NIMBLE_AGENT_CONFLICT_EFFORT: z.enum(AGENT_EFFORTS).default("low"),
  NIMBLE_AGENT_EVENT_COOLDOWN_HOURS: int(1, 168, 6),
  NIMBLE_AGENT_MAX_PER_EVENT: int(0, 10, 2),
  NIMBLE_AGENT_POLL_TIMEOUT_SECONDS: int(30, 600, 90),
  GEOCODER_PROVIDER: z.enum(["none", "nominatim"]).default("none"),
  GEOCODER_URL: z.string().optional(),
  GEOCODER_USER_AGENT: z.string().optional(),
});

export const NOMINATIM_PUBLIC_URL = "https://nominatim.openstreetmap.org";

export interface WorkerConfig {
  env: "development" | "test" | "production";
  logLevel: string;
  databaseUrl: string;
  concurrency: number;
  pollIntervalMs: number;
  /** A claimed job is reclaimable after this long without completing. */
  leaseSeconds: number;
  nimble: {
    /** Null outside production when no key is configured: retrieval is then unavailable, never faked. */
    apiKey: string | null;
    baseUrl: string;
    maxSearchesPerJob: number;
    /** 0 disables ordinary search. */
    dailySearchBudget: number;
    /** 0 disables agent investigations. */
    dailyAgentBudget: number;
    agentEffort: "low";
    agentConflictEffort: AgentEffort;
    agentEventCooldownHours: number;
    agentMaxPerEvent: number;
    agentPollTimeoutSeconds: number;
  };
  /** Reverse geocoding for search context. Off unless explicitly configured. */
  geocoder: { provider: "nominatim"; url: string; userAgent: string } | null;
}

function checkBaseUrl(raw: string, production: boolean, problems: string[]): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push("NIMBLE_BASE_URL must be an absolute URL");
    return raw;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.username || url.password || url.search || url.hash) {
    problems.push("NIMBLE_BASE_URL must not contain credentials, a query or a fragment");
  } else if (url.protocol === "https:" && (NIMBLE_ALLOWED_HOSTS as readonly string[]).includes(url.hostname)) {
    // The real API.
  } else if (!production && local && (url.protocol === "http:" || url.protocol === "https:")) {
    // A local stand-in for tests and development; never in production.
  } else {
    problems.push(`NIMBLE_BASE_URL must be https://${NIMBLE_ALLOWED_HOSTS.join(" or https://")}`);
  }
  return url.origin;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = workerEnvSchema.safeParse(presentEnv(env));
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === "production";
  const problems: string[] = [];

  const databaseUrl = resolveDatabaseUrl(e.DATABASE_URL, e.NODE_ENV, problems);
  const apiKey = e.NIMBLE_API_KEY?.trim() || null;
  if (production && !apiKey) problems.push("NIMBLE_API_KEY is required for the verification worker in production");
  const baseUrl = checkBaseUrl(e.NIMBLE_BASE_URL ?? NIMBLE_DEFAULT_BASE_URL, production, problems);
  // A lease must outlive the longest agent poll, or a healthy job could be reclaimed mid-run.
  if (e.VERIFICATION_LEASE_SECONDS < e.NIMBLE_AGENT_POLL_TIMEOUT_SECONDS + 120) {
    problems.push("VERIFICATION_LEASE_SECONDS must exceed NIMBLE_AGENT_POLL_TIMEOUT_SECONDS by at least 120");
  }

  let geocoder: WorkerConfig["geocoder"] = null;
  if (e.GEOCODER_PROVIDER === "nominatim") {
    const url = (e.GEOCODER_URL ?? NOMINATIM_PUBLIC_URL).replace(/\/+$/, "");
    const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url);
    if (!/^https:\/\/[^/@\s]+$/.test(url) && !(local && !production)) problems.push("GEOCODER_URL must be an https origin");
    // Nominatim's usage policy requires an identifying User-Agent with a way to reach the operator.
    const ua = e.GEOCODER_USER_AGENT?.trim() ?? "";
    if (ua.length < 10 || !/(@|https?:\/\/)/.test(ua)) problems.push("GEOCODER_USER_AGENT must identify the application and include a contact (email or URL)");
    geocoder = { provider: "nominatim", url, userAgent: ua };
  }

  if (problems.length > 0) throw new ConfigError(`Refusing to start:\n- ${problems.join("\n- ")}`);

  const config: WorkerConfig = {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === "test" ? "silent" : "info"),
    databaseUrl,
    concurrency: e.VERIFICATION_WORKER_CONCURRENCY,
    pollIntervalMs: e.VERIFICATION_POLL_INTERVAL_MS,
    leaseSeconds: e.VERIFICATION_LEASE_SECONDS,
    nimble: {
      apiKey,
      baseUrl,
      maxSearchesPerJob: e.NIMBLE_MAX_SEARCHES_PER_JOB,
      dailySearchBudget: e.NIMBLE_DAILY_SEARCH_BUDGET,
      dailyAgentBudget: e.NIMBLE_DAILY_AGENT_BUDGET,
      agentEffort: "low",
      agentConflictEffort: e.NIMBLE_AGENT_CONFLICT_EFFORT,
      agentEventCooldownHours: e.NIMBLE_AGENT_EVENT_COOLDOWN_HOURS,
      agentMaxPerEvent: e.NIMBLE_AGENT_MAX_PER_EVENT,
      agentPollTimeoutSeconds: e.NIMBLE_AGENT_POLL_TIMEOUT_SECONDS,
    },
    geocoder,
  };
  // Keep the key and database URL out of anything that serializes the config (e.g. a log line).
  Object.defineProperty(config, "toJSON", {
    enumerable: false,
    value: () => ({ ...config, databaseUrl: "[redacted]", nimble: { ...config.nimble, apiKey: config.nimble.apiKey ? "[redacted]" : null } }),
  });
  return config;
}
