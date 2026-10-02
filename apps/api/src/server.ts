import { buildApp } from "./app";
import { ConfigError, loadConfig } from "./config";
import { createDatabase } from "./db/client";

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // Configuration problems name the variable, never its value.
    console.error(error instanceof ConfigError ? error.message : "Invalid configuration");
    process.exit(1);
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
