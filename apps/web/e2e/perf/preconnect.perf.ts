import { test } from "@playwright/test";
import { captureNetwork, fakeVerityApi, instrument, saveResults } from "./harness";

/** Real network: how long the first basemap request (the style) takes on a cold context. */
const LABEL = process.env.PERF_LABEL ?? "preconnect";

test("first basemap request on a cold context", async ({ browser }) => {
  const rows = [];
  for (let i = 0; i < 6; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem("verity.onboarded", "true"));
    await instrument(page);
    await fakeVerityApi(page, []);
    const net = captureNetwork(page);
    await page.goto("/#/map");
    await page.waitForFunction(() => (window as unknown as { __perf?: { marks: { load?: number } } }).__perf?.marks.load !== undefined, null, { timeout: 60_000 });
    const style = net.records.find((r) => r.kind === "style");
    const timing = await page.evaluate(() => {
      const e = performance.getEntriesByType("resource").find((r) => r.name.includes("/styles/")) as PerformanceResourceTiming | undefined;
      return e ? { connectMs: Math.round(e.connectEnd - e.connectStart), dnsMs: Math.round(e.domainLookupEnd - e.domainLookupStart), totalMs: Math.round(e.responseEnd - e.startTime) } : null;
    });
    const marks = await page.evaluate(() => (window as unknown as { __perf: { marks: Record<string, number> } }).__perf.marks);
    rows.push({ styleMs: style?.durationMs, ...timing, load: Math.round(marks.load!) });
    await context.close();
  }
  saveResults(`preconnect-${LABEL}`, rows);
  console.log(LABEL, JSON.stringify(rows));
});
