import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pino from "pino";
import { ConfigError } from "../config";
import { createDatabase } from "../db/client";
import { loadWorkerConfig } from "./config";
import { createWorker } from "./loop";
import { unconfiguredInvestigator, unconfiguredRetriever } from "./ports";

/**
 * The verification worker process (dist/worker.js), separate from the API
 * process (dist/server.js): the API never starts verification work. Run one or
 * more of these alongside the API; job claiming is safe across processes.
 *
 * Providers arrive in later stages (Nimble search in S4, the agent in S5, a
 * geocoding provider with the durable cache). Until then retrieval reports
 * "unavailable" honestly and nothing is fabricated.
 */
async function main() {
  let config;
  try {
    config = loadWorkerConfig();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : "Invalid configuration");
    process.exit(1);
  }

  const log = pino({
    level: config.logLevel,
    base: { service: "verity-worker" },
    redact: { paths: ["*.apiKey", "*.token", "*.email", "*.password", "*.secret", "*.databaseUrl", "*.authorization"], censor: "[redacted]" },
  });

  const database = createDatabase(config.databaseUrl);
  if (database.kind === "pglite") {
    // PGlite is single-process and owned by the API in development.
    log.error({}, "The verification worker needs Postgres: set DATABASE_URL to a postgres:// URL");
    process.exit(1);
  }

  // Refuse to touch a database that lacks the Phase 3 schema (e.g. an un-migrated production database).
  const ready = (await database.db.execute(
    sql`select to_regclass('public.verification_runs') is not null and to_regclass('public.geocode_cache') is not null as ready`,
  )) as unknown as Array<{ ready: boolean }>;
  if (!ready[0]?.ready) {
    log.error({}, "The database is missing the verification schema (migrations 0003 and 0004). Apply migrations first.");
    await database.close();
    process.exit(1);
  }

  const workerId = `w_${randomUUID().slice(0, 12)}`;
  const worker = createWorker({
    db: database.db,
    config,
    retriever: unconfiguredRetriever,
    investigator: unconfiguredInvestigator,
    geocoder: null,
    now: () => new Date(),
    log,
    workerId,
  });

  const controller = new AbortController();
  const shutdown = (signal: string) => {
    log.info({ signal }, "stopping: no new claims, finishing in-flight work");
    controller.abort();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info({ workerId, concurrency: config.concurrency, retriever: unconfiguredRetriever.name }, "verification worker started");
  await worker.run(controller.signal);
  await database.close();
  log.info({ workerId }, "verification worker stopped");
}

void main();
