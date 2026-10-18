import { expect, test, type Page } from "@playwright/test";
import { fakeVerityApi, instrument } from "./harness";
import { syntheticEvents } from "./synthetic-events";

/**
 * Final acceptance (pass/fail): the basemap detail layer shows San Jose's
 * landmarks, parks, buildings and food around Plaza de César Chávez, in both
 * themes, and Verity's event markers still draw above the basemap POIs.
 * Uses live OpenFreeMap tiles (a few dozen ordinary requests per run).
 *
 *   PW_CHANNEL=chrome npx playwright test -c e2e/perf/playwright.perf.config.ts acceptance-sanjose
 */

const PLAZA = { lng: -121.889, lat: 37.3327 };

// Layer ids (src/features/map/basemap-detail.ts and map-layers.ts). Not imported:
// those modules read Vite's import.meta.env, which the test runner doesn't have.
const DETAIL = "verity-detail-";
const LAYER_GREEN = `${DETAIL}green`;
const LAYER_BUILDINGS = `${DETAIL}buildings`;
const LAYER_LANDMARKS = `${DETAIL}landmarks`;
const LAYER_POIS = `${DETAIL}pois`;
const LAYER_POINTS = "verity-points";
const LAYER_CLUSTERS = "verity-clusters";

type RenderedFeature = { layer: { id: string }; properties: Record<string, unknown> };
type MapHandle = {
  jumpTo(o: object): void;
  once(e: string, cb: () => void): void;
  queryRenderedFeatures(o: object): RenderedFeature[];
  getStyle(): { layers: Array<{ id: string }> };
};

async function rendered(page: Page, zoom: number, layers: string[]) {
  return page.evaluate(
    ({ lng, lat, zoom, layers }) =>
      new Promise<Record<string, { n: number; names: string[] }>>((resolve) => {
        const map = (window as unknown as { __verityMap: MapHandle }).__verityMap;
        map.once("idle", () => {
          const out: Record<string, { n: number; names: string[] }> = {};
          for (const id of layers) {
            const feats = map.queryRenderedFeatures({ layers: [id] });
            const names = [...new Set(feats.map((f) => String(f.properties.name ?? f.properties.class ?? "")).filter(Boolean))].slice(0, 6);
            out[id] = { n: feats.length, names };
          }
          resolve(out);
        });
        map.jumpTo({ center: [lng, lat], zoom });
      }),
    { ...PLAZA, zoom, layers },
  );
}

for (const theme of ["light", "dark"] as const) {
  test(`San Jose landmarks, parks, buildings and food render around Plaza de César Chávez (${theme})`, async ({ page }) => {
    await page.addInitScript((t) => {
      localStorage.setItem("verity.onboarded", "true");
      localStorage.setItem("verity.theme", JSON.stringify(t));
    }, theme);
    await instrument(page);
    // One event exactly at the plaza, so the marker competes with the basemap POIs.
    const [event] = syntheticEvents(1, [PLAZA.lng - 0.0001, PLAZA.lat - 0.0001, PLAZA.lng + 0.0001, PLAZA.lat + 0.0001], 7);
    await fakeVerityApi(page, [{ ...event!, coordinates: { latitude: PLAZA.lat, longitude: PLAZA.lng } }]);
    await page.goto("/#/map");
    await expect(page.locator("[data-map-status]").first()).toHaveAttribute("data-map-status", "ready", { timeout: 30_000 });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

    // Landmarks show from z13; parks and buildings at neighbourhood scale.
    const z14 = await rendered(page, 14, [LAYER_LANDMARKS, LAYER_GREEN, LAYER_BUILDINGS]);
    // Food from z15; at z16 the plaza's surroundings are dense with restaurants and cafés.
    const z16 = await rendered(page, 16, [LAYER_POIS, LAYER_GREEN, LAYER_BUILDINGS, LAYER_POINTS, LAYER_CLUSTERS]);
    console.log(theme, JSON.stringify({ z14, z16 }));

    expect(z14[LAYER_LANDMARKS]!.n, "landmarks at z14").toBeGreaterThan(0);
    expect(z14[LAYER_GREEN]!.n, "parks at z14").toBeGreaterThan(0);
    expect(z14[LAYER_BUILDINGS]!.n, "buildings at z14").toBeGreaterThan(0);
    expect(z16[LAYER_POIS]!.n, "POIs (food, shops, culture) at z16").toBeGreaterThan(3);
    expect(z16[LAYER_GREEN]!.n, "the plaza's green at z16").toBeGreaterThan(0);
    expect(z16[LAYER_BUILDINGS]!.n, "buildings at z16").toBeGreaterThan(0);
    // The reported event still renders as a marker among the POIs.
    expect(z16[LAYER_POINTS]!.n + z16[LAYER_CLUSTERS]!.n, "event marker at the plaza").toBeGreaterThan(0);

    // Verity's markers draw above every basemap detail layer.
    const order = await page.evaluate(() => (window as unknown as { __verityMap: MapHandle }).__verityMap.getStyle().layers.map((l) => l.id));
    const markerIndex = order.indexOf(LAYER_POINTS);
    for (const id of [LAYER_POIS, LAYER_LANDMARKS, LAYER_GREEN, LAYER_BUILDINGS]) {
      expect(order.indexOf(id), `${id} is in the style`).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(id), `${id} sits below the event markers`).toBeLessThan(markerIndex);
    }
  });
}
