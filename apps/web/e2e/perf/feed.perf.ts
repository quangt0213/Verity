import { expect, test, type Page } from "@playwright/test";
import { commitsBetween, fakeVerityApi, identifyComponents, instrument, longtasksBetween, saveResults, snapshot, timedMove } from "./harness";
import { syntheticEvents } from "./synthetic-events";

/**
 * Feed render cost with 500 events in view: list hover, a pan that loads new
 * events, and a small pan that returns the same events. Reports React commits,
 * EventCard renders, long tasks and the longest frame gap.
 * Results: node_modules/.cache/verity-perf/<PERF_LABEL>-feed.json.
 * PERF_CPU_THROTTLE=4 approximates a mid-range phone.
 */
const LABEL = process.env.PERF_LABEL ?? "run";
const CPU_THROTTLE = Number(process.env.PERF_CPU_THROTTLE ?? 1);
const WORLD = syntheticEvents(4000, [-122.6, 37.65, -122.2, 37.9], 1);

const frames = {
  start: (page: Page) => page.evaluate(() => (window as unknown as { __perfFrames: { start: () => void } }).__perfFrames.start()),
  stop: (page: Page) =>
    page.evaluate(() => (window as unknown as { __perfFrames: { stop: () => { maxGapMs: number | null; p95GapMs: number | null } } }).__perfFrames.stop()),
};

async function measure(page: Page, action: () => Promise<void>, settleMs: number) {
  const from = (await snapshot(page)).now;
  await frames.start(page);
  await action();
  await page.waitForTimeout(settleMs);
  const gaps = await frames.stop(page);
  const snap = await snapshot(page);
  const c = commitsBetween(snap, from);
  return {
    commits: c.commits,
    eventCardRenders: c.eventCards,
    feedRenders: c.feed,
    longtasks: longtasksBetween(snap, from),
    maxFrameGapMs: gaps.maxGapMs,
    cardsInDom: await page.locator('aside[aria-label="Events"] li > a').count(),
  };
}

test("feed render cost with 500 events in view", async ({ page, context }) => {
  await instrument(page);
  await fakeVerityApi(page, WORLD);
  await page.addInitScript(() => localStorage.setItem("verity.onboarded", "true"));
  await page.goto("/#/map");
  await page.waitForFunction(() => (window as unknown as { __perf?: { marks: { firstIdle?: number } } }).__perf?.marks.firstIdle !== undefined, null, {
    timeout: 60_000,
  });
  const heading = page.getByRole("complementary", { name: "Events" }).getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("500 events in this area", { timeout: 30_000 });
  expect(await identifyComponents(page)).toEqual({ mapView: true, feed: true, shell: true, eventCard: true });
  await page.waitForTimeout(1000);
  if (CPU_THROTTLE > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
  }

  const cards = page.locator('aside[aria-label="Events"] li > a');
  const hover8 = await measure(
    page,
    async () => {
      for (let i = 0; i < 8; i++) await cards.nth(i).hover();
      await page.mouse.move(900, 400);
    },
    500,
  );

  const panNewEvents = await measure(page, () => timedMove(page, { kind: "panBy", x: 500, y: 0, duration: 400 }).then(() => undefined), 2500);
  await expect(heading).toHaveText("500 events in this area");
  const smallPan = await measure(page, () => timedMove(page, { kind: "panBy", x: 40, y: 0, duration: 200 }).then(() => undefined), 2500);

  const result = { cpuThrottle: CPU_THROTTLE, hover8, panNewEvents, smallPan };
  saveResults(`${LABEL}-feed`, result);
  console.log(JSON.stringify(result, null, 1));
});
