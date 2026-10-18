import { expect, test } from "@playwright/test";

/** Planned events can carry the schedule the reporter knows; disruptions never show the fields. */

const localValue = (hoursFromNow: number) => {
  const d = new Date(Date.now() + hoursFromNow * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

test("schedule fields appear only for planned categories and are submitted with the report", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (err) => problems.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(msg.text());
  });
  await page.goto("/#/report");

  await page.getByText("Crash", { exact: true }).click();
  await expect(page.getByLabel("Starts")).toHaveCount(0);

  await page.getByText("Festival", { exact: true }).click();
  const group = page.getByRole("group", { name: /When is it scheduled/ });
  await expect(group).toBeVisible();
  await expect(group).toHaveAccessibleDescription(/planned, not that it's happening/);

  await page.getByLabel("Short title").fill("Lantern night market");
  // An end before the start is caught before anything is sent.
  await page.getByLabel("Starts").fill(localValue(48));
  await page.getByLabel("Ends").fill(localValue(24));
  await page.getByRole("button", { name: "Submit report" }).click();
  await expect(page.getByText("Must be after the start")).toBeVisible();
  await expect(page.getByLabel("Ends")).toHaveAttribute("aria-invalid", "true");

  await page.getByLabel("Ends").fill(localValue(54));
  await page.getByRole("button", { name: "Submit report" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Lantern night market" })).toBeVisible();
  await expect(page.getByText("Community report — verification in progress")).toBeVisible();
  expect(problems).toEqual([]);
});
