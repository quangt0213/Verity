import type { AuthSession } from "@verity/contracts";
import { buildDemoEvents } from "@verity/contracts/demo";
import { describe, expect, it, vi } from "vitest";
import { VerityApiError } from "./errors";
import { buildListEventsSearch, createHttpApi, UNAVAILABLE_MESSAGE } from "./http-client";
import { createSessionStore } from "./session-store";

const BASE = "https://api.verity.example";
const sample = buildDemoEvents(new Date("2026-10-01T15:00:00Z"));
const EVENT_ID = sample[0]!.id;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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

const session: AuthSession = {
  token: "signed.session-token-abcdefghijklmnop",
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  user: { email_masked: "a•••@example.com", created_at: "2026-10-01T15:00:00Z" },
};

function apiWith(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, opts: { signedIn?: boolean; timeoutMs?: number } = {}) {
  const fetchMock = vi.fn(fetchImpl);
  const sessionStore = createSessionStore(memoryStorage());
  if (opts.signedIn) sessionStore.set(session);
  const api = createHttpApi(BASE, { fetch: fetchMock as unknown as typeof fetch, timeoutMs: opts.timeoutMs, sessionStore });
  return { api, fetchMock, sessionStore };
}

describe("http client reads", () => {
  it("requests the versioned API with rounded, sorted parameters and no credentials", async () => {
    const { api, fetchMock } = apiWith(async () => jsonResponse({ events: [], generated_at: "2026-10-01T15:00:00Z", truncated: false }));
    await api.listEvents({ bbox: [-122.512345, 37.70001, -122.35, 37.82], statuses: ["VERIFIED", "DEVELOPING"], q: "flood" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/v1/events?bbox=-122.5123%2C37.7%2C-122.35%2C37.82&statuses=DEVELOPING%2CVERIFIED&q=flood`);
    expect(init.credentials).toBe("omit");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("validates responses against the shared contract", async () => {
    const ok = apiWith(async () => jsonResponse(sample[0]));
    expect((await ok.api.getEvent(EVENT_ID)).title).toBe(sample[0]!.title);
    const bad = apiWith(async () => jsonResponse({ ...sample[0], status: "PROBABLY_TRUE" }));
    await expect(bad.api.getEvent(EVENT_ID)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("shows 'temporarily unavailable' for server failures and never leaks their details", async () => {
    const leaky = apiWith(async () => jsonResponse({ stack: "Error at db.query (pg.js:42)", detail: "password auth failed" }, 500));
    const error = (await leaky.api.getEvent(EVENT_ID).catch((e: unknown) => e)) as VerityApiError;
    expect(error).toBeInstanceOf(VerityApiError);
    expect(error.code).toBe("unavailable");
    expect(error.message).toBe(UNAVAILABLE_MESSAGE);

    const limited = apiWith(async () => jsonResponse({ error: { code: "rate_limited", message: "Slow down" } }, 429));
    await expect(limited.api.getEvent(EVENT_ID)).rejects.toMatchObject({ code: "rate_limited", message: "Slow down" });
    const missing = apiWith(async () => jsonResponse({ error: { code: "not_found", message: "Not found" } }, 404));
    await expect(missing.api.getEvent(EVENT_ID)).rejects.toMatchObject({ code: "not_found" });
  });

  it("reports network failures and timeouts as unavailable", async () => {
    const offline = apiWith(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(offline.api.getEvent(EVENT_ID)).rejects.toMatchObject({ message: UNAVAILABLE_MESSAGE });
    const slow = apiWith(
      (_url, init) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))),
      { timeoutMs: 20 },
    );
    await expect(slow.api.getEvent(EVENT_ID)).rejects.toMatchObject({ message: UNAVAILABLE_MESSAGE });
  });

  it("refuses unsafe ids without making a request", async () => {
    const { api, fetchMock } = apiWith(async () => jsonResponse({}));
    await expect(api.getEvent("../internal/v1/events/1/transition")).rejects.toMatchObject({ code: "not_found" });
    await expect(api.getEvidence("a/b")).rejects.toMatchObject({ code: "not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects oversized viewports before sending them", () => {
    expect(() => buildListEventsSearch({ bbox: [-130, 30, -110, 45] })).toThrow();
  });
});

describe("http client writes", () => {
  const report = { category: "crash" as const, title: "Crash on Main St", location: { coordinates: { latitude: 37.7, longitude: -122.4 } } };

  it("asks for sign-in instead of sending a protected write without a session", async () => {
    const { api, fetchMock } = apiWith(async () => jsonResponse({}));
    expect(await api.reportEvent(report)).toMatchObject({ ok: false, error: { code: "auth_required", message: "Sign in to contribute." } });
    expect(await api.respond(EVENT_ID, { kind: "confirm" })).toMatchObject({ ok: false, error: { code: "auth_required" } });
    expect(await api.setFollowing(EVENT_ID, true)).toMatchObject({ ok: false, error: { code: "auth_required" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends writes with the Verity bearer token, never Maypop identity or cookies", async () => {
    const { api, fetchMock } = apiWith(async () => jsonResponse({ event_id: EVENT_ID, report_id: EVENT_ID, outcome: "created" }, 201), {
      signedIn: true,
    });
    const result = await api.reportEvent(report);
    expect(result).toMatchObject({ ok: true, simulated: false, data: { outcome: "created" } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/v1/reports`);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${session.token}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(init.credentials).toBe("omit");
    expect([...headers.keys()].some((k) => k.includes("maypop"))).toBe(false);
    expect(String(init.body)).not.toMatch(/maypop|user_id/i);
  });

  it("maps community answers onto signal types", async () => {
    const { api, fetchMock } = apiWith(async () => jsonResponse({ type: "NO_LONGER_HAPPENING", changed: true }, 201), { signedIn: true });
    await api.respond(EVENT_ID, { kind: "still_happening", answer: "no" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual({ type: "NO_LONGER_HAPPENING" });
    await api.respond(EVENT_ID, { kind: "resolved" });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body))).toEqual({ type: "NO_LONGER_HAPPENING" });
    const update = await api.respond(EVENT_ID, { kind: "update", text: "x" });
    expect(update.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces validation field errors and clears an expired session on 401", async () => {
    const invalid = apiWith(
      async () => jsonResponse({ error: { code: "validation_failed", message: "Some fields are invalid.", fields: { title: "Too short" } } }, 400),
      { signedIn: true },
    );
    expect(await invalid.api.reportEvent(report)).toMatchObject({ ok: false, error: { code: "validation_failed", fields: { title: "Too short" } } });

    const expired = apiWith(async () => jsonResponse({ error: { code: "auth_required", message: "Sign in to contribute." } }, 401), {
      signedIn: true,
    });
    const result = await expired.api.respond(EVENT_ID, { kind: "confirm" });
    expect(result).toMatchObject({ ok: false, error: { code: "auth_required" } });
    expect(expired.sessionStore.get()).toBeNull();
  });
});

describe("http client sign-in", () => {
  it("stores the session after verifying a code and forgets it on sign-out", async () => {
    const { api, fetchMock, sessionStore } = apiWith(async (url) => {
      if (url.endsWith("/auth/email/start")) return jsonResponse({ sent: true }, 202);
      if (url.endsWith("/auth/email/verify")) return jsonResponse(session);
      return jsonResponse(null, 204);
    });
    expect(await api.auth!.startEmailSignIn("a@example.com")).toMatchObject({ ok: true });
    expect(await api.auth!.verifyEmailSignIn("a@example.com", "123456")).toMatchObject({ ok: true });
    expect(sessionStore.get()?.token).toBe(session.token);
    await api.auth!.signOut();
    expect(sessionStore.get()).toBeNull();
    const signOutCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/auth/sign-out"))!;
    expect(new Headers(signOutCall[1].headers).get("authorization")).toBe(`Bearer ${session.token}`);
  });

  it("ignores stored sessions that are expired or malformed", () => {
    const storage = memoryStorage();
    storage.setItem("verity.session.v1", JSON.stringify({ ...session, expires_at: new Date(Date.now() - 1000).toISOString() }));
    expect(createSessionStore(storage).get()).toBeNull();
    storage.setItem("verity.session.v1", "{not json");
    expect(createSessionStore(storage).get()).toBeNull();
  });
});
