import { test, type Page } from "@playwright/test";
import { captureNetwork, fakeVerityApi, instrument, saveResults, throttleBasemap, type LinkProfile } from "./harness";
import { syntheticEvents } from "./synthetic-events";

/**
 * Programmatic camera moves under a simulated slow network (fixed, replayed
 * tiles, so strategies are compared on identical data). Strategies mirror
 * MapView's flyTarget effect:
 *   ease700 – current: easeTo at max(zoom, target) over 700 ms
 *   jumpFar – jumpTo when the target is more than 1.5 viewports away, else ease700
 *   flyTo   – MapLibre flyTo (zoom-out arc) over 1.2 s
 */
const PROFILES: Record<string, LinkProfile> = {
  "4g": { rttMs: 150, kbps: 9_000 },
  "edge-miss": { rttMs: 700, kbps: 20_000 },
};
const STRATEGIES = ["ease700", "jumpFar", "flyTo"] as const;
const TARGETS: Array<[string, number, number, number]> = [
  ["Los Angeles z14", -118.2437, 34.0522, 14],
  ["Oakland z14", -122.2712, 37.8044, 14],
  ["SF Mission z15", -122.4194, 37.7599, 15],
];
const WORLD = syntheticEvents(400, [-122.53, 37.69, -122.33, 37.84], 1);
const memo = new Map<string, { body: Buffer; headers: Record<string, string>; status: number }>();

async function moveAndTime(page: Page, strategy: string, lng: number, lat: number, zoom: number) {
  return page.evaluate(
    async ({ strategy, lng, lat, zoom }) => {
      type M = {
        getZoom(): number;
        project(c: [number, number]): { x: number; y: number };
        getCanvas(): HTMLCanvasElement;
        easeTo(o: object): void;
        jumpTo(o: object): void;
        flyTo(o: object): void;
        once(e: string, cb: () => void): void;
        areTilesLoaded(): boolean;
      };
      const map = (window as unknown as { __verityMap: M }).__verityMap;
      const start = performance.now();
      const p = map.project([lng, lat]);
      const canvas = map.getCanvas();
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const distance = Math.hypot(p.x - w / 2, p.y - h / 2) * 2 ** (Math.max(map.getZoom(), zoom) - map.getZoom());
      const far = distance > 1.5 * Math.max(w, h);
      const target = { center: [lng, lat], zoom: Math.max(map.getZoom(), zoom) };
      let moveEnd = 0;
      const idle = new Promise<number>((resolve) => {
        map.once("moveend", () => {
          moveEnd = performance.now() - start;
          map.once("idle", () => resolve(performance.now() - start));
        });
      });
      if (strategy === "jumpFar" && far) map.jumpTo(target);
      else if (strategy === "flyTo") map.flyTo({ center: [lng, lat], zoom, duration: 1200 });
      else map.easeTo({ ...target, duration: 700 });
      const idleMs = await idle;
      return { far, moveEndMs: Math.round(moveEnd), idleMs: Math.round(idleMs) };
    },
    { strategy, lng, lat, zoom },
  );
}

for (const [profileName, profile] of Object.entries(PROFILES)) {
  test(`camera strategies on ${profileName}`, async ({ browser }) => {
    const results: Record<string, unknown[]> = {};
    // Round 0 fills the in-memory tile replay cache; rounds 1–2 are measured.
    for (const round of [0, 1, 2]) {
      for (const strategy of STRATEGIES) {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.addInitScript(() => {
          localStorage.setItem("verity.onboarded", "true");
          localStorage.setItem("verity.theme", JSON.stringify("light"));
        });
        await instrument(page);
        await fakeVerityApi(page, WORLD);
        await throttleBasemap(page, round === 0 ? { rttMs: 0, kbps: 1e9 } : profile, memo);
        const net = captureNetwork(page);
        await page.goto("/#/map");
        await page.waitForFunction(() => (window as unknown as { __perf?: { marks: { firstIdle?: number } } }).__perf?.marks.firstIdle !== undefined, null, {
          timeout: 90_000,
        });
        const initial = await page.evaluate(() => {
          const m = (window as unknown as { __perf: { marks: Record<string, number> } }).__perf.marks;
          return Math.round(m.firstIdle! - m.mapCreated!);
        });
        const rows: unknown[] = [{ name: "initial load z12", idleMs: initial }];
        for (const [name, lng, lat, zoom] of TARGETS) {
          await page.waitForTimeout(800);
          const since = net.now();
          const timing = await moveAndTime(page, strategy, lng, lat, zoom);
          const tiles = net.since(since).filter((r) => r.kind === "tile");
          rows.push({
            name,
            ...timing,
            requests: tiles.length,
            aborted: tiles.filter((r) => r.failure).length,
            completedKB: Math.round(tiles.filter((r) => !r.failure).reduce((s, r) => s + (r.bytes ?? 0), 0) / 1024),
          });
        }
        if (round > 0) (results[strategy] ??= []).push(rows);
        await context.close();
      }
    }
    saveResults(`fly-${profileName}`, { profile, results });
    for (const [strategy, runs] of Object.entries(results)) console.log(profileName, strategy, JSON.stringify(runs));
  });
}
