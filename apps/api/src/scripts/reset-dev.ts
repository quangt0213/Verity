import { rmSync } from "node:fs";
import { loadConfig } from "../config";

// Development-only: delete the local embedded database and dev outbox.
const config = loadConfig();
if (config.env === "production" || !config.databaseUrl.startsWith("pglite:") || config.databaseUrl === "pglite:memory") {
  console.error("db:reset only clears a local PGlite database directory in development.");
  process.exit(1);
}
rmSync(config.databaseUrl.slice("pglite:".length), { recursive: true, force: true });
rmSync(config.email.outboxDir, { recursive: true, force: true });
console.log("Local development database and outbox removed. Run npm run db:seed -w @verity/api to load demo data.");
