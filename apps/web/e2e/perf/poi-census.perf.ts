import { test } from "@playwright/test";
import { fakeVerityApi, instrument } from "./harness";

/** Which OpenMapTiles POI classes/ranks the tiles carry around a viewpoint (informs the detail layer's filters). */
test("poi census", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("verity.onboarded", "true"));
  await instrument(page);
  await fakeVerityApi(page, []);
  await page.goto("/#/map");
  await page.waitForFunction(() => (window as unknown as { __perf?: { marks: { firstIdle?: number } } }).__perf?.marks.firstIdle !== undefined);
  for (const [name, lng, lat, zoom] of [["mission", -122.4194, 37.7599, 16.5], ["union-square", -122.4075, 37.788, 15]] as const) {
    const census = await page.evaluate(
      ({ lng, lat, zoom }) =>
        new Promise((resolve) => {
          type F = { properties: Record<string, unknown> };
          const map = (window as unknown as { __verityMap: { jumpTo(o: object): void; once(e: string, cb: () => void): void; querySourceFeatures(s: string, o: object): F[] } }).__verityMap;
          map.once("idle", () => {
            const feats = map.querySourceFeatures("openmaptiles", { sourceLayer: "poi" });
            const byClass: Record<string, { n: number; minRank: number; subclasses: string[] }> = {};
            for (const f of feats) {
              const c = String(f.properties.class);
              const e = (byClass[c] ??= { n: 0, minRank: 999, subclasses: [] });
              e.n++;
              e.minRank = Math.min(e.minRank, Number(f.properties.rank));
              const sub = String(f.properties.subclass);
              if (!e.subclasses.includes(sub) && e.subclasses.length < 6) e.subclasses.push(sub);
            }
            resolve({ total: feats.length, byClass });
          });
          map.jumpTo({ center: [lng, lat], zoom });
        }),
      { lng, lat, zoom },
    );
    console.log(name, JSON.stringify(census));
  }
});
