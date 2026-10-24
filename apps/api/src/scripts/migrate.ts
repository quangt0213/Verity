import { ConfigError, loadDatabaseConfig } from "../config";
import { classifyMigrationFailure, loadMigrationTimeouts, MIGRATION_EXIT_CODES, MigrationRunError, runMigrations } from "../db/migrate-runner";
import { databaseTargetProblems } from "../db/target-guard";

// Apply pending migrations (run before starting a new release). Needs only the
// database settings: DATABASE_URL and, for a remote database, VERITY_DB_CA_PATH.
// Runs on one connection with bounded lock and statement timeouts
// (MIGRATE_LOCK_TIMEOUT_MS, MIGRATE_STATEMENT_TIMEOUT_MS; see db/migrate-runner.ts).
//
// Exit codes (db/migrate-runner.ts, classifyMigrationFailure):
//   0 applied (or nothing pending)
//   2 refused: configuration, target or timeout safety check; nothing attempted
//   3 not attempted: could not connect or authenticate; nothing applied
//   4 rolled back: the server rejected a statement inside the migration transaction
//   5 UNKNOWN outcome: the connection failed while migrating; inspect before any retry
// Output never includes the database URL, host, user, password or a driver message.
let config;
let timeouts;
try {
  config = loadDatabaseConfig();
  timeouts = loadMigrationTimeouts();
} catch (error) {
  console.error(classifyMigrationFailure(new ConfigError("invalid configuration"), { started: false }).message);
  // Configuration problems name the variable, never its value.
  if (error instanceof ConfigError) console.error(error.message);
  process.exit(MIGRATION_EXIT_CODES.refused);
}
// A remote database (e.g. production Supabase in a local .env) needs VERITY_DATABASE_ACK=<its host>.
const refusal = databaseTargetProblems("migrate", config.databaseUrl, process.env);
if (refusal.length > 0) {
  console.error(`Migration refused: database target check failed. Nothing was applied.\n- ${refusal.join("\n- ")}`);
  process.exit(MIGRATION_EXIT_CODES.refused);
}
try {
  // Logs the effective timeout values only, never the database URL.
  await runMigrations({ url: config.databaseUrl, ca: config.databaseCa, timeouts, log: (message) => console.log(message) });
  console.log("Migrations applied.");
} catch (error) {
  // An error from an unknown stage counts as "may have started": never claim a rollback that can't be proven.
  const started = error instanceof MigrationRunError ? error.started : true;
  const result = classifyMigrationFailure(error instanceof MigrationRunError ? error.cause : error, { started });
  console.error(result.message);
  process.exit(result.exitCode);
}
