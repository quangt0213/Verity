import { loadConfig } from "../config";
import { createDatabase } from "../db/client";
import { databaseTargetProblems } from "../db/target-guard";

// Apply pending migrations (run before starting a new release).
const config = loadConfig();
// A remote database (e.g. production Supabase in a local .env) needs VERITY_DATABASE_ACK=<its host>.
const refusal = databaseTargetProblems("migrate", config.databaseUrl, process.env);
if (refusal.length > 0) {
  console.error(`Refusing to migrate:\n- ${refusal.join("\n- ")}`);
  process.exit(1);
}
const database = createDatabase(config.databaseUrl);
try {
  await database.migrate();
  console.log("Migrations applied.");
} finally {
  await database.close();
}
