import { expect, test, type Page } from "@playwright/test";

/**
 * Event detail, in a real browser against the production bundle (demo data):
 * STATUS, WHY VERITY SAYS THIS, SOURCES and COMMUNITY INPUT are separate and
 * readable; no scores, no internal or provider vocabulary; dates keep their
 * precision; copies of one report count once. Runs in the desktop and the
 * mobile (Pixel 7) projects, in light and dark mode.
 */

const id = (n: number) => `00000000-0000-4000-8000-000000000${n}`;
const VERIFIED_HIGHWAY = id(101);
const LIKELY_BRIDGE = id(103);
const CONFLICTING_TRANSIT = id(105);
const STALE_LANE = id(110);
const CONCERT = id(112);

/** Words a user must never see: scores, internal identifiers, pipeline and provider vocabulary. */
const FORBIDDEN = /\d\s?%|confidence|probabilit|lineage|lin_[0-9a-f]|canonical|retrieval|rule[_ ]id|verified_primary|nimble|task_run|extraction_metadata|agent_id|\bagent\b|\bAI\b/i;

function trackProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(msg.text());
  });
  page.on("pageerror", (err) => problems.push(err.message));
  return problems;
}

async function openEvent(page: Page, eventId: string, theme: "light" | "dark" = "light") {
  await page.addInitScript((t) => {
    localStorage.setItem("verity.onboarded", "true");
    localStorage.setItem("verity.theme", JSON.stringify(t));
  }, theme);
  await page.goto(`/#/events/${eventId}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

const section = (page: Page, name: string) => page.getByRole("region", { name });

async function expectNoForbiddenText(page: Page) {
  const text = await page.locator("article").innerText();
  expect(text).not.toMatch(FORBIDDEN);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI}`));
  });
});

test("VERIFIED: status, a plain explanation, an official primary source, and grouped copies", async ({ page }) => {
  const problems = trackProblems(page);
  await openEvent(page, VERIFIED_HIGHWAY);
  await expect(page.getByText("Verified by current evidence.")).toBeVisible();

  const why = section(page, "Why Verity says this");
  await expect(why).toContainText("Supported by an official transportation source");
  await expect(why).toContainText("Community answers are shown separately and don't verify an event.");

  const sources = section(page, "Sources");
  await sources.scrollIntoViewIfNeeded();
  await expect(sources.getByText("Official source").first()).toBeVisible();
  await expect(sources.getByText("Primary source").first()).toBeVisible();
  await expect(sources.getByText(/Published \d+ min ago/).first()).toBeVisible();
  // Four pages, three independent sources: the repeated report is grouped under its source.
  await expect(sources).toContainText("3 independent sources from 4 pages. Copies of the same report count once.");
  await expect(sources).toContainText("Also reported by 1 other page using the same underlying report. They count as one source.");
  await sources.getByRole("button", { name: "Show it" }).click();
  await expect(sources.getByText(/Repeats reporting from Demo/)).toBeVisible();

  await expectNoForbiddenText(page);
  expect(problems).toEqual([]);
});

test("LIKELY: the explanation says why it is not yet verified", async ({ page }) => {
  await openEvent(page, LIKELY_BRIDGE);
  await expect(page.getByRole("img", { name: /Likely/i }).or(page.getByText("Likely", { exact: true })).first()).toBeVisible();
  const why = section(page, "Why Verity says this");
  await expect(why).not.toBeEmpty();
  await expect(why.locator("p").first()).not.toHaveText("");
  await expectNoForbiddenText(page);
});

test("CONFLICTING: supporting and contradicting sources are shown apart", async ({ page }) => {
  await openEvent(page, CONFLICTING_TRANSIT);
  const sources = section(page, "Sources");
  await sources.scrollIntoViewIfNeeded();
  await expect(sources.getByRole("heading", { name: /^Supporting \(\d+\)$/ })).toBeVisible();
  await expect(sources.getByRole("heading", { name: /^Contradicting \(\d+\)$/ })).toBeVisible();
  await expectNoForbiddenText(page);
});

test("dates keep their precision: a date-only listing shows a date, an exact time shows an age", async ({ page }) => {
  await openEvent(page, CONCERT);
  const sources = section(page, "Sources");
  await sources.scrollIntoViewIfNeeded();
  await expect(sources.getByText(/^Published [A-Z][a-z]{2} \d{1,2}( \d{4})? \(date only\)$/)).toBeVisible();
  await expect(sources.getByText(/^Published \d+ h ago$/)).toBeVisible();
  // The date-only listing never turns into a clock-based age.
  await expect(sources.getByText(/Published \d+ days ago/)).toHaveCount(0);
});

test("stale evidence is marked out of date", async ({ page }) => {
  await openEvent(page, STALE_LANE);
  const sources = section(page, "Sources");
  await sources.scrollIntoViewIfNeeded();
  await expect(sources.getByText("Out of date").first()).toBeVisible();
});

test("community input is its own section and never presented as verification", async ({ page }) => {
  await openEvent(page, VERIFIED_HIGHWAY);
  const community = section(page, "Community input");
  await community.scrollIntoViewIfNeeded();
  await expect(community).toContainText("it never verifies an event on its own");
  // The four sections appear in order: status (header), why, sources, community.
  const order = await page.locator("article h2").allInnerTexts();
  expect(order.slice(0, 3)).toEqual(["Why Verity says this", "Sources", "Community input"]);
});

for (const theme of ["light", "dark"] as const) {
  test(`${theme} mode renders the evidence readably`, async ({ page }) => {
    await openEvent(page, VERIFIED_HIGHWAY, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const sources = section(page, "Sources");
    await sources.scrollIntoViewIfNeeded();
    await expect(sources.getByText("Official source").first()).toBeVisible();
    // Relative luminance of the page background and of quoted source text: readable contrast in both themes.
    const [text, background] = await sources.locator("blockquote").first().evaluate((el) => {
      const lum = (color: string) => {
        const [r, g, b] = (color.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3).map((v) => Number(v) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      return [lum(getComputedStyle(el).color), lum(getComputedStyle(document.body).backgroundColor)];
    });
    if (theme === "dark") expect(background).toBeLessThan(0.2);
    else expect(background).toBeGreaterThan(0.8);
    const contrast = (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
    expect(contrast).toBeGreaterThanOrEqual(4.5);
  });
}

test("fits the screen without horizontal scrolling (mobile and desktop)", async ({ page }) => {
  await openEvent(page, VERIFIED_HIGHWAY);
  const sources = section(page, "Sources");
  await sources.scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const box = await sources.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
});
