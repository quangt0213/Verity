import { buildApp } from "./app";
import { ConfigError, loadConfig } from "./config";
import { createDatabase } from "./db/client";
import { databaseTargetProblems } from "./db/target-guard";

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // Configuration problems name the variable, never its value.
    console.error(error instanceof ConfigError ? error.message : "Invalid configuration");
    process.exit(1);
  }

  // Migrating a remote database on start needs the same explicit acknowledgement as `db:migrate`.
  if (process.env.MIGRATE_ON_START === "true") {
    const refusal = databaseTargetProblems("migrate", config.databaseUrl, process.env);
    if (refusal.length > 0) {
      console.error(`Refusing to migrate on start:\n- ${refusal.join("\n- ")}`);
      process.exit(1);
    }
  }
  const database = createDatabase(config.databaseUrl);
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
