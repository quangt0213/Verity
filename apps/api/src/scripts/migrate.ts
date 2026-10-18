import { ConfigError, loadDatabaseConfig } from "../config";
import { loadMigrationTimeouts, MigrationGateError, runMigrations } from "../db/migrate-runner";
import { databaseTargetProblems } from "../db/target-guard";

// Apply pending migrations (run before starting a new release). Needs only the
// database settings: DATABASE_URL and, for a remote database, VERITY_DB_CA_PATH.
// Runs on one connection with bounded lock and statement timeouts
// (MIGRATE_LOCK_TIMEOUT_MS, MIGRATE_STATEMENT_TIMEOUT_MS; see db/migrate-runner.ts).
let config;
let timeouts;
try {
  config = loadDatabaseConfig();
  timeouts = loadMigrationTimeouts();
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
try {
  // Logs the effective timeout values only, never the database URL.
  await runMigrations({ url: config.databaseUrl, ca: config.databaseCa, timeouts, log: (message) => console.log(message) });
  console.log("Migrations applied.");
} catch (error) {
  if (error instanceof MigrationGateError) {
    console.error(error.message);
    process.exit(1);
  }
  // A lock or statement timeout rolls the migration transaction back; report only the SQLSTATE.
  const code = (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
  console.error(`Migration failed${code ? ` (SQLSTATE ${code})` : ""}; the failed migration transaction was rolled back.`);
  process.exit(1);
}
