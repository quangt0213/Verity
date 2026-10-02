import { loadConfig } from "../config";
import { createDatabase } from "../db/client";

// Apply pending migrations (run before starting a new release).
const config = loadConfig();
const database = createDatabase(config.databaseUrl);
try {
  await database.migrate();
  console.log("Migrations applied.");
} finally {
  await database.close();
}
