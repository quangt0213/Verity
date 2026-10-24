import { defineConfig, devices } from "@playwright/test";
import { PERF_API_ORIGIN, PERF_PORT } from "./constants";

/**
 * Map performance measurements (not a pass/fail suite). Builds the production
 * bundle in "perf" mode, which only adds `window.__verityMap` for the harness,
 * against a fake Verity service that the specs fulfil with synthetic events.
 *
 *   npx playwright test -c e2e/perf/playwright.perf.config.ts
 *
 * Basemap styles can be swapped per run with the usual VITE_MAP_STYLE_URL_*
 * variables. Results are written to node_modules/.cache/verity-perf/*.json. Each run makes
 * a few hundred ordinary tile requests; don't loop it. PERF_DEVICE=mobile
 * emulates a Pixel 7 instead of a 1360x860 desktop.
 */
const passthrough = Object.fromEntries(
  ["VITE_MAP_STYLE_URL_LIGHT", "VITE_MAP_STYLE_URL_DARK", "VITE_MAP_EXTRA_ORIGINS"].flatMap((name) =>
    process.env[name] ? [[name, process.env[name] as string]] : [],
  ),
);

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.perf.ts",
  timeout: 240_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../../test-results/perf-artifacts",
  use: {
    baseURL: `http://127.0.0.1:${PERF_PORT}`,
    channel: process.env.PW_CHANNEL || undefined,
    ...(process.env.PERF_DEVICE === "mobile" ? devices["Pixel 7"] : { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 860 } }),
  },
  webServer: {
    cwd: "../..",
    command: `npx vite build --mode perf --outDir node_modules/.verity-perf-dist && npx vite preview --outDir node_modules/.verity-perf-dist --port ${PERF_PORT} --strictPort --host 127.0.0.1`,
    env: { ...passthrough, VITE_VERITY_DATA_SOURCE: "api", VITE_VERITY_API_URL: PERF_API_ORIGIN, MAYPOP_DEV_HOST: "off" },
    url: `http://127.0.0.1:${PERF_PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
