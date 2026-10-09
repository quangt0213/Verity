import { buildApp } from "./app";
import { ConfigError, loadConfig } from "./config";
import { createDatabase } from "./db/client";
import { readFileSync } from "node:fs";
import { databaseTargetProblems, envFileDefines, isLocalDatabase } from "./db/target-guard";

function readEnvFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // Configuration problems name the variable, never its value.
    console.error(error instanceof ConfigError ? error.message : "Invalid configuration");
    process.exit(1);
  }

  // A development API never casually connects to a remote (e.g. production) database from .env.
  const envFile = config.env === "production" ? null : readEnvFile(".env");
  const apiRefusal = databaseTargetProblems("api", config.databaseUrl, { ...process.env, devAckInEnvFile: envFileDefines(envFile, "VERITY_DEV_REMOTE_DATABASE") });
  if (apiRefusal.length > 0) {
    console.error(`Refusing to start:\n- ${apiRefusal.join("\n- ")}`);
    process.exit(1);
  }
  if (config.env !== "production" && !isLocalDatabase(config.databaseUrl)) {
    console.warn("WARNING: this development API is connected to a REMOTE database for this session only. Do not leave it running.");
  }

  // Migrating a remote database on start needs the same explicit acknowledgement as `db:migrate`.
  if (process.env.MIGRATE_ON_START === "true") {
    const refusal = databaseTargetProblems("migrate", config.databaseUrl, process.env);
    if (refusal.length > 0) {
      console.error(`Refusing to migrate on start:\n- ${refusal.join("\n- ")}`);
      process.exit(1);
    }
  }
  const database = createDatabase(config.databaseUrl, { ca: config.databaseCa });
  if (database.kind === "pglite" || process.env.MIGRATE_ON_START === "true") await database.migrate();

  const app = await buildApp({ config, db: database.db });
  if (database.kind === "pglite") app.log.warn("Using embedded PGlite (development only)");

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await database.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
}

void main();
