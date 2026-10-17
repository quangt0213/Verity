import { test, type BrowserContext, type Page } from "@playwright/test";
import { armMove, awaitMove, captureNetwork, fakeVerityApi, instrument, longtasksBetween, saveResults, snapshot, startProfile, timedMove, type CameraAction } from "./harness";
import { syntheticEvents } from "./synthetic-events";

/**
 * A/B runs for MapLibre settings. PERF_VARIANT is JSON:
 *   {"workerCount": 2, "mapOptions": {"fadeDuration": 150}}
 *   {"mapOptions": {"detail": false}}   (basemap without Verity's detail layer)
 * Perf-mode builds read these through window.__verityWorkerCount and
 * window.__verityMapOptions. PERF_LABEL names the output file.
 */
const LABEL = process.env.PERF_LABEL ?? "exp";
const VARIANT = JSON.parse(process.env.PERF_VARIANT ?? "{}") as { workerCount?: number; mapOptions?: object };
/** e.g. 4 to approximate a mid-range phone's CPU on the measured (cached) pass. */
const CPU_THROTTLE = Number(process.env.PERF_CPU_THROTTLE ?? 1);
const WORLD = syntheticEvents(800, [-122.53, 37.69, -122.33, 37.84], 1);

const MOVES: Array<[string, CameraAction | "near-me"]> = [
  ["pan east", { kind: "panBy", x: 700, y: 0, duration: 400 }],
  ["pan south", { kind: "panBy", x: 0, y: 500, duration: 400 }],
  ["near-me LA", "near-me"],
  ["flyTo Oakland z14", { kind: "flyTo", lng: -122.2712, lat: 37.8044, zoom: 14, duration: 1500 }],
  ["flyTo Mission z15", { kind: "flyTo", lng: -122.4194, lat: 37.7599, zoom: 15, duration: 1500 }],
];

async function prepare(page: Page) {
  await page.addInitScript((variant) => {
    localStorage.setItem("verity.onboarded", "true");
    localStorage.setItem("verity.theme", JSON.stringify("light"));
    Object.assign(window, { __verityWorkerCount: variant.workerCount, __verityMapOptions: variant.mapOptions });
  }, VARIANT);
  await instrument(page);
  await fakeVerityApi(page, WORLD);
}

async function firstIdle(page: Page) {
  await page.waitForFunction(() => (window as unknown as { __perf?: { marks: { firstIdle?: number } } }).__perf?.marks.firstIdle !== undefined, null, {
    timeout: 60_000,
  });
  const snap = await snapshot(page);
  return {
    load: Math.round(snap.marks.load! - snap.marks.mapCreated!),
    idle: Math.round(snap.marks.firstIdle! - snap.marks.mapCreated!),
    longtaskMs: longtasksBetween(snap, 0).totalMs,
  };
}

async function runMoves(page: Page, context: BrowserContext) {
  const net = captureNetwork(page);
  const out = [];
  for (const [name, action] of MOVES) {
    await page.waitForTimeout(1200);
    const since = net.now();
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
    const cpu = await stopProfile();
    const tiles = net.since(since).filter((r) => r.kind === "tile");
    const snap = await snapshot(page);
    out.push({
      name,
      idleMs: timing.idleMs,
      afterMoveEndMs: timing.idleMs - (timing.moveEndMs ?? 0),
      maxFrameGapMs: timing.frames.maxGapMs,
      tileRequests: tiles.length,
      tileFailed: tiles.filter((r) => r.failure).length,
      tileKB: Math.round(tiles.reduce((s, r) => s + (r.bytes ?? 0), 0) / 1024),
      longtaskMs: longtasksBetween(snap, timing.armedAt).totalMs,
      maplibreCpuMs: cpu.byScript["maplibre.js"] ?? 0,
    });
  }
  return out;
}

test("variant: warm-cache loads and moves, then network moves", async ({ browser }) => {
  // Warm the HTTP cache with one full pass, then measure with a fresh map.
  const warmContext = await browser.newContext();
  const warmup = await warmContext.newPage();
  await prepare(warmup);
  await warmup.goto("/#/map");
  await firstIdle(warmup);
  await runMoves(warmup, warmContext);
  await warmup.close();

  const loads = [];
  const page = await warmContext.newPage();
  await prepare(page);
  if (CPU_THROTTLE > 1) {
    const cdp = await warmContext.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
  }
  for (let i = 0; i < 5; i++) {
    if (i === 0) await page.goto("/#/map");
    else await page.reload();
    loads.push(await firstIdle(page));
  }
  const cachedMoves = await runMoves(page, warmContext);
  await warmContext.close();

  const coldContext = await browser.newContext();
  const fresh = await coldContext.newPage();
  await prepare(fresh);
  await fresh.goto("/#/map");
  const coldLoad = await firstIdle(fresh);
  const networkMoves = await runMoves(fresh, coldContext);
  await coldContext.close();

  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const result = {
    variant: VARIANT,
    warmLoadMedian: { load: median(loads.map((l) => l.load)), idle: median(loads.map((l) => l.idle)), longtaskMs: median(loads.map((l) => l.longtaskMs)) },
    loads,
    cachedMoves,
    coldLoad,
    networkMoves,
  };
  saveResults(`exp-${LABEL}`, result);
  console.log(JSON.stringify(result));
});
