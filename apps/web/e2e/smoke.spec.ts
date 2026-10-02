import { expect, test, type Page, type TestInfo } from "@playwright/test";

const OFFLINE = Boolean(process.env.E2E_OFFLINE);
const HIGHWAY_EVENT = "00000000-0000-4000-8000-000000000101";

/** Collect console errors, page errors and CSP violations; the app should produce none. */
function trackProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(msg.text());
  });
  page.on("pageerror", (err) => problems.push(err.message));
  return problems;
}

async function snap(page: Page, testInfo: TestInfo, name: string) {
  const dir = process.env.SCREENSHOT_DIR;
  const path = dir ? `${dir}/${testInfo.project.name}-${name}.png` : testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
}

async function expectMapRendered(page: Page) {
  if (OFFLINE) return;
  const map = page.locator("[data-map-status]").first();
  await expect(map).toHaveAttribute("data-map-status", "ready", { timeout: 25_000 });
  // The canvas must actually occupy screen space, not just exist.
  const canvas = map.locator("canvas.maplibregl-canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(200);
  expect(box?.width ?? 0).toBeGreaterThan(200);
  await expect
    .poll(async () => Number((await map.getAttribute("data-visible-markers")) ?? 0), { timeout: 20_000 })
    .toBeGreaterThan(0);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.addEventListener("securitypolicyviolation", (e) => {
      console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  });
});

test("onboarding leads to a map with markers and an event feed", async ({ page }, testInfo) => {
  const problems = trackProblems(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Know what's actually happening around you." })).toBeVisible();
  await snap(page, testInfo, "landing");
  await page.getByRole("button", { name: "Browse the map without location" }).click();
  await expect(page).toHaveURL(/#\/map$/);
  await expect(page.getByText(/These are not real current events/)).toBeVisible();
  await expectMapRendered(page);

  if (testInfo.project.name === "desktop") {
    const feed = page.getByRole("complementary", { name: "Events" });
    await expect(feed.getByRole("link").first()).toBeVisible();
    await expect(feed.getByText("Verified").first()).toBeVisible();
  } else {
    await expect(page.getByRole("region", { name: "Events in this area" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Report an event" })).toBeVisible();
  }
  await snap(page, testInfo, "map");
  expect(problems).toEqual([]);
});

test("event detail shows status, evidence, community and timeline", async ({ page }, testInfo) => {
  const problems = trackProblems(page);
  await page.goto(`/#/events/${HIGHWAY_EVENT}`);
  await expect(page.getByRole("heading", { level: 1, name: /US-101 northbound closed/ })).toBeVisible();
  await expect(page.getByText("Verified by current evidence.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Why Verity says this" })).toBeAttached();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeAttached();
  await expectMapRendered(page);
  await snap(page, testInfo, "detail");
  expect(problems).toEqual([]);
});

test("dark mode applies to the app and the map", async ({ page }, testInfo) => {
  const problems = trackProblems(page);
  await page.addInitScript(() => {
    localStorage.setItem("verity.onboarded", "true");
    localStorage.setItem("verity.theme", JSON.stringify("dark"));
  });
  await page.goto("/#/map");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectMapRendered(page);
  await snap(page, testInfo, "map-dark");
  expect(problems).toEqual([]);
});

test("demo report becomes an unverified community report", async ({ page }, testInfo) => {
  const problems = trackProblems(page);
  await page.goto("/#/report");
  await page.getByText("Crash", { exact: true }).click();
  await page.getByLabel("Short title").fill("Two cars collided on Folsom St");
  await snap(page, testInfo, "report");
  await page.getByRole("button", { name: "Submit report" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Two cars collided on Folsom St" })).toBeVisible();
  await expect(page.getByText("Community report — verification in progress")).toBeVisible();
  expect(problems).toEqual([]);
});

test("mobile sheet expands to show the event list", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile layout only");
  await page.addInitScript(() => localStorage.setItem("verity.onboarded", "true"));
  await page.goto("/#/map");
  const sheet = page.getByRole("region", { name: "Events in this area" });
  await page.getByRole("button", { name: "Expand event list" }).click();
  await expect(sheet.getByRole("link").first()).toBeVisible();
  await snap(page, testInfo, "sheet-half");
});
