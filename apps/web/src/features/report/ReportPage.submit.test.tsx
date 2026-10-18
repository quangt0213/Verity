import type { AuthSession } from "@verity/contracts";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createHttpApi } from "../../api/http-client";
import { createSessionStore } from "../../api/session-store";
import { renderWithApp } from "../../test/render";
import { ReportPage } from "./ReportPage";
import { SCHEDULE_NOT_ACCEPTED } from "./submit-errors";

/**
 * Submitting through the real HTTP client against a fake service: what goes on
 * the wire, and what the form does when the service says no.
 */

const BASE = "https://api.verity.example";
const REPORTS = `${BASE}/api/v1/reports`;

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
}

const session: AuthSession = {
  token: "signed.session-token-abcdefghijklmnop",
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  user: { email_masked: "a•••@example.com", created_at: "2026-10-01T15:00:00Z" },
};

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The answer the running (pre-schedule) service gives: its strict schema rejects the unknown top-level keys. */
const OLD_API_REJECTION = {
  error: { code: "validation_failed", message: "Some fields are invalid.", request_id: "req-1", fields: { _: "Unexpected field" } },
};

function setup(reply: (body: Record<string, unknown>) => Response | Promise<Response>) {
  const bodies: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url !== REPORTS) return json({ error: { code: "not_found", message: "Not found" } }, 404);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    return reply(body);
  });
  const sessionStore = createSessionStore(memoryStorage());
  sessionStore.set(session);
  const api = createHttpApi(BASE, { fetch: fetchMock as unknown as typeof fetch, sessionStore });
  const user = userEvent.setup();
  renderWithApp(<ReportPage />, { api, path: "/report" });
  const reportCalls = () => fetchMock.mock.calls.filter(([url]) => url === REPORTS).length;
  return { user, bodies, reportCalls };
}

/** A `datetime-local` value `days` from now, in local time. */
function localInput(days: number, hour: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setHours(hour, 0, 0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

async function fillConcert(user: ReturnType<typeof userEvent.setup>, schedule: boolean) {
  await user.click(screen.getByRole("radio", { name: "Concert" }));
  await user.type(screen.getByLabelText("Short title"), "Outdoor concert in the park");
  if (schedule) {
    await user.type(screen.getByLabelText("Starts"), localInput(2, 19));
    await user.type(screen.getByLabelText("Ends"), localInput(2, 22));
  }
}

/** Long enough for any automatic retry to have happened. */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("report request body", () => {
  it("omits the schedule keys entirely when the schedule is blank", async () => {
    const { user, bodies } = setup(() => json({ event_id: "evt-1", outcome: "created" }, 201));
    await fillConcert(user, false);
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(Object.keys(bodies[0]!).sort()).toEqual(["category", "location", "title"]);
  });

  it("omits a schedule typed for a planned category after switching to an unplanned one", async () => {
    const { user, bodies } = setup(() => json({ event_id: "evt-1", outcome: "created" }, 201));
    await fillConcert(user, true);
    await user.click(screen.getByRole("radio", { name: "Road closure" }));
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).not.toHaveProperty("scheduled_start_at");
    expect(bodies[0]).not.toHaveProperty("scheduled_end_at");
  });

  it("sends the schedule as exact instants when given", async () => {
    const { user, bodies } = setup(() => json({ event_id: "evt-1", outcome: "created" }, 201));
    await fillConcert(user, true);
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]!.scheduled_start_at).toBe(new Date(localInput(2, 19)).toISOString());
    expect(bodies[0]!.scheduled_end_at).toBe(new Date(localInput(2, 22)).toISOString());
  });
});

describe("a report the service doesn't accept", () => {
  it("400 from a service without schedules: says so, keeps the schedule, sends once", async () => {
    const { user, reportCalls } = setup(() => json(OLD_API_REJECTION, 400));
    await fillConcert(user, true);
    await user.click(screen.getByRole("button", { name: "Submit report" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(SCHEDULE_NOT_ACCEPTED);
    const starts = screen.getByLabelText("Starts");
    expect(starts).toHaveValue(localInput(2, 19));
    expect(screen.getByLabelText("Ends")).toHaveValue(localInput(2, 22));
    expect(screen.getByLabelText("Short title")).toHaveValue("Outdoor concert in the park");
    expect(starts).toHaveAttribute("aria-invalid", "true");
    expect(starts).toHaveFocus();
    await settle();
    expect(reportCalls()).toBe(1);
  });

  it("the user can clear the schedule and resubmit; only then is it sent without one", async () => {
    let call = 0;
    const { user, bodies } = setup(() => (++call === 1 ? json(OLD_API_REJECTION, 400) : json({ event_id: "evt-1", outcome: "created" }, 201)));
    await fillConcert(user, true);
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    await screen.findByRole("alert");
    await user.clear(screen.getByLabelText("Starts"));
    await user.clear(screen.getByLabelText("Ends"));
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[0]).toHaveProperty("scheduled_start_at");
    expect(bodies[1]).not.toHaveProperty("scheduled_start_at");
    expect(bodies[1]).not.toHaveProperty("scheduled_end_at");
  });

  it("5xx: explains the report wasn't sent, keeps every field, sends once", async () => {
    const { user, reportCalls } = setup(() => json({ error: { code: "internal", message: "Internal error" } }, 500));
    await fillConcert(user, true);
    await user.click(screen.getByRole("button", { name: "Submit report" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Verity is temporarily unavailable, so your report wasn't sent.");
    expect(alert).toHaveTextContent("Everything you entered is still here.");
    expect(alert).toHaveTextContent("you can clear the schedule and try again");
    expect(alert).toHaveFocus();
    expect(screen.getByLabelText("Starts")).toHaveValue(localInput(2, 19));
    expect(screen.getByLabelText("Ends")).toHaveValue(localInput(2, 22));
    expect(screen.getByLabelText("Short title")).toHaveValue("Outdoor concert in the park");
    expect(screen.getByRole("radio", { name: "Concert" })).toBeChecked();
    await settle();
    expect(reportCalls()).toBe(1);
  });

  it("network failure: says the connection failed, keeps every field, sends once", async () => {
    const { user, reportCalls } = setup(() => Promise.reject(new TypeError("Failed to fetch")));
    await fillConcert(user, true);
    await user.click(screen.getByRole("button", { name: "Submit report" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't reach Verity, so your report wasn't sent.");
    expect(screen.getByLabelText("Starts")).toHaveValue(localInput(2, 19));
    expect(screen.getByLabelText("Short title")).toHaveValue("Outdoor concert in the park");
    await settle();
    expect(reportCalls()).toBe(1);
  });

  it("a 400 on a field the form shows marks that field, without a schedule message", async () => {
    const { user } = setup(() =>
      json({ error: { code: "validation_failed", message: "Some fields are invalid.", fields: { title: "Too vague" } } }, 400),
    );
    await fillConcert(user, true);
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    const title = screen.getByLabelText("Short title");
    await waitFor(() => expect(title).toHaveAttribute("aria-invalid", "true"));
    expect(title).toHaveAccessibleDescription("Too vague");
    expect(title).toHaveFocus();
    expect(screen.queryByText(SCHEDULE_NOT_ACCEPTED)).not.toBeInTheDocument();
  });

  it("a double click sends one request", async () => {
    let release: (r: Response) => void = () => {};
    const { user, reportCalls } = setup(() => new Promise<Response>((resolve) => (release = resolve)));
    await fillConcert(user, false);
    const submit = screen.getByRole("button", { name: "Submit report" });
    await user.dblClick(submit);
    await settle();
    expect(reportCalls()).toBe(1);
    release(json({ event_id: "evt-1", outcome: "created" }, 201));
  });
});
