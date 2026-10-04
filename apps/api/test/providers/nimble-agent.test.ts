import { describe, expect, it } from "vitest";
import { AGENT_OUTPUT_SCHEMA, createNimbleInvestigator, parseAgentResult } from "../../src/providers/nimble/agent";
import { agentEvidence } from "../../src/verification/agent-evidence";
import { buildSearchContext } from "../../src/verification/geocoding";
import type { EventForRetrieval } from "../../src/worker/ports";
import { json, mockFetch } from "./mock-fetch";

const KEY = "nimble-test-key-0123456789";
const NOW = new Date("2026-10-03T12:00:00Z");
const signal = () => new AbortController().signal;
const investigator = (fetch: typeof globalThis.fetch) => createNimbleInvestigator({ apiKey: KEY, baseUrl: "https://sdk.nimbleway.com", fetch });
const EVENT: EventForRetrieval = {
  id: "00000000-0000-4000-8000-000000000001",
  category: "power_outage",
  status: "DEVELOPING",
  title: "Power out on Mission St (call 555-0100, reporter jane@example.com)",
  summary: "My whole block is dark",
  firstSeenAt: NOW,
  scheduledStartAt: null,
  scheduledEndAt: null,
};
const context = buildSearchContext({ category: "power_outage", title: EVENT.title, approximateLocation: "Mission St & 22nd St", reportLocationLabels: [] }, null);
const start = (fetch: typeof globalThis.fetch) => investigator(fetch).start({ event: EVENT, context, reason: "insufficient_independent", effort: "low", signal: signal() });
const ref = { runId: "task_run_1", agentId: "wsa_1" };

/** The documented result shape: structured output plus per-claim trust with citations. */
function result(over: Record<string, unknown> = {}) {
  return {
    run: { id: "task_run_1", status: "completed" },
    output: {
      type: "json",
      content: { sources: [{ url: "https://news.example/outage", published_date: "2026-10-03T09:00:00Z", event_time: "2026-10-03", says: "happening" }], verdict: "VERIFIED" },
      trust: {
        confidence: "high",
        reasoning: "Backed by a primary source (official)",
        sources: [{ url: "https://news.example/outage", type: "primary" }],
        claims: [
          {
            path: "sources[0].url",
            confidence: "high",
            reasoning: "…",
            citations: [{ url: "https://news.example/outage", title: "Outage", excerpts: ["Thousands are without power on Mission St."], source_category: "official", source_type: "primary" }],
          },
        ],
      },
      ...over,
    },
  };
}

describe("Nimble agent client: start", () => {
  it("starts ONE unnamed, low-effort research run with a schema Nimble accepts, sending no reporter data or coordinates", async () => {
    const mock = mockFetch(() => json({ id: "task_run_1", web_search_agent_id: "wsa_1", status: "queued", is_active: true }, 202));
    expect(await start(mock.fetch)).toEqual({ status: "started", runId: "task_run_1", agentId: "wsa_1" });
    const [call] = mock.calls;
    expect(call!.url).toBe("https://sdk.nimbleway.com/v2/agents/runs");
    expect(call!.method).toBe("POST");
    expect(call!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call!.body).toMatchObject({ effort: "low", use_case: "research", enable_events: false, output_schema: AGENT_OUTPUT_SCHEMA });
    expect(call!.body).not.toHaveProperty("agent_name");
    expect(call!.body).not.toHaveProperty("previous_interaction_id");
    const prompt = String(call!.body!.input);
    expect(prompt).toContain("Mission St");
    expect(prompt).not.toMatch(/jane@example\.com|555-0100|whole block|latitude|longitude/);
    // Nimble rejects these keywords in output schemas; validation stays in Verity.
    expect(JSON.stringify(AGENT_OUTPUT_SCHEMA)).not.toMatch(/"(format|pattern|minLength|maxLength|minimum|maximum|minItems|maxItems|anyOf)"/);
  });

  it("maps 429/5xx to unavailable and auth to permanent; an accepted but unreadable start throws (the worker fails closed)", async () => {
    expect(await start(mockFetch(() => json({}, 429, { "retry-after": "20" })).fetch)).toEqual({ status: "unavailable", errorCode: "agent_rate_limited", retryAfterSeconds: 20 });
    expect(await start(mockFetch(() => json({}, 503)).fetch)).toMatchObject({ status: "unavailable", errorCode: "agent_5xx" });
    expect(await start(mockFetch(() => json({}, 401)).fetch)).toMatchObject({ status: "permanent_error", errorCode: "agent_auth" });
    await expect(start(mockFetch(() => json({ unexpected: true }, 202)).fetch)).rejects.toThrow();
  });
});

describe("Nimble agent client: poll", () => {
  it("polls the run under its agent, then fetches the result once completed", async () => {
    const mock = mockFetch((call) => (call.url.endsWith("/result") ? json(result()) : json({ id: "task_run_1", status: "completed" })));
    const out = await investigator(mock.fetch).poll(ref, signal());
    expect(mock.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://sdk.nimbleway.com/v2/agents/wsa_1/runs/task_run_1",
      "GET https://sdk.nimbleway.com/v2/agents/wsa_1/runs/task_run_1/result",
    ]);
    expect(out).toEqual({
      status: "completed",
      citations: [{ url: "https://news.example/outage", title: "Outage", excerpts: ["Thousands are without power on Mission St."], providerCategory: "official", providerSourceType: "primary" }],
      proposals: [{ url: "https://news.example/outage", publishedAt: "2026-10-03T09:00:00Z", eventTime: "2026-10-03" }],
    });
    // Nimble's confidence, reasoning and any verdict in the content never leave the client.
    expect(JSON.stringify(out)).not.toMatch(/confidence|reasoning|VERIFIED|"says"/);
  });

  it("reports running for queued/running runs and a 409 result, failed for failed/cancelled runs", async () => {
    for (const status of ["queued", "running"]) expect(await investigator(mockFetch(() => json({ status })).fetch).poll(ref, signal())).toEqual({ status: "running" });
    const conflict = mockFetch((call) => (call.url.endsWith("/result") ? json({}, 409) : json({ status: "completed" })));
    expect(await investigator(conflict.fetch).poll(ref, signal())).toEqual({ status: "running" });
    expect(await investigator(mockFetch(() => json({ status: "failed" })).fetch).poll(ref, signal())).toEqual({ status: "failed", errorCode: "agent_failed" });
    expect(await investigator(mockFetch(() => json({ status: "cancelled" })).fetch).poll(ref, signal())).toEqual({ status: "failed", errorCode: "agent_cancelled" });
    expect(await investigator(mockFetch(() => json({}, 404)).fetch).poll(ref, signal())).toEqual({ status: "failed", errorCode: "agent_run_not_found" });
    expect(await investigator(mockFetch(() => json({}, 503)).fetch).poll(ref, signal())).toEqual({ status: "unavailable", errorCode: "agent_http_503" });
  });

  it("can't poll a run whose resource id is unknown (fails closed, no request)", async () => {
    const mock = mockFetch(() => json({ status: "completed" }));
    expect(await investigator(mock.fetch).poll({ runId: "task_run_1", agentId: null }, signal())).toEqual({ status: "failed", errorCode: "agent_resource_unknown" });
    expect(mock.calls).toHaveLength(0);
  });

  it("parses citations from text answers too, and skips malformed items without guessing", () => {
    const text = parseAgentResult({ output: { type: "text", content: "Power is out.", trust: { claims: [{ citations: [{ url: "https://a.example/x", excerpts: ["Power is out on Mission St."] }, { title: "no url" }] }] } } });
    expect(text?.citations.map((c) => c.url)).toEqual(["https://a.example/x"]);
    expect(text?.proposals).toEqual([]);
    expect(parseAgentResult({ nothing: true })).toBeNull();
    expect(parseAgentResult(result({ trust: { claims: [{ citations: "not an array" }] } }))?.citations).toEqual([]);
  });
});

describe("the live low-effort response shape (S6A, observed 2026-10-04)", () => {
  /** Shape seen live: claims only on "$.sources[N].url", sources with only a url, citations with excerpts: null. */
  const live = {
    run: { id: "task_run_live", status: "completed" },
    output: {
      type: "json",
      content: { sources: [1, 2, 3].map((n) => ({ url: `https://site-${n}.example/page` })) },
      trust: {
        confidence: "medium",
        reasoning: "…",
        sources: [1, 2, 3].map((n) => ({ url: `https://site-${n}.example/page`, title: "Title", type: "secondary", source_category: "news", source_intent: null, extract_template_name: null })),
        claims: [1, 2, 3].map((n) => ({
          path: `$.sources[${n - 1}].url`,
          confidence: "medium",
          reasoning: "…",
          citations: [{ url: `https://site-${n}.example/page`, title: "Title", excerpts: null, source_category: "news", source_intent: "news", source_type: "secondary", extract_template_name: null }],
        })),
      },
    },
  };

  it("parses URL-only citations as citations with no text, and no date proposals", () => {
    const parsed = parseAgentResult(live)!;
    expect(parsed.citations).toHaveLength(3);
    expect(parsed.citations.every((c) => c.excerpts.length === 0 && c.title === "Title")).toBe(true);
    expect(parsed.proposals).toEqual([1, 2, 3].map((n) => ({ url: `https://site-${n}.example/page`, publishedAt: null, eventTime: null })));
  });

  it("turns none of them into direct evidence: they are only pages Verity may read", () => {
    const parsed = parseAgentResult(live)!;
    const out = agentEvidence({ citations: parsed.citations, proposals: parsed.proposals, category: "parking_traffic", context, now: NOW, runId: "task_run_live" });
    expect(out.evidence).toEqual([]);
    expect(out.excerptless.map((e) => e.url)).toEqual([1, 2, 3].map((n) => `https://site-${n}.example/page`));
  });
});

describe("Nimble agent client: cleanup", () => {
  it("deactivates the run's agent resource; a missing one counts as already gone", async () => {
    const mock = mockFetch(() => new Response(null, { status: 204 }));
    expect(await investigator(mock.fetch).cleanup(ref, signal())).toBe("deleted");
    expect(`${mock.calls[0]!.method} ${mock.calls[0]!.url}`).toBe("DELETE https://sdk.nimbleway.com/v2/agents/wsa_1");
    expect(await investigator(mockFetch(() => json({}, 404)).fetch).cleanup(ref, signal())).toBe("not_found");
    expect(await investigator(mockFetch(() => json({}, 500)).fetch).cleanup(ref, signal())).toBe("failed");
    expect(await investigator(mockFetch(() => Promise.reject(new TypeError("down"))).fetch).cleanup(ref, signal())).toBe("failed");
    expect(await investigator(mockFetch(() => json({})).fetch).cleanup({ runId: "r", agentId: null }, signal())).toBe("failed");
  });
});
