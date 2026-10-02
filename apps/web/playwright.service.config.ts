import { defineConfig, devices } from "@playwright/test";
import { API_ORIGIN, APP_ORIGIN, DB_DIR, HOST_URL, INTERNAL_TOKEN, OUTBOX_DIR, TMP_DIR } from "./e2e/service/constants";

/**
 * Phase 2 completion test: the production frontend bundle against the real
 * Verity service (embedded Postgres, dev email outbox), with the frontend in a
 * cross-site sandboxed iframe like Maypop. Run: npm run test:e2e:service
 */
export default defineConfig({
  testDir: "e2e/service",
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results/service",
  use: {
    channel: process.env.PW_CHANNEL || undefined,
    ...devices["Desktop Chrome"],
    viewport: { width: 1360, height: 860 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      // Fresh database each run, demo events seeded, then the service.
      command: `node -e "require('fs').rmSync(process.env.E2E_TMP,{recursive:true,force:true})" && npx tsx src/scripts/seed-dev.ts && npx tsx src/server.ts`,
      cwd: "../api",
      env: {
        E2E_TMP: TMP_DIR,
        NODE_ENV: "development",
        HOST: "127.0.0.2",
        PORT: "8788",
        DATABASE_URL: `pglite:${DB_DIR}`,
        DEV_OUTBOX_DIR: OUTBOX_DIR,
        VERITY_PUBLIC_URL: API_ORIGIN,
        VERITY_ALLOWED_ORIGINS: APP_ORIGIN,
        INTERNAL_API_TOKEN: INTERNAL_TOKEN,
        LOG_LEVEL: "warn",
      },
      url: `${API_ORIGIN}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: "npx vite build --mode e2e --outDir dist-e2e-service && npx vite preview --outDir dist-e2e-service --port 4180 --strictPort --host 127.0.0.1",
      env: { VITE_VERITY_DATA_SOURCE: "api", VITE_VERITY_API_URL: API_ORIGIN, MAYPOP_DEV_HOST: "off" },
      url: APP_ORIGIN,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: "node e2e/service/host-server.mjs",
      env: { APP_ORIGIN, PORT: "4190" },
      url: HOST_URL,
      reuseExistingServer: false,
    },
  ],
});
