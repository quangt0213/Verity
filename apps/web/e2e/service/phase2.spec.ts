import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type BrowserContext, type FrameLocator, type Page, type Request } from "@playwright/test";
import { API_ORIGIN, APP_ORIGIN, HOST_URL, INTERNAL_TOKEN, OUTBOX_DIR } from "./constants";

/** Read the newest sign-in code emailed to `email` from the dev outbox. */
async function codeFor(email: string): Promise<string> {
  const safe = email.replace(/[^a-z0-9@._-]/gi, "_");
  for (let i = 0; i < 50; i++) {
    let files: string[] = [];
    try {
      files = readdirSync(OUTBOX_DIR).filter((f) => f.endsWith(`-${safe}.txt`)).sort();
    } catch {
      // Outbox not created yet.
    }
    const latest = files.at(-1);
    if (latest) {
      const match = /sign-in code is (\d{6})/.exec(readFileSync(join(OUTBOX_DIR, latest), "utf8"));
      if (match) return match[1]!;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`No sign-in email for ${email}`);
}

interface Session {
  context: BrowserContext;
  page: Page;
  app: FrameLocator;
  apiRequests: Request[];
}

/** Open the host page; the Verity app runs in a cross-site sandboxed iframe. */
async function openHost(context: BrowserContext): Promise<Session> {
  const page = await context.newPage();
  const apiRequests: Request[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith(API_ORIGIN)) apiRequests.push(r);
  });
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[browser] ${m.text()}`);
  });
  await page.goto(HOST_URL);
  return { context, page, app: page.frameLocator("iframe#verity"), apiRequests };
}

async function snap(page: Page, name: string) {
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/service-${name}.png` });
}

async function signInThroughDialog(app: FrameLocator, email: string, page?: Page) {
  const dialog = app.getByRole("dialog", { name: "Sign in to contribute" });
  await expect(dialog).toBeVisible();
  if (page) await snap(page, "sign-in-dialog");
  await dialog.getByLabel("Email address").fill(email);
  await dialog.getByRole("button", { name: "Email me a code" }).click();
  await dialog.getByLabel("6-digit code").fill(await codeFor(email));
  await dialog.getByRole("button", { name: "Sign in" }).click();
  await expect(dialog).toBeHidden();
}

function appFrameUrl(page: Page): string {
  return page.frames().find((f) => f.url().startsWith(APP_ORIGIN))?.url() ?? "";
}

async function internal(path: string) {
  const res = await fetch(`${API_ORIGIN}${path}`, { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } });
  expect(res.status).toBe(200);
  return res.json();
}

test("Phase 2: browse, sign in to report, confirm from a second account, follow, persist", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const alice = `alice-${stamp}@example.com`;
  const bob = `bob-${stamp}@example.com`;
  const title = `Road blocked near Market St and 5th St ${stamp}`;

  // 1–2. Open Verity in the (Maypop-like) host and browse API-backed events without an account.
  const a = await openHost(await browser.newContext());
  await a.app.getByRole("button", { name: "Browse the map without location" }).click();
  const feed = a.app.getByRole("complementary", { name: "Events" });
  await expect(feed.getByText("US-101 northbound closed near Cesar Chavez St")).toBeVisible();

  // 3–4. Try to report; Verity asks for its own sign-in, then submits the same report.
  await a.app.getByRole("link", { name: "Report", exact: true }).click();
  await a.app.getByText("Road closure", { exact: true }).click();
  await a.app.getByLabel("Short title").fill(title);
  await a.app.getByLabel(/Details/).fill("Police tape across all lanes, cars turning around.");
  await a.app.getByRole("button", { name: "Submit report" }).click();
  await signInThroughDialog(a.app, alice, a.page);

  // 5–8. The service validated and stored it; the canonical event is UNVERIFIED.
  const heading = a.app.getByRole("heading", { level: 1, name: title });
  await expect(heading).toBeVisible();
  await expect(a.app.getByText("Community report — verification in progress")).toBeVisible();
  await expect(a.app.getByText("Needs confirmation. Not yet supported by independent evidence.")).toBeVisible();
  const eventId = /#\/events\/([0-9a-f-]{36})/.exec(appFrameUrl(a.page))?.[1];
  expect(eventId, "event id in the app URL").toBeTruthy();

  // 9. A verification job is waiting in the outbox (nothing executes it in Phase 2).
  const { jobs } = await internal(`/internal/v1/events/${eventId}/verification-jobs`);
  expect(jobs).toEqual([expect.objectContaining({ reason: "NEW_REPORT", status: "pending" })]);

  // 13. Alice follows the event.
  await a.app.getByRole("button", { name: "Follow" }).click();
  await expect(a.app.getByRole("button", { name: "Following" })).toBeVisible();

  // 10–12. Bob, in a separate browser, confirms it after signing in.
  const b = await openHost(await browser.newContext());
  await b.page.goto(HOST_URL);
  await b.page.evaluate(() => undefined);
  const bobFrame = b.page.frames().find((f) => f.url().startsWith(APP_ORIGIN));
  await bobFrame?.goto(`${APP_ORIGIN}/#/events/${eventId}`);
  await expect(b.app.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await b.app.getByRole("button", { name: "Confirm" }).click();
  await signInThroughDialog(b.app, bob);
  await expect(b.app.getByRole("button", { name: "Confirmed" })).toHaveAttribute("aria-pressed", "true");
  await expect(b.app.getByText(/1 confirmation · 0 disputes/)).toBeVisible();
  await snap(b.page, "confirmed");
  // Still UNVERIFIED: community confirmations never verify an event.
  await expect(b.app.getByText("Needs confirmation. Not yet supported by independent evidence.")).toBeVisible();
  const { transitions } = await internal(`/internal/v1/events/${eventId}/transitions`);
  expect(transitions.map((t: { to: string }) => t.to)).toEqual(["UNVERIFIED"]);

  // 14–15. Refresh both browsers: sessions, the follow, the confirmation and the count persist.
  await a.page.reload();
  const aliceFrame = a.page.frames().find((f) => f.url().startsWith(APP_ORIGIN));
  await aliceFrame?.goto(`${APP_ORIGIN}/#/events/${eventId}`);
  await expect(a.app.getByRole("button", { name: "Following" })).toBeVisible();
  await expect(a.app.getByText(/1 confirmation · 0 disputes/)).toBeVisible();
  await aliceFrame?.goto(`${APP_ORIGIN}/#/following`);
  await expect(a.app.getByRole("heading", { name: /Followed events \(1\)/ })).toBeVisible();
  await expect(a.app.getByText(title)).toBeVisible();
  await snap(a.page, "following");

  await b.page.reload();
  await b.page.frames().find((f) => f.url().startsWith(APP_ORIGIN))?.goto(`${APP_ORIGIN}/#/events/${eventId}`);
  await expect(b.app.getByRole("button", { name: "Confirmed" })).toHaveAttribute("aria-pressed", "true");

  // 16. No request to the service ever carried Maypop identity or cookies; writes used Verity bearer tokens.
  for (const request of [...a.apiRequests, ...b.apiRequests]) {
    const headers = await request.allHeaders();
    expect(Object.keys(headers).some((k) => k.includes("maypop")), request.url()).toBe(false);
    expect(headers.cookie, request.url()).toBeUndefined();
    expect(request.postData() ?? "").not.toMatch(/maypop|user_id|created_by/i);
    if (["POST", "DELETE"].includes(request.method()) && !request.url().includes("/auth/email/")) {
      expect(headers.authorization, request.url()).toMatch(/^Bearer /);
    }
  }

  await a.context.close();
  await b.context.close();
});

test("an unexpected origin cannot use a valid session", async () => {
  const res = await fetch(`${API_ORIGIN}/api/v1/reports`, {
    method: "POST",
    headers: { origin: "https://evil.example", "content-type": "application/json", authorization: "Bearer whatever-token-value-000000" },
    body: "{}",
  });
  expect(res.status).toBe(403);
  const preflight = await fetch(`${API_ORIGIN}/api/v1/reports`, {
    method: "OPTIONS",
    headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
  });
  expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
});
