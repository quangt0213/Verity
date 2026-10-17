import { expect, test, type Page } from "@playwright/test";
import {
  armMove,
  awaitMove,
  captureNetwork,
  commitsBetween,
  fakeVerityApi,
  identifyComponents,
  instrument,
  longtasksBetween,
  round,
  saveResults,
  snapshot,
  startProfile,
  summarizeNetwork,
  timedMove,
  type CameraAction,
} from "./harness";
import { syntheticEvents } from "./synthetic-events";

/**
 * M0/M2 measurements: initial load (cold and warm cache), pans, fly-tos,
 * React/MapLibre update overhead with many events, and route chunks.
 * Results: test-results/perf/<label>-*.json. PERF_LABEL names the run.
 */
const LABEL = process.env.PERF_LABEL ?? "run";
const THEME = process.env.PERF_THEME === "dark" ? "dark" : "light";

const SF: [number, number, number, number] = [-122.53, 37.69, -122.33, 37.84];
const WORLD = [...syntheticEvents(2000, SF, 1), ...syntheticEvents(300, [-118.35, 33.95, -118.15, 34.12], 2)];

async function openMap(page: Page) {
  await page.addInitScript((theme) => {
    localStorage.setItem("verity.onboarded", "true");
    localStorage.setItem("verity.theme", JSON.stringify(theme));
  }, THEME);
  await page.goto("/#/map");
  await waitFirstIdle(page);
}

async function waitFirstIdle(page: Page) {
  await page.waitForFunction(() => (window as unknown as { __perf?: { marks: { firstIdle?: number } } }).__perf?.marks.firstIdle !== undefined, null, {
    timeout: 60_000,
  });
  await expect
    .poll(async () => Number((await page.locator("[data-map-status]").getAttribute("data-visible-markers")) ?? 0), { timeout: 30_000 })
    .toBeGreaterThan(0);
}

async function navTiming(page: Page) {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const paint = Object.fromEntries(performance.getEntriesByType("paint").map((p) => [p.name, Math.round(p.startTime)]));
    return { domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? 0), loadEvent: Math.round(nav?.loadEventEnd ?? 0), ...paint };
  });
}

test("initial load: cold then warm cache", async ({ page }) => {
  await instrument(page);
  const api = await fakeVerityApi(page, WORLD);
  let net = captureNetwork(page);
  await openMap(page);
  const cold = await snapshot(page);
  const coldResult = {
    nav: await navTiming(page),
    marks: Object.fromEntries(Object.entries(cold.marks).map(([k, v]) => [k, round(v)])),
    styleLoads: cold.styleLoads,
    network: summarizeNetwork(net.records),
    firstTile: net.records.find((r) => r.kind === "tile"),
    tilesBeforeIdle: net.records.filter((r) => r.kind === "tile").length,
    api: api.calls.map((c) => ({ ...c, url: undefined })),
    longtasks: longtasksBetween(cold, 0),
    commits: commitsBetween(cold, 0),
    setData: cold.setData.map((s) => ({ ...s, t: round(s.t), syncMs: Number(s.syncMs.toFixed(2)) })),
  };

  net = captureNetwork(page);
  api.calls.length = 0;
  await page.reload();
  await waitFirstIdle(page);
  const warm = await snapshot(page);
  const warmResult = {
    nav: await navTiming(page),
    marks: Object.fromEntries(Object.entries(warm.marks).map(([k, v]) => [k, round(v)])),
    network: summarizeNetwork(net.records),
    tileStatuses: [...new Set(net.records.filter((r) => r.kind === "tile").map((r) => r.status))],
    api: api.calls.map((c) => ({ ...c, url: undefined })),
    longtasks: longtasksBetween(warm, 0),
  };
  saveResults(`${LABEL}-load`, { theme: THEME, cold: coldResult, warm: warmResult });
  console.log(JSON.stringify({ cold: { marks: coldResult.marks, nav: coldResult.nav, network: coldResult.network }, warm: { marks: warmResult.marks, network: warmResult.network } }, null, 1));
});

test("pans and fly-tos to new areas", async ({ page, context }) => {
  await instrument(page);
  const api = await fakeVerityApi(page, WORLD);
  const net = captureNetwork(page);
  await openMap(page);
  await identifyComponents(page);

  const moves: Array<[string, CameraAction | "near-me"]> = [
    ["pan east (new tiles)", { kind: "panBy", x: 700, y: 0, duration: 400 }],
    ["pan south (new tiles)", { kind: "panBy", x: 0, y: 500, duration: 400 }],
    ["pan back west (new tiles)", { kind: "panBy", x: -700, y: 0, duration: 400 }],
    ["pan back north (cached tiles)", { kind: "panBy", x: 0, y: -500, duration: 400 }],
    ["app 'Near me' ease to Los Angeles z14", "near-me"],
    ["flyTo Oakland z14 (1.5 s)", { kind: "flyTo", lng: -122.2712, lat: 37.8044, zoom: 14, duration: 1500 }],
    ["flyTo SF Mission z15 (1.5 s)", { kind: "flyTo", lng: -122.4194, lat: 37.7599, zoom: 15, duration: 1500 }],
    ["zoom out to z12 (cached parents)", { kind: "flyTo", lng: -122.4194, lat: 37.7599, zoom: 12, duration: 600 }],
  ];

  const results = [];
  for (const [name, action] of moves) {
    // Let the previous move's event fetch and marker update finish.
    await page.waitForTimeout(1500);
    const since = net.now();
    const apiBefore = api.calls.length;
    const stopProfile = await startProfile(page);
    let timing;
    if (action === "near-me") {
      await context.grantPermissions(["geolocation"]);
      await context.setGeolocation({ latitude: 34.0522, longitude: -118.2437 });
      await armMove(page);
      await page.getByRole("button", { name: "Near me" }).click();
      timing = await awaitMove(page);
    } else {
      timing = await timedMove(page, action);
    }
    // Wait for the event list round trip triggered by this move.
    await page.waitForTimeout(1200);
    const cpu = await stopProfile();
    const snap = await snapshot(page);
    const moveNet = net.since(since);
    const tiles = moveNet.filter((r) => r.kind === "tile");
    const apiCalls = api.calls.slice(apiBefore);
    const setData = snap.setData.filter((s) => s.t >= timing.armedAt && s.source === "verity-events");
    results.push({
      name,
      idleMs: timing.idleMs,
      moveStartMs: timing.moveStartMs,
      moveEndMs: timing.moveEndMs,
      afterMoveEndMs: timing.idleMs - (timing.moveEndMs ?? 0),
      frames: timing.frames,
      tiles: { requests: tiles.length, bytes: tiles.reduce((s, r) => s + (r.bytes ?? 0), 0), failed: tiles.filter((r) => r.failure).length, maxMs: Math.max(0, ...tiles.map((r) => r.durationMs ?? 0)) },
      network: summarizeNetwork(moveNet),
      api: apiCalls.map((c) => ({ latencyMs: c.respondedAt - c.receivedAt, returned: c.returned })),
      setData: setData.map((s) => ({ features: s.features, syncMs: Number(s.syncMs.toFixed(2)), atMs: round(s.t - timing.armedAt) })),
      commits: commitsBetween(snap, timing.armedAt),
      longtasks: longtasksBetween(snap, timing.armedAt),
      cpu,
    });
  }
  const all = summarizeNetwork(net.records);
  saveResults(`${LABEL}-moves`, { theme: THEME, moves: results, totalNetwork: all });
  console.log(JSON.stringify(results.map((r) => ({ name: r.name, idleMs: r.idleMs, afterMoveEndMs: r.afterMoveEndMs, tiles: r.tiles, api: r.api, setData: r.setData.length, commits: r.commits })), null, 1));
});

test("update overhead with 500 events in view", async ({ page }) => {
  await instrument(page);
  await fakeVerityApi(page, WORLD);
  await openMap(page);
  const ids = await identifyComponents(page);
  expect(ids).toEqual({ mapView: true, feed: true, shell: true, eventCard: true });
  await page.waitForTimeout(1000);

  // 1. Idle for one useNow() tick (30 s) plus margin.
  let from = (await snapshot(page)).now;
  await page.waitForTimeout(31_000);
  let snap = await snapshot(page);
  const idle31s = { commits: commitsBetween(snap, from), longtasks: longtasksBetween(snap, from), setData: snap.setData.filter((s) => s.t >= from).length };

  // 2. Hover across 8 feed cards (highlights the marker on the map).
  from = snap.now;
  const cards = page.locator('aside[aria-label="Events"] li > a');
  for (let i = 0; i < 8; i++) await cards.nth(i).hover();
  await page.mouse.move(900, 400);
  await page.waitForTimeout(500);
  snap = await snapshot(page);
  const hover8 = { commits: commitsBetween(snap, from), longtasks: longtasksBetween(snap, from), setData: snap.setData.filter((s) => s.t >= from).length };

  // 3. A small pan that keeps the same events in the response.
  from = snap.now;
  await timedMove(page, { kind: "panBy", x: 40, y: 0, duration: 200 });
  await page.waitForTimeout(1500);
  snap = await snapshot(page);
  const smallPan = {
    commits: commitsBetween(snap, from),
    longtasks: longtasksBetween(snap, from),
    setData: snap.setData.filter((s) => s.t >= from).map((s) => ({ source: s.source, features: s.features, syncMs: Number(s.syncMs.toFixed(2)) })),
  };

  // 4. MapLibre cost of setData + clustering for 500/1000/2000 points, and of
  //    the diagnostic queryRenderedFeatures on idle.
  const sourceCost = await page.evaluate(async () => {
    type Src = { setData: (d: unknown) => void };
    const map = (window as unknown as { __verityMap: { getSource: (id: string) => Src; once: (e: string, cb: () => void) => void; queryRenderedFeatures: (o: unknown) => unknown[] } }).__verityMap;
    const perf = (window as unknown as { __perf: { sourceLoaded: { t: number }[] } }).__perf;
    const out = [];
    for (const n of [500, 1000, 2000, 500]) {
      const features = Array.from({ length: n }, (_, i) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [-122.53 + ((i * 7919) % 2000) / 10000, 37.69 + ((i * 104729) % 1500) / 10000] },
        properties: { id: `x${i}`, group: ["urgent", "developing", "unverified", "planned", "inactive"][i % 5], category: "crash", urgent: i % 5 === 0 ? 1 : 0, sort: i % 5 },
      }));
      const before = perf.sourceLoaded.length;
      const start = performance.now();
      map.getSource("verity-events").setData({ type: "FeatureCollection", features });
      const sync = performance.now() - start;
      await new Promise<void>((resolve) => {
        const check = () => (perf.sourceLoaded.length > before ? resolve() : setTimeout(check, 5));
        check();
      });
      const loaded = performance.now() - start;
      await new Promise<void>((resolve) => map.once("idle", () => resolve()));
      const idle = performance.now() - start;
      const q0 = performance.now();
      const rendered = map.queryRenderedFeatures({ layers: ["verity-points", "verity-clusters"] }).length;
      const qrf = performance.now() - q0;
      out.push({ n, syncMs: Number(sync.toFixed(2)), sourceLoadedMs: Math.round(loaded), idleMs: Math.round(idle), qrfMs: Number(qrf.toFixed(2)), rendered });
    }
    return out;
  });

  saveResults(`${LABEL}-overhead`, { theme: THEME, idle31s, hover8, smallPan, sourceCost });
  console.log(JSON.stringify({ idle31s, hover8, smallPan, sourceCost }, null, 1));
});

test("chunks loaded per route", async ({ browser }) => {
  const routes = ["/#/welcome", "/#/map", "/#/report", "/#/settings"];
  const out: Record<string, { files: string[]; scriptBytes: number; cssBytes: number }> = {};
  for (const route of routes) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem("verity.onboarded", "true"));
    await fakeVerityApi(page, WORLD);
    const net = captureNetwork(page);
    await page.goto(route);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(1500);
    const local = net.records.filter((r) => r.url.startsWith("http://127.0.0.1") && (r.kind === "script" || r.kind === "css"));
    out[route] = {
      files: local.map((r) => `${r.url.split("/").pop()} ${r.bytes ?? "?"}`),
      scriptBytes: local.filter((r) => r.kind === "script").reduce((s, r) => s + (r.bytes ?? 0), 0),
      cssBytes: local.filter((r) => r.kind === "css").reduce((s, r) => s + (r.bytes ?? 0), 0),
    };
    await context.close();
  }
  saveResults(`${LABEL}-routes`, out);
  console.log(JSON.stringify(out, null, 1));
});
