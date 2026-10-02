import type { AuthSession, EventDetail } from "@verity/contracts";
import { buildDemoEvents } from "@verity/contracts/demo";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createHttpApi } from "../api/http-client";
import { createSessionStore } from "../api/session-store";
import { renderWithApp } from "../test/render";
import { routes } from "./router";

const BASE = "https://api.verity.example";

/** A real (non-demo) event, as the service would return it. */
function liveEvent(): EventDetail {
  const [demo] = buildDemoEvents(new Date());
  return { ...demo!, is_demo: false, status: "UNVERIFIED", community_confirmation_count: 0 };
}

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fakeService() {
  const event = liveEvent();
  const session: AuthSession = {
    token: "signed.token-0123456789abcdefghij",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    user: { email_masked: "s•••@example.com", created_at: new Date().toISOString() },
  };
  const confirmed = new Set<string>();
  const calls: Array<{ url: string; auth: string | null; body: unknown }> = [];

  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const auth = new Headers(init.headers).get("authorization");
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, auth, body });
    const path = url.replace(BASE, "");
    if (path.startsWith("/api/v1/events?")) return json({ events: [event], generated_at: new Date().toISOString(), truncated: false });
    if (path === `/api/v1/events/${event.id}`) {
      return json({ ...event, community_confirmation_count: confirmed.size });
    }
    if (path === `/api/v1/events/${event.id}/signals/mine`) {
      return auth ? json({ signals: confirmed.has(auth) ? [{ type: "CONFIRM", created_at: new Date().toISOString() }] : [] }) : json({}, 401);
    }
    if (path === `/api/v1/events/${event.id}/signals`) {
      if (auth !== `Bearer ${session.token}`) return json({ error: { code: "auth_required", message: "Sign in to contribute." } }, 401);
      confirmed.add(auth);
      return json({ type: "CONFIRM", changed: true }, 201);
    }
    if (path === "/api/v1/auth/email/start") return json({ sent: true }, 202);
    if (path === "/api/v1/auth/email/verify") {
      return body?.code === "123456" ? json(session) : json({ error: { code: "validation_failed", message: "That code is incorrect or has expired." } }, 400);
    }
    if (path === "/api/v1/me/following") return json({ events: [] });
    return json({ error: { code: "not_found", message: "Not found." } }, 404);
  });
  return { event, fetchImpl, calls, session };
}

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

describe("frontend against the Verity service", () => {
  it("asks a signed-out person to sign in, then completes the exact action they tried", async () => {
    const service = fakeService();
    const sessionStore = createSessionStore(memoryStorage());
    const api = createHttpApi(BASE, { fetch: service.fetchImpl as unknown as typeof fetch, sessionStore });
    renderWithApp(<></>, { routes, path: `/events/${service.event.id}`, api });

    await userEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign in to contribute" });
    // Natural language, not "Authorization required".
    expect(within(dialog).getByText(/We'll email you a 6-digit code/)).toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText("Email address"), "someone@example.com");
    await userEvent.click(within(dialog).getByRole("button", { name: "Email me a code" }));
    await userEvent.type(await within(dialog).findByLabelText("6-digit code"), "123456");
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign in" }));

    // The confirmation that triggered sign-in is sent automatically, with the Verity token.
    expect(await screen.findByRole("button", { name: "Confirmed" })).toHaveAttribute("aria-pressed", "true");
    const signalCalls = service.calls.filter((c) => c.url.endsWith("/signals"));
    expect(signalCalls.at(-1)).toMatchObject({ auth: `Bearer ${service.session.token}`, body: { type: "CONFIRM" } });
    expect(sessionStore.get()?.token).toBe(service.session.token);
    // The event's status is whatever the service says; the client never upgrades it.
    expect(screen.getAllByText("Unverified").length).toBeGreaterThan(0);
  });

  it("does nothing if the person closes the sign-in dialog", async () => {
    const service = fakeService();
    const api = createHttpApi(BASE, { fetch: service.fetchImpl as unknown as typeof fetch, sessionStore: createSessionStore(memoryStorage()) });
    renderWithApp(<></>, { routes, path: `/events/${service.event.id}`, api });
    await userEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveAttribute("aria-pressed", "false");
    expect(service.calls.filter((c) => c.url.endsWith("/signals"))).toHaveLength(0);
  });

  it("shows 'temporarily unavailable' when the service is down, never demo events", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const api = createHttpApi(BASE, { fetch: down as unknown as typeof fetch, sessionStore: createSessionStore(memoryStorage()) });
    renderWithApp(<></>, { routes, path: "/map", api });
    expect(await screen.findByText("Verity is temporarily unavailable.", {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.queryByText("Demo")).toBeNull();
    expect(screen.queryByText(/These are not real current events/)).toBeNull();
    expect(screen.queryByText("US-101 northbound closed near Cesar Chavez St")).toBeNull();
  });
});
