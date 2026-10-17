import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page, Request } from "@playwright/test";
import { PERF_API_ORIGIN } from "./constants";
import type { SyntheticEvent } from "./synthetic-events";

/**
 * Measurement helpers for e2e/perf. Everything here observes the app from
 * outside: a fake Verity service (page.route), Playwright network events, a
 * minimal React DevTools hook that counts which components rendered in each
 * commit, and listeners on the map exposed by perf-mode builds.
 */

const RESULTS_DIR = resolve(import.meta.dirname, "../../test-results/perf");

export function saveResults(name: string, data: unknown) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(resolve(RESULTS_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Fake Verity service
// ---------------------------------------------------------------------------

export interface ApiCall {
  url: string;
  bbox: number[] | null;
  /** ms since page navigation start (performance.timeOrigin) of the browser. */
  receivedAt: number;
  respondedAt: number;
  returned: number;
}

export async function fakeVerityApi(page: Page, world: SyntheticEvent[], latencyMs = 150) {
  const calls: ApiCall[] = [];
  const origin = Date.now();
  await page.route(`${PERF_API_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const receivedAt = Date.now() - origin;
    const headers = { "access-control-allow-origin": "*", "content-type": "application/json" };
    if (url.pathname !== "/api/v1/events") {
      await route.fulfill({ status: 404, headers, body: JSON.stringify({ error: { code: "not_found", message: "Not found" } }) });
      return;
    }
    const bbox = url.searchParams.get("bbox")?.split(",").map(Number) ?? null;
    const inside = bbox
      ? world.filter(
          (e) =>
            e.coordinates.longitude >= bbox[0]! &&
            e.coordinates.latitude >= bbox[1]! &&
            e.coordinates.longitude <= bbox[2]! &&
            e.coordinates.latitude <= bbox[3]!,
        )
      : world;
    const events = inside.slice(0, 500);
    await new Promise((r) => setTimeout(r, latencyMs));
    calls.push({ url: url.pathname + url.search, bbox, receivedAt, respondedAt: Date.now() - origin, returned: events.length });
    await route.fulfill({
      status: 200,
      headers,
      body: JSON.stringify({ events, generated_at: new Date().toISOString(), truncated: inside.length > events.length }),
    });
  });
  return { calls, clockStart: origin };
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export type ResourceKind = "tile" | "tilejson" | "style" | "glyph" | "sprite" | "raster" | "api" | "script" | "css" | "other";

export interface NetRecord {
  url: string;
  kind: ResourceKind;
  startedAt: number;
  durationMs: number | null;
  status: number | null;
  bytes: number | null;
  failure: string | null;
}

export function classify(url: string): ResourceKind {
  if (url.startsWith(PERF_API_ORIGIN)) return "api";
  if (/\.pbf(\?|$)/.test(url) && /\/(fonts|glyphs)\//.test(url)) return "glyph";
  if (/\.(pbf|mvt)(\?|$)/.test(url) || /\/tiles\/[\w-]+\/\d+\/\d+\/\d+$/.test(url)) return "tile";
  if (/sprite|\/sprites\//.test(url)) return "sprite";
  if (/\.(png|webp|jpg)(\?|$)/.test(url) && !url.includes("127.0.0.1")) return "raster";
  if (/\/styles\/|style\.json/.test(url)) return "style";
  if (/\.js(\?|$)/.test(url)) return "script";
  if (/\.css(\?|$)/.test(url)) return "css";
  if (/tiles\.openfreemap\.org\/planet$|tiles\.json|\/tilejson/.test(url)) return "tilejson";
  return "other";
}

export function captureNetwork(page: Page) {
  const records: NetRecord[] = [];
  const byRequest = new Map<Request, NetRecord>();
  const t0 = Date.now();
  page.on("request", (req) => {
    if (req.url().startsWith("data:") || req.url().startsWith("blob:")) return;
    const rec: NetRecord = {
      url: req.url(),
      kind: classify(req.url()),
      startedAt: Date.now() - t0,
      durationMs: null,
      status: null,
      bytes: null,
      failure: null,
    };
    records.push(rec);
    byRequest.set(req, rec);
  });
  page.on("requestfinished", async (req) => {
    const rec = byRequest.get(req);
    if (!rec) return;
    rec.durationMs = Date.now() - t0 - rec.startedAt;
    try {
      const response = await req.response();
      rec.status = response?.status() ?? null;
      rec.bytes = (await req.sizes()).responseBodySize;
    } catch {
      // The page may have navigated away.
    }
  });
  page.on("requestfailed", (req) => {
    const rec = byRequest.get(req);
    if (!rec) return;
    rec.durationMs = Date.now() - t0 - rec.startedAt;
    rec.failure = req.failure()?.errorText ?? "failed";
  });
  return {
    records,
    /** Records started at or after `since` (ms on this capture's clock). */
    since: (since: number) => records.filter((r) => r.startedAt >= since),
    now: () => Date.now() - t0,
  };
}

export function summarizeNetwork(records: NetRecord[]) {
  const out: Record<string, { requests: number; bytes: number; failed: number; duplicates: number; p50ms: number | null; maxMs: number | null }> = {};
  const groups = new Map<ResourceKind, NetRecord[]>();
  for (const r of records) groups.set(r.kind, [...(groups.get(r.kind) ?? []), r]);
  for (const [kind, recs] of groups) {
    const durations = recs.map((r) => r.durationMs).filter((d): d is number => d !== null).sort((a, b) => a - b);
    const urls = recs.map((r) => r.url);
    out[kind] = {
      requests: recs.length,
      bytes: recs.reduce((sum, r) => sum + (r.bytes ?? 0), 0),
      failed: recs.filter((r) => r.failure).length,
      duplicates: urls.length - new Set(urls).size,
      p50ms: durations.length ? durations[Math.floor(durations.length / 2)]! : null,
      maxMs: durations.length ? durations[durations.length - 1]! : null,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// In-page instrumentation
// ---------------------------------------------------------------------------

export interface CommitStats {
  t: number;
  functionRenders: number;
  mapView: number;
  feed: number;
  eventCards: number;
  shell: number;
}

/** Installs, before any app code runs: React commit counting, map listeners, long-task and setData tracking. */
export async function instrument(page: Page) {
  await page.addInitScript(() => {
    type Fiber = {
      type: unknown;
      tag: number;
      flags: number;
      child: Fiber | null;
      sibling: Fiber | null;
      return: Fiber | null;
      alternate: Fiber | null;
    };
    const perf = {
      marks: {} as Record<string, number>,
      commits: [] as CommitStats[],
      longtasks: [] as { start: number; duration: number }[],
      setData: [] as { t: number; source: string; features: number; syncMs: number }[],
      sourceLoaded: [] as { t: number; source: string }[],
      styleLoads: 0,
      types: {} as Record<string, unknown>,
    };
    Object.assign(window, { __perf: perf });
    const mark = (name: string) => (perf.marks[name] ??= performance.now());

    // A minimal stand-in for the React DevTools hook. Production React calls
    // onCommitFiberRoot after every commit. A function component rendered in
    // this commit if it is new or has PerformedWork (flag 1); subtrees whose
    // child pointer did not change were not visited by React (DevTools uses
    // the same rule).
    const PERFORMED_WORK = 1;
    const analyze = (root: { current: Fiber }) => {
      const t = perf.types;
      const stats: CommitStats = { t: performance.now(), functionRenders: 0, mapView: 0, feed: 0, eventCards: 0, shell: 0 };
      const stack: Fiber[] = [root.current];
      while (stack.length) {
        const f = stack.pop()!;
        if (typeof f.type === "function" && (f.alternate === null || (f.flags & PERFORMED_WORK) !== 0)) {
          stats.functionRenders++;
          if (f.type === t.mapView) stats.mapView++;
          if (f.type === t.feed) stats.feed++;
          if (f.type === t.eventCard) stats.eventCards++;
          if (f.type === t.shell) stats.shell++;
        }
        if (f.alternate === null || f.child !== f.alternate.child) {
          for (let c = f.child; c; c = c.sibling) stack.push(c);
        }
      }
      perf.commits.push(stats);
    };
    Object.assign(window, {
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        supportsFiber: true,
        isDisabled: false,
        renderers: new Map(),
        inject(renderer: unknown) {
          this.renderers.set(this.renderers.size + 1, renderer);
          return this.renderers.size;
        },
        checkDCE() {},
        onScheduleFiberRoot() {},
        onCommitFiberRoot(_id: number, root: { current: Fiber }) {
          try {
            analyze(root);
          } catch {
            // Never break the app under test.
          }
        },
        onCommitFiberUnmount() {},
        onPostCommitFiberRoot() {},
      },
    });

    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) perf.longtasks.push({ start: e.startTime, duration: e.duration });
      }).observe({ type: "longtask", buffered: true });
    } catch {
      // longtask unsupported
    }

    type MapLike = {
      once: (e: string, cb: () => void) => void;
      on: (e: string, cb: (ev: { sourceId?: string; isSourceLoaded?: boolean; dataType?: string }) => void) => void;
      getSource: (id: string) => object | undefined;
    };
    let current: MapLike | undefined;
    Object.defineProperty(window, "__verityMap", {
      configurable: true,
      get: () => current,
      set(map: MapLike) {
        current = map;
        mark("mapCreated");
        map.once("load", () => mark("load"));
        map.once("idle", () => mark("firstIdle"));
        const wrapSetData = () => {
          const source = map.getSource("verity-events") as { setData?: (d: unknown) => unknown } | undefined;
          const proto = source && (Object.getPrototypeOf(source) as { setData: (d: unknown) => unknown; __perfWrapped?: boolean });
          if (proto && !proto.__perfWrapped) {
            const original = proto.setData;
            proto.setData = function (this: { id: string }, data: unknown) {
              const start = performance.now();
              const result = original.call(this, data);
              const features = (data as { features?: unknown[] } | undefined)?.features?.length ?? -1;
              perf.setData.push({ t: start, source: this.id, features, syncMs: performance.now() - start });
              return result;
            };
            proto.__perfWrapped = true;
          }
        };
        map.on("style.load", () => {
          perf.styleLoads++;
          mark("styleLoad");
          // MapView adds its sources in its own style.load listener, which runs after this one.
          setTimeout(wrapSetData);
        });
        map.on("sourcedata", (ev) => {
          if (ev.sourceId === "verity-events" && ev.isSourceLoaded) perf.sourceLoaded.push({ t: performance.now(), source: ev.sourceId });
        });
      },
    });

    // Frame sampler for camera animations.
    let frames: number[] = [];
    let sampling = false;
    const tick = (t: number) => {
      if (!sampling) return;
      frames.push(t);
      requestAnimationFrame(tick);
    };
    Object.assign(window, {
      __perfFrames: {
        start() {
          frames = [];
          sampling = true;
          requestAnimationFrame(tick);
        },
        stop() {
          sampling = false;
          const gaps = frames.slice(1).map((t, i) => t - frames[i]!);
          gaps.sort((a, b) => a - b);
          return {
            frames: frames.length,
            maxGapMs: gaps.length ? Math.round(gaps[gaps.length - 1]!) : null,
            p95GapMs: gaps.length ? Math.round(gaps[Math.floor(gaps.length * 0.95)]!) : null,
          };
        },
      },
    });
  });
}

/** Resolve component identities from DOM anchors once the map shell has rendered. */
export async function identifyComponents(page: Page) {
  return page.evaluate(() => {
    type Fiber = { type: unknown; tag: number; return: Fiber | null };
    const fiberOf = (el: Element | null): Fiber | null => {
      if (!el) return null;
      const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
      return key ? ((el as unknown as Record<string, Fiber>)[key] ?? null) : null;
    };
    const ownerFn = (el: Element | null) => {
      let f = fiberOf(el);
      while (f && typeof f.type !== "function") f = f.return;
      return f?.type ?? null;
    };
    const aside = document.querySelector('aside[aria-label="Events"]');
    const types: Record<string, unknown> = {
      mapView: ownerFn(document.querySelector("[data-map-status]")),
      feed: ownerFn(aside?.firstElementChild ?? null),
      shell: ownerFn(aside?.parentElement?.parentElement ?? null),
    };
    // EventCard: the outermost function component between a card link and its <li>.
    let f = fiberOf(aside?.querySelector("li > a") ?? null);
    let card: unknown = null;
    while (f && !(f.tag === 5 && f.type === "li")) {
      if (typeof f.type === "function") card = f.type;
      f = f.return;
    }
    types.eventCard = card;
    const perf = (window as unknown as { __perf: { types: Record<string, unknown> } }).__perf;
    perf.types = types;
    return Object.fromEntries(Object.entries(types).map(([k, v]) => [k, v !== null]));
  });
}

export interface PerfSnapshot {
  marks: Record<string, number>;
  commits: CommitStats[];
  longtasks: { start: number; duration: number }[];
  setData: { t: number; source: string; features: number; syncMs: number }[];
  sourceLoaded: { t: number; source: string }[];
  styleLoads: number;
  now: number;
}

export function snapshot(page: Page): Promise<PerfSnapshot> {
  return page.evaluate(() => {
    const p = (window as unknown as { __perf: Omit<PerfSnapshot, "now"> }).__perf;
    return {
      marks: p.marks,
      commits: p.commits,
      longtasks: p.longtasks,
      setData: p.setData,
      sourceLoaded: p.sourceLoaded,
      styleLoads: p.styleLoads,
      now: performance.now(),
    };
  });
}

/** Sum commit stats in [from, to) (performance.now() clock of the page). */
export function commitsBetween(snap: PerfSnapshot, from: number, to = Infinity) {
  const inRange = snap.commits.filter((c) => c.t >= from && c.t < to);
  return {
    commits: inRange.length,
    functionRenders: inRange.reduce((s, c) => s + c.functionRenders, 0),
    mapView: inRange.reduce((s, c) => s + c.mapView, 0),
    feed: inRange.reduce((s, c) => s + c.feed, 0),
    eventCards: inRange.reduce((s, c) => s + c.eventCards, 0),
    shell: inRange.reduce((s, c) => s + c.shell, 0),
  };
}

export function longtasksBetween(snap: PerfSnapshot, from: number, to = Infinity) {
  const lt = snap.longtasks.filter((l) => l.start >= from && l.start < to);
  return { count: lt.length, totalMs: Math.round(lt.reduce((s, l) => s + l.duration, 0)), maxMs: Math.round(Math.max(0, ...lt.map((l) => l.duration))) };
}

export type CameraAction =
  | { kind: "panBy"; x: number; y: number; duration: number }
  | { kind: "flyTo"; lng: number; lat: number; zoom: number; duration: number }
  | { kind: "jumpTo"; lng: number; lat: number; zoom: number };

export interface MoveTiming {
  /** ms from arming to the camera starting to move. */
  moveStartMs: number | null;
  moveEndMs: number | null;
  /** ms from arming to the map's next `idle`: all tiles loaded and drawn ("visually complete"). */
  idleMs: number;
  armedAt: number;
  frames: { frames: number; maxGapMs: number | null; p95GapMs: number | null };
}

/**
 * Arm before triggering a camera move (in-page action or a UI click), then
 * await the result. Waits for movestart, then the next `idle`.
 */
export async function armMove(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as {
      __verityMap: { once: (e: string, cb: () => void) => void };
      __perfFrames: { start: () => void; stop: () => unknown };
      __perfMove: Record<string, unknown>;
    };
    const state: Record<string, unknown> = { armedAt: performance.now() };
    w.__perfMove = state;
    w.__perfFrames.start();
    w.__verityMap.once("movestart", () => {
      state.moveStartAt = performance.now();
      w.__verityMap.once("moveend", () => {
        state.moveEndAt = performance.now();
        w.__verityMap.once("idle", () => {
          state.idleAt = performance.now();
          state.frames = w.__perfFrames.stop();
        });
      });
    });
  });
}

export async function awaitMove(page: Page, timeoutMs = 60_000): Promise<MoveTiming> {
  await page.waitForFunction(() => (window as unknown as { __perfMove?: { idleAt?: number } }).__perfMove?.idleAt !== undefined, null, {
    timeout: timeoutMs,
  });
  return page.evaluate(() => {
    const s = (window as unknown as { __perfMove: Record<string, number> & { frames: MoveTiming["frames"] } }).__perfMove;
    const rel = (t: number | undefined) => (t === undefined ? null : Math.round(t - s.armedAt!));
    return { armedAt: s.armedAt!, moveStartMs: rel(s.moveStartAt), moveEndMs: rel(s.moveEndAt), idleMs: rel(s.idleAt)!, frames: s.frames };
  });
}

export async function camera(page: Page, action: CameraAction) {
  await page.evaluate((a) => {
    const map = (window as unknown as { __verityMap: Record<string, (...args: unknown[]) => void> }).__verityMap;
    if (a.kind === "panBy") map.panBy!([a.x, a.y], { duration: a.duration });
    if (a.kind === "flyTo") map.flyTo!({ center: [a.lng, a.lat], zoom: a.zoom, duration: a.duration });
    if (a.kind === "jumpTo") map.jumpTo!({ center: [a.lng, a.lat], zoom: a.zoom });
  }, action);
}

export async function timedMove(page: Page, action: CameraAction, timeoutMs?: number) {
  await armMove(page);
  await camera(page, action);
  return awaitMove(page, timeoutMs);
}

export function round(n: number | undefined | null): number | null {
  return n === undefined || n === null ? null : Math.round(n);
}

// ---------------------------------------------------------------------------
// CPU profile (main thread), aggregated by script and top functions
// ---------------------------------------------------------------------------

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  hitCount?: number;
}

export async function startProfile(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  return async () => {
    const { profile } = (await cdp.send("Profiler.stop")) as unknown as {
      profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number };
    };
    await cdp.detach();
    const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
    const selfUs = new Map<number, number>();
    profile.samples.forEach((id, i) => selfUs.set(id, (selfUs.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
    const byScript = new Map<string, number>();
    const byFn = new Map<string, number>();
    for (const [id, us] of selfUs) {
      const frame = nodes.get(id)!.callFrame;
      const script = frame.url ? (frame.url.split("/").pop() ?? frame.url).replace(/-[\w-]{8}\.js$/, ".js") : `(${frame.functionName || "native"})`;
      byScript.set(script, (byScript.get(script) ?? 0) + us);
      const fn = `${script}:${frame.functionName || "anon"}@${frame.lineNumber}:${frame.columnNumber}`;
      byFn.set(fn, (byFn.get(fn) ?? 0) + us);
    }
    const ms = (us: number) => Math.round(us / 100) / 10;
    return {
      totalMs: ms(profile.endTime - profile.startTime),
      byScript: Object.fromEntries([...byScript].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, ms(v)])),
      topFunctions: [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${ms(v)} ${k}`),
    };
  };
}

// ---------------------------------------------------------------------------
// Simulated slow network for basemap requests
// ---------------------------------------------------------------------------

export interface LinkProfile {
  /** Added before the first byte (edge-miss or mobile round trip). */
  rttMs: number;
  /** Shared downstream bandwidth in kilobits per second. */
  kbps: number;
}

/**
 * Replays basemap responses through one shared link (FIFO): each response
 * waits rttMs, then occupies the link for bytes / bandwidth. Requests the map
 * aborts before their turn don't consume the link. Bodies are kept in memory
 * for this run only, so A/B runs in one process don't refetch from the
 * provider (like an ordinary browser cache).
 */
export async function throttleBasemap(page: Page, profile: LinkProfile, memo: Map<string, { body: Buffer; headers: Record<string, string>; status: number }>) {
  let linkFreeAt = 0;
  const aborted = new WeakSet<Request>();
  page.on("requestfailed", (req) => aborted.add(req));
  await page.route(/tiles\.openfreemap\.org|\.pbf(\?|$)/, async (route) => {
    const req = route.request();
    const url = req.url();
    let cached = memo.get(url);
    if (!cached) {
      const response = await route.fetch();
      const headers = Object.fromEntries(Object.entries(response.headers()).filter(([k]) => !/^(content-encoding|content-length|transfer-encoding)$/i.test(k)));
      cached = { body: await response.body(), headers, status: response.status() };
      memo.set(url, cached);
    }
    await new Promise((r) => setTimeout(r, profile.rttMs));
    if (aborted.has(req)) return;
    const start = Math.max(Date.now(), linkFreeAt);
    const transferMs = (cached.body.length * 8) / profile.kbps;
    linkFreeAt = start + transferMs;
    await new Promise((r) => setTimeout(r, Math.max(0, linkFreeAt - Date.now())));
    if (aborted.has(req)) return;
    await route.fulfill({ status: cached.status, headers: cached.headers, body: cached.body }).catch(() => undefined);
  });
}
