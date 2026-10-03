import { describe, expect, it } from "vitest";
import { createNimbleSearchClient, invalidFieldPaths, MAX_RESPONSE_BYTES, parseRetryAfter, type SearchRequest } from "../../src/providers/nimble/client";
import { json, mockFetch, nimbleResult } from "./mock-fetch";

const KEY = "nimble-test-key-0123456789";
const request: SearchRequest = { query: "road closure Mission St San Francisco", searchDepth: "standard", maxResults: 10, country: "US", timeRange: "day" };
const signal = () => new AbortController().signal;
const client = (fetch: typeof globalThis.fetch) => createNimbleSearchClient({ apiKey: KEY, baseUrl: "https://sdk.nimbleway.com/", fetch });

describe("Nimble search client: request", () => {
  it("POSTs JSON to /v2/search with Bearer auth and the documented fields", async () => {
    const mock = mockFetch(() => json({ request_id: "r-1", total_results: 1, results: [nimbleResult()] }));
    await client(mock.fetch).search({ ...request, includeDomains: ["dot.ca.gov", "511.org"] }, signal());
    const [call] = mock.calls;
    expect(call!.url).toBe("https://sdk.nimbleway.com/v2/search");
    expect(call!.method).toBe("POST");
    expect(call!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call!.headers["content-type"]).toBe("application/json");
    expect(call!.body).toEqual({
      query: request.query,
      search_depth: "standard",
      max_results: 10,
      output_format: "plain_text",
      locale: "en",
      country: "US",
      time_range: "day",
      include_domains: ["dot.ca.gov", "511.org"],
    });
  });

  it("caps max_results and never sends time_range together with start_date", async () => {
    const mock = mockFetch(() => json({ results: [] }));
    await client(mock.fetch).search({ ...request, maxResults: 500, timeRange: undefined, startDate: "2026-09-20" }, signal());
    expect(mock.calls[0]!.body).toMatchObject({ max_results: 10, start_date: "2026-09-20" });
    expect(mock.calls[0]!.body).not.toHaveProperty("time_range");
  });

  it("passes the AbortSignal through and maps an abort or timeout to a transient error", async () => {
    const controller = new AbortController();
    const mock = mockFetch(() => json({ results: [] }));
    controller.abort();
    expect(await client(mock.fetch).search(request, controller.signal)).toEqual({ ok: false, kind: "transient", code: "nimble_timeout", retryAfterSeconds: null });
    expect(mock.calls[0]!.signal).toBe(controller.signal);

    const timeout = mockFetch(() => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })));
    expect(await client(timeout.fetch).search(request, signal())).toMatchObject({ ok: false, kind: "transient", code: "nimble_timeout" });
  });
});

describe("Nimble search client: responses", () => {
  it("parses valid results and drops individually invalid items", async () => {
    const mock = mockFetch(() => json({ request_id: "r-2", results: [nimbleResult(), { title: "no url" }, nimbleResult({ url: "https://b.example/x", extra_field: true })] }));
    const out = await client(mock.fetch).search(request, signal());
    expect(out).toMatchObject({ ok: true, requestId: "r-2", droppedInvalid: 1, invalidFieldPaths: ["url:invalid_type"] });
    if (out.ok) expect(out.results.map((r) => r.url)).toEqual(["https://news.example/story-1", "https://b.example/x"]);
  });

  it("treats null text fields as absent, as the live API returns them", async () => {
    const mock = mockFetch(() => json({ results: [nimbleResult({ content: null, description: null, title: null, additional_data: null })] }));
    const out = await client(mock.fetch).search(request, signal());
    expect(out).toMatchObject({ ok: true, droppedInvalid: 0 });
    if (out.ok) expect(out.results[0]).toMatchObject({ content: "", description: "", title: "" });
    expect(invalidFieldPaths({ title: "x" })).toEqual(["url:invalid_type"]);
  });

  it("treats an empty result list as success with no results", async () => {
    const out = await client(mockFetch(() => json({ request_id: "r", total_results: 0, results: [] })).fetch).search(request, signal());
    expect(out).toEqual({ ok: true, requestId: "r", results: [], droppedInvalid: 0, invalidFieldPaths: [] });
  });

  it.each([
    [429, "transient", "nimble_rate_limited"],
    [500, "transient", "nimble_5xx"],
    [503, "transient", "nimble_5xx"],
    [401, "permanent", "nimble_auth"],
    [403, "permanent", "nimble_auth"],
    [402, "permanent", "nimble_payment_required"],
    [400, "permanent", "nimble_bad_request"],
    [422, "permanent", "nimble_bad_request"],
    [404, "permanent", "nimble_http_404"],
  ] as const)("maps HTTP %i to a %s error (%s) without exposing the body", async (status, kind, code) => {
    const mock = mockFetch(() => json({ error: "secret-ish provider detail", key: KEY }, status));
    const out = await client(mock.fetch).search(request, signal());
    expect(out).toMatchObject({ ok: false, kind, code });
    expect(JSON.stringify(out)).not.toContain("provider detail");
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("honors Retry-After (seconds, HTTP date, or a body retry_after) on 429", async () => {
    const seconds = await client(mockFetch(() => json({}, 429, { "retry-after": "120" })).fetch).search(request, signal());
    expect(seconds).toMatchObject({ code: "nimble_rate_limited", retryAfterSeconds: 120 });
    const body = await client(mockFetch(() => json({ retry_after: 45 }, 429)).fetch).search(request, signal());
    expect(body).toMatchObject({ retryAfterSeconds: 45 });
    expect(parseRetryAfter(new Date(Date.now() + 30_000).toUTCString(), null)).toBeGreaterThanOrEqual(29);
    expect(parseRetryAfter("99999", null)).toBe(3600);
    expect(parseRetryAfter(null, null)).toBeNull();
  });

  it("maps network failures, malformed JSON and malformed schemas to transient errors", async () => {
    const network = await client(mockFetch(() => Promise.reject(new TypeError("fetch failed"))).fetch).search(request, signal());
    expect(network).toMatchObject({ ok: false, kind: "transient", code: "nimble_network" });
    const badJson = await client(mockFetch(() => new Response("<html>oops</html>", { status: 200 })).fetch).search(request, signal());
    expect(badJson).toMatchObject({ code: "nimble_malformed_json" });
    const badShape = await client(mockFetch(() => json({ results: "not-an-array" })).fetch).search(request, signal());
    expect(badShape).toMatchObject({ code: "nimble_malformed_response" });
  });

  it("refuses an oversized response, by declared length or while streaming", async () => {
    const declared = mockFetch(() => new Response("{}", { status: 200, headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }));
    expect(await client(declared.fetch).search(request, signal())).toMatchObject({ code: "nimble_response_too_large" });
    const huge = "x".repeat(MAX_RESPONSE_BYTES + 10);
    const streamed = mockFetch(() => new Response(`{"results":[],"pad":"${huge}"}`, { status: 200 }));
    expect(await client(streamed.fetch).search(request, signal())).toMatchObject({ code: "nimble_response_too_large" });
  });
});
