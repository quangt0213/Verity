import { buildDemoEvents } from "@verity/contracts/demo";
import { loadConfig } from "../config";
import { createDatabase } from "../db/client";
import { databaseTargetProblems } from "../db/target-guard";
import { insertDemoEvents } from "../db/seed";

// Development-only: load labeled demo events into the local database.
const config = loadConfig();
if (config.env === "production") {
  console.error("Refusing to seed demo data in production.");
  process.exit(1);
}
// Seeding (and the migration before it) only ever touches a LOCAL database, whatever .env says.
const refusal = databaseTargetProblems("seed", config.databaseUrl, process.env);
if (refusal.length > 0) {
  console.error(`Refusing to seed:\n- ${refusal.join("\n- ")}`);
  process.exit(1);
}
const database = createDatabase(config.databaseUrl);
await database.migrate();
try {
  const count = await insertDemoEvents(database.db, buildDemoEvents(new Date()));
  console.log(`Seeded ${count} demo events (flagged is_demo).`);
} catch (error) {
  console.error("Seeding failed (already seeded? run npm run db:reset -w @verity/api):", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await database.close();
}
