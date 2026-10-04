import { describe, expect, it } from "vitest";
import { createNimbleExtractor, MAX_EXTRACT_RESPONSE_BYTES } from "../../src/providers/nimble/extract";
import { PAGE_LIMITS } from "../../src/verification/page-metadata";
import { extractResponse, json, mockFetch } from "./mock-fetch";

const KEY = "nimble-test-key-0123456789";
const NOW = new Date("2026-10-03T12:00:00Z");
const URL_ = "https://news.example/mission-closure";
const signal = () => new AbortController().signal;
const extractor = (fetch: typeof globalThis.fetch) => createNimbleExtractor({ apiKey: KEY, baseUrl: "https://sdk.nimbleway.com/", now: () => NOW, fetch });

describe("Nimble Extract client: request", () => {
  it("POSTs to /v2/extract with Bearer auth and a fixed, minimal body: no cookies, headers, actions or callbacks", async () => {
    const mock = mockFetch(() => json(extractResponse()));
    await extractor(mock.fetch).extract({ url: URL_, signal: signal() });
    const [call] = mock.calls;
    expect(call!.url).toBe("https://sdk.nimbleway.com/v2/extract");
    expect(call!.method).toBe("POST");
    expect(call!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call!.body).toEqual({
      url: URL_,
      formats: ["html", "markdown"],
      markdown_backend: "main_content",
      driver: "vx6",
      render: false,
      country: "US",
      locale: "en",
      request_timeout: 20000,
    });
    for (const forbidden of ["cookies", "headers", "body", "browser_actions", "network_capture", "callback_url", "parser", "storage_url", "session"]) {
      expect(call!.body).not.toHaveProperty(forbidden);
    }
  });

  it("refuses unsafe URLs without calling the provider", async () => {
    const mock = mockFetch(() => json(extractResponse()));
    for (const url of ["http://localhost/admin", "http://127.0.0.1/", "http://10.0.0.5/x", "file:///etc/passwd", "ftp://a.example/x", "https://user:pw@a.example/", "https://a.example:8443/x"]) {
      expect(await extractor(mock.fetch).extract({ url, signal: signal() })).toEqual({ status: "page_failed", code: "extract_unsafe_url" });
    }
    expect(mock.calls).toHaveLength(0);
  });

  it("passes the AbortSignal through and maps abort or timeout to unavailable", async () => {
    const controller = new AbortController();
    controller.abort();
    const mock = mockFetch(() => json(extractResponse()));
    expect(await extractor(mock.fetch).extract({ url: URL_, signal: controller.signal })).toEqual({ status: "unavailable", code: "extract_timeout", retryAfterSeconds: null });
    const timeout = mockFetch(() => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })));
    expect(await extractor(timeout.fetch).extract({ url: URL_, signal: signal() })).toMatchObject({ status: "unavailable", code: "extract_timeout" });
    const network = mockFetch(() => Promise.reject(new TypeError("fetch failed")));
    expect(await extractor(network.fetch).extract({ url: URL_, signal: signal() })).toMatchObject({ status: "unavailable", code: "extract_network" });
  });
});

describe("Nimble Extract client: provider responses", () => {
  const status = async (code: number, headers: Record<string, string> = {}, body: unknown = {}) => extractor(mockFetch(() => json(body, code, headers)).fetch).extract({ url: URL_, signal: signal() });

  it("maps 429 (with Retry-After) and 5xx to unavailable, so extraction stops for now", async () => {
    expect(await status(429, { "retry-after": "17" })).toEqual({ status: "unavailable", code: "extract_rate_limited", retryAfterSeconds: 17 });
    expect(await status(429, {}, { retry_after: 9 })).toEqual({ status: "unavailable", code: "extract_rate_limited", retryAfterSeconds: 9 });
    expect(await status(503)).toEqual({ status: "unavailable", code: "extract_5xx", retryAfterSeconds: null });
  });

  it("maps auth and payment errors to permanent, and a rejected URL or page timeout to page_failed", async () => {
    expect(await status(401)).toEqual({ status: "permanent_error", code: "extract_auth" });
    expect(await status(402)).toEqual({ status: "permanent_error", code: "extract_payment_required" });
    expect(await status(400)).toEqual({ status: "page_failed", code: "extract_bad_request" });
    expect(await status(555)).toEqual({ status: "page_failed", code: "extract_page_timeout" });
  });

  it("rejects malformed and oversized responses without reading them as evidence", async () => {
    const notJson = mockFetch(() => new Response("<html>oops</html>", { status: 200 }));
    expect(await extractor(notJson.fetch).extract({ url: URL_, signal: signal() })).toMatchObject({ status: "unavailable", code: "extract_malformed_json" });
    const wrongShape = mockFetch(() => json({ results: [] }));
    expect(await extractor(wrongShape.fetch).extract({ url: URL_, signal: signal() })).toEqual({ status: "page_failed", code: "extract_malformed_response" });
    const declared = mockFetch(() => new Response("{}", { status: 200, headers: { "content-length": String(MAX_EXTRACT_RESPONSE_BYTES + 1) } }));
    expect(await extractor(declared.fetch).extract({ url: URL_, signal: signal() })).toEqual({ status: "page_failed", code: "extract_response_too_large" });
    const streamed = mockFetch(() => json(extractResponse({}, { html: "x".repeat(MAX_EXTRACT_RESPONSE_BYTES) })));
    expect(await extractor(streamed.fetch).extract({ url: URL_, signal: signal() })).toEqual({ status: "page_failed", code: "extract_response_too_large" });
  });

  it("treats non-success tasks and non-2xx pages as this page failing", async () => {
    expect(await extractor(mockFetch(() => json(extractResponse({ status: "blocked" }))).fetch).extract({ url: URL_, signal: signal() })).toEqual({ status: "page_failed", code: "extract_blocked" });
    expect(await extractor(mockFetch(() => json(extractResponse({ status_code: 404 }))).fetch).extract({ url: URL_, signal: signal() })).toEqual({ status: "page_failed", code: "extract_http_404" });
    expect(await extractor(mockFetch(() => json(extractResponse({}, { html: "", markdown: "" }))).fetch).extract({ url: URL_, signal: signal() })).toEqual({ status: "page_failed", code: "extract_no_content" });
  });
});

describe("Nimble Extract client: redirects and page content", () => {
  it("screens the final URL and every redirect hop", async () => {
    const unsafeFinal = mockFetch(() => json(extractResponse({ url: "http://169.254.169.254/latest/meta-data" })));
    expect(await extractor(unsafeFinal.fetch).extract({ url: URL_, signal: signal() })).toEqual({ status: "page_failed", code: "extract_unsafe_final_url" });
    const unsafeHop = mockFetch(() => json(extractResponse({}, { redirects: [{ url: "http://localhost:8080/internal", status_code: 302 }] })));
    expect(await extractor(unsafeHop.fetch).extract({ url: URL_, signal: signal() })).toEqual({ status: "page_failed", code: "extract_unsafe_redirect" });
  });

  it("returns the canonical final URL after a safe redirect (the merge decides whether it is the same site)", async () => {
    const mock = mockFetch(() => json(extractResponse({ url: "https://www.news.example/2026/mission-closure?utm_source=x" }, { redirects: [{ url: "https://www.news.example/2026/mission-closure", status_code: 301 }] })));
    const out = await extractor(mock.fetch).extract({ url: URL_, signal: signal() });
    expect(out.status === "ok" && out.page.finalUrl).toBe("https://www.news.example/2026/mission-closure");
  });

  it("returns only the evidence fields: plain main text, title, publication metadata (never dateModified), provider ref", async () => {
    const out = await extractor(mockFetch(() => json(extractResponse())).fetch).extract({ url: URL_, signal: signal() });
    expect(out).toEqual({
      status: "ok",
      page: {
        requestedUrl: URL_,
        finalUrl: URL_,
        title: "Mission St closed",
        text: "Mission St closed\n\nNorthbound lanes of Mission St are closed at 22nd St.",
        published: { at: new Date("2026-10-03T10:40:00Z"), precision: "instant" },
        publishedConflict: false,
        ref: "task_abc",
      },
    });
    expect(JSON.stringify(out)).not.toContain("<html");
  });

  it("keeps date-only metadata as day precision and missing metadata as null", async () => {
    const dateOnly = mockFetch(() => json(extractResponse({}, { html: `<meta property="article:published_time" content="2026-10-03">` })));
    const a = await extractor(dateOnly.fetch).extract({ url: URL_, signal: signal() });
    expect(a.status === "ok" && a.page.published).toEqual({ at: new Date("2026-10-03T00:00:00Z"), precision: "day" });
    const none = mockFetch(() => json(extractResponse({}, { html: "<p>Published today</p>" })));
    const b = await extractor(none.fetch).extract({ url: URL_, signal: signal() });
    expect(b.status === "ok" && b.page.published).toBeNull();
  });

  it("caps the page text kept for evidence processing", async () => {
    const big = mockFetch(() => json(extractResponse({}, { markdown: "Mission St is closed. ".repeat(20_000) })));
    const out = await extractor(big.fetch).extract({ url: URL_, signal: signal() });
    expect(out.status === "ok" && out.page.text.length).toBeLessThanOrEqual(PAGE_LIMITS.textChars);
  });
});
