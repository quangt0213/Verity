import { defineConfig, devices } from "@playwright/test";

const PORT = 4179;

/**
 * End-to-end smoke tests against the PRODUCTION bundle (including its CSP),
 * built in labeled demo mode. Basemap tiles come from the public style URL, so
 * set E2E_OFFLINE=1 to skip map-render assertions without network access.
 * Set PW_CHANNEL=chrome (or msedge) to use an installed browser instead of
 * Playwright's bundled Chromium.
 */
export default defineConfig({
  testDir: "e2e",
  // The service suite has its own config (playwright.service.config.ts).
  testIgnore: ["service/**"],
  timeout: 60_000,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: process.env.PW_CHANNEL || undefined,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npx vite build --outDir dist-e2e && npx vite preview --outDir dist-e2e --port ${PORT} --strictPort --host 127.0.0.1`,
    env: { VITE_VERITY_DATA_SOURCE: "mock", VITE_MOCK_WRITES: "simulate", MAYPOP_DEV_HOST: "off" },
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 860 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
