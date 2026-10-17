import { test } from "@playwright/test";
import { fakeVerityApi, instrument, saveResults, throttleBasemap, type LinkProfile } from "./harness";
import { syntheticEvents } from "./synthetic-events";

/**
 * Cold start over a simulated 4G link shared by the app's own assets and the
 * basemap (replayed responses, fresh browser cache each run). Compares route
 * code splitting: PERF_LABEL names the build under test.
 */
const LABEL = process.env.PERF_LABEL ?? "startup";
const LINK: LinkProfile = { rttMs: 150, kbps: 9_000 };
const WORLD = syntheticEvents(200, [-122.53, 37.69, -122.33, 37.84], 1);
const memo = new Map<string, { body: Buffer; headers: Record<string, string>; status: number }>();

test("cold start over 4G", async ({ browser }) => {
  const rows: Record<string, unknown>[] = [];
  for (const round of [0, 1, 2, 3]) {
    for (const route of ["/#/welcome", "/#/map"]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.addInitScript(() => localStorage.setItem("verity.onboarded", "true"));
      await instrument(page);
      await fakeVerityApi(page, WORLD);
      // Round 0 only fills the replay cache.
      await throttleBasemap(page, round === 0 ? { rttMs: 0, kbps: 1e9 } : LINK, memo, /tiles\.openfreemap\.org|127\.0\.0\.1:\d+\/(assets\/|theme-init|favicon)/);
      await page.goto(route);
      if (route === "/#/map") {
        await page.waitForFunction(() => (window as unknown as { __perf?: { marks: { firstIdle?: number } } }).__perf?.marks.firstIdle !== undefined, null, {
          timeout: 90_000,
        });
      } else {
        await page.getByRole("heading", { level: 1 }).first().waitFor();
      }
      const contentAt = await page.evaluate(() => Math.round(performance.now()));
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const m = await page.evaluate(() => {
        const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
        const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null;
        const marks = (window as unknown as { __perf: { marks: Record<string, number> } }).__perf.marks;
        return { dcl: Math.round(nav.domContentLoadedEventEnd), fcp: fcp && Math.round(fcp), mapCreated: marks.mapCreated && Math.round(marks.mapCreated), firstIdle: marks.firstIdle && Math.round(marks.firstIdle) };
      });
      if (round > 0) rows.push({ route, contentAt, ...m });
      await context.close();
    }
  }
  saveResults(`startup-${LABEL}`, rows);
  console.log(LABEL, JSON.stringify(rows));
});
