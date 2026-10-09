import { ConfigError, loadDatabaseConfig } from "../config";
import { createDatabase } from "../db/client";
import { databaseTargetProblems } from "../db/target-guard";

// Apply pending migrations (run before starting a new release). Needs only the
// database settings: DATABASE_URL and, for a remote database, VERITY_DB_CA_PATH.
let config;
try {
  config = loadDatabaseConfig();
} catch (error) {
  // Configuration problems name the variable, never its value.
  console.error(error instanceof ConfigError ? error.message : "Invalid configuration");
  process.exit(1);
}
// A remote database (e.g. production Supabase in a local .env) needs VERITY_DATABASE_ACK=<its host>.
const refusal = databaseTargetProblems("migrate", config.databaseUrl, process.env);
if (refusal.length > 0) {
  console.error(`Refusing to migrate:\n- ${refusal.join("\n- ")}`);
  process.exit(1);
}
const database = createDatabase(config.databaseUrl, { ca: config.databaseCa });
try {
  await database.migrate();
  console.log("Migrations applied.");
} finally {
  await database.close();
}
