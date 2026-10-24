import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Map overlays and the responsive sidebar (MapShell): what floats over the map
 * must not cover other controls or leave the screen, at any sheet size.
 */

const OFFLINE = Boolean(process.env.E2E_OFFLINE);

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, "element should be laid out").not.toBeNull();
  return box!;
}

async function mapReady(page: Page) {
  await expect(page.locator("[data-map-status]").first()).toHaveAttribute("data-map-status", "ready", { timeout: 25_000 });
}

/**
 * The required attribution keeps clear of Report and the map key, isn't clipped,
 * and every link (each wrapped line) and the toggle can actually be tapped.
 */
async function expectAttributionUsable(page: Page) {
  const attribution = page.locator(".maplibregl-ctrl-attrib");
  const a = await boxOf(attribution);
  expect(overlaps(a, await boxOf(page.getByRole("link", { name: "Report an event" })))).toBe(false);
  expect(overlaps(a, await boxOf(page.getByRole("button", { name: "Show map key" })))).toBe(false);
  const reach = await attribution.evaluate((box) => {
    const hits = (el: Element, r: DOMRect) => {
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!top && (top === el || el.contains(top));
    };
    const inner = box.querySelector(".maplibregl-ctrl-attrib-inner")!;
    const links = [...box.querySelectorAll("a")];
    const toggle = box.querySelector(".maplibregl-ctrl-attrib-button")!;
    return {
      clipped: inner.scrollHeight > inner.clientHeight + 1 || inner.scrollWidth > inner.clientWidth + 1,
      links: links.length,
      unreachable: links.flatMap((link) => [...link.getClientRects()].filter((r) => !hits(link, r))).length,
      toggle: hits(toggle, toggle.getBoundingClientRect()),
    };
  });
  expect(reach).toEqual({ clipped: false, links: reach.links, unreachable: 0, toggle: true });
  expect(reach.links).toBeGreaterThan(0);
}

/** Tap the map on a grid above the sheet until a marker opens its preview. */
async function openSomePreview(page: Page, sheetTop: number): Promise<Locator> {
  const preview = page.getByRole("dialog", { name: /^Preview:/ });
  await expect.poll(async () => Number((await page.locator("[data-map-status]").getAttribute("data-visible-markers")) ?? 0)).toBeGreaterThan(0);
  const { width } = page.viewportSize()!;
  for (let y = 240; y < sheetTop - 24; y += 24) {
    for (let x = 72; x < width - 72; x += 24) {
      await page.mouse.click(x, y);
      if (await preview.isVisible()) return preview;
    }
  }
  throw new Error("no marker found to tap");
}

test.describe("mobile map overlays", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile layout");

  test("a marker preview replaces the Report button and never leaves the screen", async ({ page }) => {
    test.skip(OFFLINE, "needs the basemap to render markers");
    await page.goto("/#/map");
    await mapReady(page);
    const sheet = page.getByRole("region", { name: "Events in this area" });
    const report = page.getByRole("link", { name: "Report an event" });
    await expect(report).toBeVisible();

    const preview = await openSomePreview(page, (await boxOf(sheet)).y);
    await expect(report).toHaveCount(0);
    const p = await boxOf(preview);
    const s = await boxOf(sheet);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y + p.height).toBeLessThanOrEqual(s.y);

    // A full sheet covers the map: neither the preview nor the Report button floats over it.
    const handle = sheet.getByRole("button", { name: "Expand event list" });
    await handle.click();
    await handle.click();
    await expect(sheet).toHaveAttribute("data-snap", "full");
    await expect(preview).toHaveCount(0);
    await expect(report).toHaveCount(0);

    // Back to peek: the preview returns; closing it brings the Report button back.
    await sheet.getByRole("button", { name: "Collapse event list" }).click();
    await expect(preview).toBeVisible();
    await preview.getByRole("button", { name: "Close preview" }).click();
    await expect(report).toBeVisible();
    // Once the sheet has finished collapsing, the button sits above it.
    await expect
      .poll(async () => {
        const r = await boxOf(report);
        return r.y + r.height <= (await boxOf(sheet)).y;
      })
      .toBe(true);
  });

  test("the attribution stays visible above the sheet, clear of the Report button", async ({ page }) => {
    await page.goto("/#/map");
    await mapReady(page);
    const sheet = await boxOf(page.getByRole("region", { name: "Events in this area" }));
    const attribution = await boxOf(page.locator(".maplibregl-ctrl-attrib"));
    const report = await boxOf(page.getByRole("link", { name: "Report an event" }));
    expect(attribution.y + attribution.height).toBeLessThanOrEqual(sheet.y + 1);
    expect(overlaps(attribution, report)).toBe(false);
    await expectAttributionUsable(page);
  });

  for (const width of [320, 375, 390, 412]) {
    test(`top overlays don't overlap at ${width}px when zoomed out`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.goto("/#/map");
      await mapReady(page);
      const hint = page.getByText("Zoom in to see events", { exact: true }).and(page.locator("p.rounded-full"));
      const zoomOut = page.locator(".maplibregl-ctrl-zoom-out");
      for (let i = 0; i < 12 && !(await hint.isVisible()); i++) {
        await zoomOut.click();
        await page.waitForTimeout(300);
      }
      await expect(hint).toBeVisible();
      const nearMe = page.getByRole("button", { name: "Near me" });
      await expect(nearMe).toBeVisible();
      const h = await boxOf(hint);
      expect(overlaps(h, await boxOf(nearMe))).toBe(false);
      expect(overlaps(h, await boxOf(page.locator(".maplibregl-ctrl-top-right .maplibregl-ctrl-group")))).toBe(false);
      expect(overlaps(h, await boxOf(page.getByRole("button", { name: "Show map key" })))).toBe(false);
      await expectAttributionUsable(page);
    });
  }

  // Larger text (125% root size) widens Near me, the hint and Report; the overlays still keep apart.
  for (const width of [320, 375, 390, 412]) {
    test(`overlays stay apart with 125% text at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.goto("/#/map");
      await page.addStyleTag({ content: "html { font-size: 125%; }" });
      await mapReady(page);
      await expectAttributionUsable(page);

      const hint = page.getByText("Zoom in to see events", { exact: true }).and(page.locator("p.rounded-full"));
      const zoomOut = page.locator(".maplibregl-ctrl-zoom-out");
      for (let i = 0; i < 12 && !(await hint.isVisible()); i++) {
        await zoomOut.click();
        await page.waitForTimeout(300);
      }
      await expect(hint).toBeVisible();
      const h = await boxOf(hint);
      expect(overlaps(h, await boxOf(page.getByRole("button", { name: "Near me" })))).toBe(false);
      expect(overlaps(h, await boxOf(page.locator(".maplibregl-ctrl-top-right .maplibregl-ctrl-group")))).toBe(false);
      expect(overlaps(h, await boxOf(page.getByRole("button", { name: "Show map key" })))).toBe(false);
    });
  }
});

test.describe("desktop sidebar width", () => {
  test.skip(({ isMobile }) => isMobile, "desktop layout");

  for (const [viewport, expected] of [
    [1024, 360],
    [1280, 384],
    [1360, 408],
    [1600, 440],
  ] as const) {
    test(`sidebar is ${expected}px at ${viewport}px and event details fit`, async ({ page }) => {
      await page.setViewportSize({ width: viewport, height: 800 });
      await page.goto("/#/map");
      const aside = page.getByRole("complementary", { name: "Events" });
      await expect.poll(async () => Math.round((await boxOf(aside)).width)).toBe(expected);
      await aside.locator("a[href^='#/events/']").first().click();
      await expect(aside.getByRole("heading", { level: 1 })).toBeVisible();
      // The header actions stay on screen and nothing in the panel scrolls sideways.
      await expect(aside.getByRole("button", { name: /^Follow/ })).toBeInViewport();
      await expect(aside.getByRole("button", { name: "Share" })).toBeInViewport();
      expect(await aside.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      const map = await boxOf(page.locator("[data-map-status]"));
      expect(Math.round(map.width)).toBe(viewport - expected);
    });
  }
});
