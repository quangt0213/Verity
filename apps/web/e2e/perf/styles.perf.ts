import { test, type Page } from "@playwright/test";
import { captureNetwork, fakeVerityApi, instrument, saveResults, snapshot, startProfile, summarizeNetwork } from "./harness";
import { syntheticEvents } from "./synthetic-events";

/**
 * Basemap style comparison: the same viewpoints rendered with each candidate,
 * with screenshots, counts of basemap features the map actually drew (by
 * source layer), network cost and render cost of a short pan.
 *
 * PERF_STYLES is a comma-separated list of name=url[|theme]; default below.
 * Candidates on other hosts need VITE_MAP_EXTRA_ORIGINS for the perf build's CSP.
 * PERF_STYLE_PASSES=2 repeats each candidate (the second pass is CDN-warm).
 */
const OFM = "https://tiles.openfreemap.org/styles";
const DEFAULT_STYLES = [
  `positron=${OFM}/positron|light`,
  `liberty=${OFM}/liberty|light`,
  `bright=${OFM}/bright|light`,
  `dark=${OFM}/dark|dark`,
  `fiord=${OFM}/fiord|dark`,
].join(",");
const STYLES = (process.env.PERF_STYLES ?? DEFAULT_STYLES).split(",").map((entry) => {
  const [name, rest] = entry.split("=") as [string, string];
  const [url, theme] = rest.split("|") as [string, string | undefined];
  return { name, url: url === "default" ? null : url, theme: theme === "dark" ? "dark" : "light" };
});
const PASSES = Number(process.env.PERF_STYLE_PASSES ?? 1);
const SHOTS = process.env.PERF_SHOTS_DIR;

const VIEWPOINTS: Array<[string, number, number, number]> = [
  ["overview z12", -122.4194, 37.7749, 12],
  ["golden-gate-park z14", -122.4862, 37.7694, 14],
  ["union-square z15", -122.4075, 37.788, 15],
  ["mission z16.5", -122.4194, 37.7599, 16.5],
];

const WORLD = syntheticEvents(60, [-122.53, 37.69, -122.33, 37.84], 3);

async function jumpAndIdle(page: Page, lng: number, lat: number, zoom: number) {
  return page.evaluate(
    ({ lng, lat, zoom }) =>
      new Promise<number>((resolve) => {
        const map = (window as unknown as { __verityMap: { jumpTo(o: object): void; once(e: string, cb: () => void): void } }).__verityMap;
        const start = performance.now();
        map.once("idle", () => resolve(Math.round(performance.now() - start)));
        map.jumpTo({ center: [lng, lat], zoom });
      }),
    { lng, lat, zoom },
  );
}

/** Basemap features MapLibre rendered in the viewport, grouped by source layer (symbols count only placed labels/icons). */
async function renderedCounts(page: Page) {
  return page.evaluate(() => {
    type F = { sourceLayer?: string; layer: { id: string; type: string }; source: string };
    const map = (window as unknown as { __verityMap: { queryRenderedFeatures(): F[] } }).__verityMap;
    const counts: Record<string, number> = {};
    for (const f of map.queryRenderedFeatures()) {
      if (f.source.startsWith("verity-")) {
        counts["verity markers"] = (counts["verity markers"] ?? 0) + 1;
        continue;
      }
      const key = `${f.sourceLayer ?? f.source}${f.layer.type === "symbol" ? " (labels/icons)" : ""}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  });
}

for (const style of STYLES) {
  test(`style ${style.name}`, async ({ browser }) => {
    const passes = [];
    for (let pass = 1; pass <= PASSES; pass++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.addInitScript(
        ({ url, theme }) => {
          localStorage.setItem("verity.onboarded", "true");
          localStorage.setItem("verity.theme", JSON.stringify(theme));
          if (url) Object.assign(window, { __verityMapOptions: { style: url } });
        },
        { url: style.url, theme: style.theme },
      );
      await instrument(page);
      await fakeVerityApi(page, WORLD);
      const net = captureNetwork(page);
      await page.goto("/#/map");
      await page.waitForFunction(() => (window as unknown as { __perf?: { marks: { firstIdle?: number } } }).__perf?.marks.firstIdle !== undefined, null, {
        timeout: 90_000,
      });
      const snap = await snapshot(page);
      const initial = {
        styleLoadMs: Math.round(snap.marks.styleLoad! - snap.marks.mapCreated!),
        loadMs: Math.round(snap.marks.load! - snap.marks.mapCreated!),
        idleMs: Math.round(snap.marks.firstIdle! - snap.marks.mapCreated!),
        network: summarizeNetwork(net.records.filter((r) => !r.url.startsWith("http://127.0.0.1"))),
      };
      await page.waitForTimeout(1500);

      const views = [];
      for (const [name, lng, lat, zoom] of VIEWPOINTS) {
        const since = net.now();
        const idleMs = await jumpAndIdle(page, lng, lat, zoom);
        await page.waitForTimeout(400);
        const network = summarizeNetwork(net.since(since));
        views.push({ name, idleMs, network, rendered: await renderedCounts(page) });
        if (SHOTS && pass === PASSES) await page.screenshot({ path: `${SHOTS}/${style.name}-${name.replace(/\s+/g, "_")}.png` });
      }

      // Render cost: a 1.2 s animated pan over cached tiles at z15.
      await jumpAndIdle(page, -122.4075, 37.788, 15);
      const stop = await startProfile(page);
      const frames = await page.evaluate(
        () =>
          new Promise<unknown>((resolve) => {
            const w = window as unknown as {
              __verityMap: { panBy(p: [number, number], o: object): void; once(e: string, cb: () => void): void };
              __perfFrames: { start(): void; stop(): unknown };
            };
            w.__perfFrames.start();
            w.__verityMap.once("moveend", () => resolve(w.__perfFrames.stop()));
            w.__verityMap.panBy([300, 120], { duration: 1200 });
          }),
      );
      const cpu = await stop();
      passes.push({ pass, initial, views, pan: { frames, maplibreMs: cpu.byScript["maplibre.js"] ?? 0, programMs: cpu.byScript["((program))"] ?? 0 } });
      await context.close();
    }
    saveResults(`style-${style.name}`, { style, passes });
    for (const p of passes) {
      console.log(
        style.name,
        `pass ${p.pass}`,
        JSON.stringify({ initial: { ...p.initial, network: undefined }, pan: p.pan }),
        "\n ",
        p.views.map((v) => `${v.name}: ${v.idleMs}ms tiles ${v.network.tile?.requests ?? 0}/${Math.round((v.network.tile?.bytes ?? 0) / 1024)}KB ${JSON.stringify(v.rendered)}`).join("\n  "),
      );
    }
  });
}
