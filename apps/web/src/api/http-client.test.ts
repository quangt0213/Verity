import { describe, expect, it, vi } from "vitest";
import { VerityApiError } from "./errors";
import { buildListEventsSearch, createHttpApi } from "./http-client";
import { buildDemoEvents } from "./mock/fixtures";

const BASE = "https://api.verity.example";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function apiWith(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, timeoutMs?: number) {
  const fetchMock = vi.fn(fetchImpl);
  return { api: createHttpApi(BASE, { fetch: fetchMock as unknown as typeof fetch, timeoutMs }), fetchMock };
}

const sample = buildDemoEvents(new Date("2026-10-01T15:00:00Z"));

describe("http client reads", () => {
  it("requests the viewport with rounded, sorted parameters and no credentials", async () => {
    const { api, fetchMock } = apiWith(async () => jsonResponse({ events: [], generated_at: "2026-10-01T15:00:00Z", truncated: false }));
    await api.listEvents({ bbox: [-122.512345, 37.70001, -122.35, 37.82], statuses: ["VERIFIED", "DEVELOPING"], q: "flood" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/events?bbox=-122.5123%2C37.7%2C-122.35%2C37.82&statuses=DEVELOPING%2CVERIFIED&q=flood`);
    expect(init.credentials).toBe("omit");
    expect(init.method).toBe("GET");
  });

  it("validates event detail responses against the shared contract", async () => {
    const { api } = apiWith(async () => jsonResponse(sample[0]));
    const event = await api.getEvent(sample[0]!.id);
    expect(event.title).toBe(sample[0]!.title);
  });

  it("treats malformed payloads as errors instead of rendering them", async () => {
    const { api } = apiWith(async () => jsonResponse({ ...sample[0], status: "PROBABLY_TRUE" }));
    await expect(api.getEvent(sample[0]!.id)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("maps HTTP errors to safe codes and discards unexpected error bodies", async () => {
    const leaky = apiWith(async () => jsonResponse({ stack: "Error at db.query (pg.js:42)", detail: "password auth failed" }, 500));
    const error = await leaky.api.getEvent("abc").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VerityApiError);
    expect((error as VerityApiError).code).toBe("internal");
    expect((error as VerityApiError).message).not.toMatch(/pg\.js|password/);

    const limited = apiWith(async () => jsonResponse({ error: { code: "rate_limited", message: "Slow down" } }, 429));
    await expect(limited.api.getEvent("abc")).rejects.toMatchObject({ code: "rate_limited", message: "Slow down" });

    const missing = apiWith(async () => jsonResponse({ error: { code: "not_found", message: "Not found" } }, 404));
    await expect(missing.api.getEvent("abc")).rejects.toMatchObject({ code: "not_found" });
  });

  it("reports network failures and timeouts", async () => {
    const offline = apiWith(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(offline.api.getEvent("abc")).rejects.toMatchObject({ code: "network" });

    const slow = apiWith(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
      20,
    );
    await expect(slow.api.getEvent("abc")).rejects.toMatchObject({ code: "timeout" });
  });

  it("refuses unsafe ids without making a request", async () => {
    const { api, fetchMock } = apiWith(async () => jsonResponse({}));
    await expect(api.getEvent("../internal/events/1/verify")).rejects.toMatchObject({ code: "not_found" });
    await expect(api.getEvidence("a/b")).rejects.toMatchObject({ code: "not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects oversized viewports before sending them", () => {
    expect(() => buildListEventsSearch({ bbox: [-130, 30, -110, 45] })).toThrow();
  });
});

describe("http client writes (authentication boundary)", () => {
  it("does not send reports or responses while identity can't be verified", async () => {
    const { api, fetchMock } = apiWith(async () => jsonResponse({}));
    expect(api.writePolicy).toEqual({ enabled: false, reason: "auth_unavailable" });

    const report = await api.reportEvent({
      category: "crash",
      title: "Crash on Main St",
      location: { coordinates: { latitude: 37.7, longitude: -122.4 } },
    });
    const confirm = await api.respond("abc", { kind: "confirm" });

    expect(report).toMatchObject({ ok: false, error: { code: "auth_unavailable" } });
    expect(confirm).toMatchObject({ ok: false, error: { code: "auth_unavailable" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
