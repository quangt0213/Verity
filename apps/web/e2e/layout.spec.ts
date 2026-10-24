import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Frame, type Page } from "@playwright/test";

/**
 * Layout regressions measured, not eyeballed: the document itself must never
 * scroll (each region scrolls on its own), and the map must always fill the
 * space next to the sidebar, standalone and inside a cross-site iframe like
 * Maypop's.
 */

const OFFLINE = Boolean(process.env.E2E_OFFLINE);

interface Layout {
  innerHeight: number;
  docScrollHeight: number;
  docClientHeight: number;
  docScrollTop: number;
  /**
   * Overflow of the app's top-level element. #root clips, so the document
   * alone would hide content escaping a scroller; this exposes it.
   */
  appOverflowY: number;
  appOverflowX: number;
  /** Every element other than the known scrollers that has been scrolled. */
  unexpectedScrolled: string[];
  map: { top: number; bottom: number; height: number } | null;
  canvas: { top: number; bottom: number; height: number } | null;
  asideScrollTop: number | null;
}

function measure(frame: Frame): Promise<Layout> {
  return frame.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
    };
    const se = document.scrollingElement!;
    const aside = document.querySelector("aside");
    const app = document.querySelector("#root > *")!;
    const unexpectedScrolled = [...document.querySelectorAll("*")]
      .filter((el) => (el.scrollTop > 0 || el.scrollLeft > 0) && el !== aside && !el.closest("main"))
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`);
    return {
      innerHeight: window.innerHeight,
      docScrollHeight: se.scrollHeight,
      docClientHeight: se.clientHeight,
      docScrollTop: se.scrollTop,
      appOverflowY: app.scrollHeight - app.clientHeight,
      appOverflowX: app.scrollWidth - app.clientWidth,
      unexpectedScrolled,
      map: box(document.querySelector("[data-map-status]")),
      canvas: box(document.querySelector("canvas.maplibregl-canvas")),
      asideScrollTop: aside ? aside.scrollTop : null,
    };
  });
}

async function expectPinned(frame: Frame, step: string) {
  const m = await measure(frame);
  expect(m.docScrollHeight, `${step}: document must not be scrollable`).toBeLessThanOrEqual(m.docClientHeight);
  expect(m.docScrollTop, `${step}: document scrollTop`).toBe(0);
  expect(m.appOverflowY, `${step}: content escaping its scroller (vertical)`).toBeLessThanOrEqual(0);
  expect(m.appOverflowX, `${step}: content escaping its scroller (horizontal)`).toBeLessThanOrEqual(1);
  expect(m.unexpectedScrolled, `${step}: only the sidebar may scroll`).toEqual([]);
  // The map reaches the bottom of the viewport: nothing blank underneath it.
  expect(m.map, `${step}: map container`).not.toBeNull();
  expect(m.map!.bottom, `${step}: map bottom`).toBe(m.innerHeight);
  expect(m.map!.top, `${step}: map top`).toBeGreaterThan(0);
  if (!OFFLINE && m.canvas) {
    expect(m.canvas.top, `${step}: canvas top`).toBe(m.map!.top);
    expect(m.canvas.bottom, `${step}: canvas bottom`).toBe(m.map!.bottom);
  }
  return m;
}

async function wheelOver(page: Page, frame: Frame, selector: string, deltaY: number, times = 8) {
  const box = await frame.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  for (let i = 0; i < times; i++) await page.mouse.wheel(0, deltaY);
  // Let smooth scrolling and scroll chaining settle.
  await page.waitForTimeout(500);
}

/** The sidebar flow that used to push the whole app up: scroll, hover, focus, open a detail, go back. */
async function exerciseSidebar(page: Page, frame: Frame) {
  const aside = frame.getByRole("complementary", { name: "Events" });
  const cards = aside.locator("a[href^='#/events/']");
  await expect(cards.first()).toBeVisible();
  // The demo feed is long enough that the sidebar has to scroll.
  expect(await cards.count()).toBeGreaterThan(5);
  await expectPinned(frame, "loaded");

  await cards.first().hover();
  await expect(cards.first()).toHaveClass(/ring-accent/);

  await wheelOver(page, frame, "aside", 600);
  const scrolled = await expectPinned(frame, "sidebar scrolled to the end");
  expect(scrolled.asideScrollTop ?? 0).toBeGreaterThan(0);
  // Keep wheeling past the end: this used to chain into the document.
  await wheelOver(page, frame, "aside", 600);
  await expectPinned(frame, "wheel past the end");

  await wheelOver(page, frame, "aside", -600);
  await cards.last().focus();
  await expectPinned(frame, "last card focused");

  await cards.last().press("Enter");
  await expect(aside.getByRole("heading", { level: 1 })).toBeVisible();
  await expectPinned(frame, "detail open");
  await wheelOver(page, frame, "aside", 600);
  await expectPinned(frame, "detail scrolled");

  await aside.getByRole("link", { name: "All events" }).click();
  await expect(cards.first()).toBeVisible();
  await expectPinned(frame, "back to the feed");
}

test.describe("desktop map layout", () => {
  test.skip(({ isMobile }) => isMobile, "desktop sidebar layout");

  test("sidebar scrolling never moves the document or uncovers space under the map", async ({ page }) => {
    await page.goto("/#/map");
    await exerciseSidebar(page, page.mainFrame());
  });

  test("the same holds inside a cross-site iframe, without scrolling the host page", async ({ page, baseURL }) => {
    const host = await startHost(`${baseURL}/#/map`);
    try {
      await page.goto(host.url);
      const frame = page.frame({ url: /#\/map/ });
      expect(frame).not.toBeNull();
      await exerciseSidebar(page, frame!);
      const hostScroll = await page.evaluate(() => document.scrollingElement!.scrollTop);
      expect(hostScroll, "scroll must not chain into the host page").toBe(0);
    } finally {
      await host.close();
    }
  });

  for (const width of [1024, 1280]) {
    test(`map fills the viewport at ${width}px and after a resize`, async ({ page }) => {
      await page.setViewportSize({ width, height: 760 });
      await page.goto("/#/map");
      await expect(page.getByRole("complementary", { name: "Events" }).locator("a[href^='#/events/']").first()).toBeVisible();
      await expectPinned(page.mainFrame(), `${width}px`);
      await page.setViewportSize({ width: width + 200, height: 900 });
      await expect.poll(async () => (await measure(page.mainFrame())).map?.bottom).toBe(900);
      // MapLibre resizes its canvas a frame after the container.
      await expect.poll(async () => (await measure(page.mainFrame())).canvas?.bottom).toBe(900);
      await expectPinned(page.mainFrame(), `${width}px resized`);
    });
  }
});

test("the document doesn't scroll on the mobile map either", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile layout");
  await page.goto("/#/map");
  await page.getByRole("button", { name: "Expand event list" }).click();
  const sheet = page.getByRole("region", { name: "Events in this area" });
  await expect(sheet.getByRole("link").first()).toBeVisible();
  const m = await measure(page.mainFrame());
  expect(m.docScrollHeight).toBeLessThanOrEqual(m.docClientHeight);
  expect(m.docScrollTop).toBe(0);
  expect(m.appOverflowY).toBeLessThanOrEqual(0);
  expect(m.appOverflowX).toBeLessThanOrEqual(1);
});

test.describe("mobile map inside a Maypop-like cross-site iframe", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile layout");

  /** Only the sheet's own list may scroll; the app document and the host page never do. */
  async function expectFramePinned(page: Page, frame: Frame, step: string) {
    const m = await measure(frame);
    expect(m.docScrollHeight, `${step}: app document must not be scrollable`).toBeLessThanOrEqual(m.docClientHeight);
    expect(m.docScrollTop, `${step}: app document scrollTop`).toBe(0);
    expect(m.appOverflowY, `${step}: content escaping its scroller (vertical)`).toBeLessThanOrEqual(0);
    expect(m.appOverflowX, `${step}: content escaping its scroller (horizontal)`).toBeLessThanOrEqual(1);
    expect(m.map, `${step}: map container`).not.toBeNull();
    // On mobile the map runs under the sheet to the bottom of the frame.
    expect(m.map!.bottom, `${step}: map bottom`).toBe(m.innerHeight);
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop), `${step}: host page scrollTop`).toBe(0);
  }

  for (const [width, height] of [
    [375, 667],
    [390, 844],
  ] as const) {
    test(`sheet and detail scrolling stay inside the app at ${width}x${height}`, async ({ page, baseURL }) => {
      await page.setViewportSize({ width, height });
      const host = await startHost(`${baseURL}/#/map`);
      try {
        await page.goto(host.url);
        const frame = page.frame({ url: /#\/map/ });
        expect(frame).not.toBeNull();
        const sheet = frame!.getByRole("region", { name: "Events in this area" });
        await expect(sheet.getByRole("link").first()).toBeAttached();
        await expectFramePinned(page, frame!, "loaded");

        // Full sheet, then scroll its list past the end: this must not chain into the frame or the host.
        // DOM clicks: Playwright's own click scrolls the HOST page to bring the
        // still-animating handle into view, which would hide (or fake) chaining.
        // The handle's pointer and keyboard paths are covered by the sheet tests.
        const handle = sheet.getByRole("button", { name: "Expand event list" });
        await handle.evaluate((el) => (el as HTMLElement).click());
        await expect(sheet).toHaveAttribute("data-snap", "half");
        await handle.evaluate((el) => (el as HTMLElement).click());
        await expect(sheet).toHaveAttribute("data-snap", "full");
        const list = sheet.locator(":scope > div.overflow-y-auto");
        // Scroll once the sheet has finished growing and the cards are in.
        await expect
          .poll(() => list.evaluate((el) => (el.scrollTo(0, el.scrollHeight), el.scrollTop)), { message: "the sheet's list scrolls" })
          .toBeGreaterThan(0);
        await wheelOver(page, frame!, "[role=region][aria-label='Events in this area'] > div.overflow-y-auto", 600);
        await expectFramePinned(page, frame!, "sheet list scrolled past its end");

        // Open an event from the sheet and scroll its detail.
        await sheet.getByRole("link").first().evaluate((el) => (el as HTMLElement).click());
        const detail = frame!.getByRole("region", { name: "Event details" });
        await expect(detail.getByRole("heading", { level: 1 })).toBeVisible();
        await detail.locator(":scope > div").last().evaluate((el) => el.scrollTo(0, el.scrollHeight));
        await expectFramePinned(page, frame!, "detail scrolled");
      } finally {
        await host.close();
      }
    });
  }
});

test.describe("mobile bottom sheet", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile layout");

  /** Bottom edge of the sheet's last header control (the "Show ended" toggle) vs the sheet's own bottom. */
  const peekGeometry = (page: Page) =>
    page.getByRole("region", { name: "Events in this area" }).evaluate((sheet) => {
      const controls = [...sheet.querySelectorAll("[role=group] button, [role=group] label")];
      const last = controls[controls.length - 1]!.getBoundingClientRect();
      return { controlBottom: Math.round(last.bottom), sheetBottom: Math.round(sheet.getBoundingClientRect().bottom), innerHeight: window.innerHeight };
    });

  test("the peeking sheet keeps its whole header visible when the text is larger", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 700 });
    await page.goto("/#/map");
    // Larger text wraps the filter chips onto more lines than the fixed peek height had room for.
    await page.addStyleTag({ content: "html { font-size: 20px }" });
    await expect(page.getByRole("region", { name: "Events in this area" })).toHaveAttribute("data-snap", "peek");
    await expect.poll(async () => (await peekGeometry(page)).controlBottom <= (await peekGeometry(page)).sheetBottom).toBe(true);
  });

  test("sheet controls stay clear of the bottom safe area (home indicator)", async ({ page, context }) => {
    const cdp = await context.newCDPSession(page);
    const inset = 34;
    try {
      await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets: { top: 47, bottom: inset, left: 0, right: 0 } } as never);
    } catch {
      test.skip(true, "this browser can't emulate safe-area insets");
    }
    await page.goto("/#/map");
    const sheet = page.getByRole("region", { name: "Events in this area" });
    await expect(sheet).toHaveCSS("padding-bottom", `${inset}px`);
    const g = await peekGeometry(page);
    expect(g.controlBottom).toBeLessThanOrEqual(g.innerHeight - inset);
    // The Report button sits above the (taller) sheet once both finish animating to the measured peek.
    const report = page.getByRole("link", { name: "Report an event" });
    await expect
      .poll(async () => {
        const fab = await report.boundingBox();
        const sheetBox = await sheet.boundingBox();
        return fab !== null && sheetBox !== null && fab.y + fab.height <= sheetBox.y;
      })
      .toBe(true);
  });

  test("the handle stays a keyboard-operable button through every size", async ({ page }) => {
    await page.goto("/#/map");
    const sheet = page.getByRole("region", { name: "Events in this area" });
    const handle = sheet.getByRole("button", { name: "Expand event list" });
    await expect(handle).toHaveAttribute("aria-expanded", "false");
    await handle.focus();
    await page.keyboard.press("Enter");
    await expect(sheet).toHaveAttribute("data-snap", "half");
    await expect(handle).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Enter");
    await expect(sheet).toHaveAttribute("data-snap", "full");
    await expect(sheet.getByRole("button", { name: "Collapse event list" })).toBeFocused();
    await page.keyboard.press("Space");
    await expect(sheet).toHaveAttribute("data-snap", "peek");
  });

  test("dragging the handle snaps the sheet to the nearest size", async ({ page }) => {
    await page.goto("/#/map");
    const sheet = page.getByRole("region", { name: "Events in this area" });
    const handle = sheet.getByRole("button", { name: "Expand event list" });
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const viewport = page.viewportSize()!;
    // Drag up to about the middle of the screen, in small steps like a finger.
    const target = viewport.height * 0.5;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, target, { steps: 15 });
    await page.mouse.up();
    await expect(sheet).toHaveAttribute("data-snap", "half");
    await expect.poll(async () => Math.round((await sheet.boundingBox())!.height)).toBeGreaterThan(viewport.height * 0.4);
  });
});

for (const route of ["/report", "/settings", "/following"]) {
  test(`${route} scrolls inside its <main>, never the document, on a small phone`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(`/#${route}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Scroll the page to its end the way a user would.
    await page.locator("main").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const m = await measure(page.mainFrame());
    expect(m.docScrollHeight, "document must not be scrollable").toBeLessThanOrEqual(m.docClientHeight);
    expect(m.docScrollTop).toBe(0);
    // sr-only text in the form used to be positioned against the viewport and extend the document.
    expect(m.appOverflowY, "content escaping <main>").toBeLessThanOrEqual(0);
    expect(m.appOverflowX).toBeLessThanOrEqual(1);
  });
}

test("the welcome page scrolls inside its own region on a short screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 480 });
  await page.goto("/#/welcome");
  const browse = page.getByRole("button", { name: "Browse the map without location" });
  await browse.scrollIntoViewIfNeeded();
  await expect(browse).toBeInViewport();
  const m = await measure(page.mainFrame());
  expect(m.docScrollHeight).toBeLessThanOrEqual(m.docClientHeight);
  expect(m.docScrollTop).toBe(0);
  // Here <main> is the app's top-level element and the scroller itself.
  const main = await page.locator("main").evaluate((el) => ({ y: el.scrollHeight > el.clientHeight, x: el.scrollWidth - el.clientWidth }));
  expect(main.y).toBe(true);
  expect(main.x).toBeLessThanOrEqual(1);
});

/**
 * A stand-in for the Maypop host on another site (localhost vs 127.0.0.1), on a
 * free port, laid out at device width like a mobile web page. The host page itself is scrollable (content below the iframe), so
 * scroll chaining out of the iframe would show up as host scrollTop.
 */
async function startHost(appUrl: string): Promise<{ url: string; close: () => Promise<void> }> {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Host</title>
<style>body{margin:0}header{height:56px}iframe{border:0;display:block;width:100%;height:calc(100vh - 56px);background:#fff}footer{height:400px}</style></head>
<body><header>Host</header><iframe title="Verity" src="${appUrl}"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-popups-to-escape-sandbox allow-downloads"></iframe><footer></footer></body></html>`;
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://localhost:${port}/`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
