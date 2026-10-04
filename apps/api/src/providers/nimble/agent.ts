import { CATEGORY_KIND } from "@verity/contracts";
import { z } from "zod";
import type { AgentCitation, AgentCleanup, AgentInvestigator, AgentPoll, AgentProposal, AgentRunRef, AgentStart } from "../../worker/ports";
import { parseRetryAfter, readCapped, statusOutcome } from "./client";
import { sanitizeQueryText } from "./query";

/**
 * Nimble Web Search Agents behind the AgentInvestigator port, per the
 * official API checked 2026-10-03 (OpenAPI):
 *
 *   POST   /v2/agents/runs                          start (202: id, web_search_agent_id)
 *   GET    /v2/agents/{agent_id}/runs/{run_id}      state: queued | running | completed | failed | cancelled
 *   GET    /v2/agents/{agent_id}/runs/{run_id}/result   output + trust (409 while running, 422 if failed)
 *   DELETE /v2/agents/{agent_id}                    deactivate (soft delete; runs stay readable)
 *
 * Runs are UNNAMED (no agent_name): Nimble then creates a minimal persistent
 * agent per run, with no memory shared between events. The worker saves its
 * id with the run id and deactivates it once the run is over.
 *
 * Only event wording, category, place names and timing are sent: never
 * reporter identity, accounts or coordinates. From the result, ONLY the
 * per-claim citations (URL + verbatim excerpts) and the model's raw date
 * proposals leave this module. Nimble's confidence grades, reasoning, prose
 * answer and stance labels are discarded: Verity derives evidence and
 * decides.
 */

export const AGENT_RUNS_PATH = "/v2/agents/runs";
const MAX_AGENT_RESPONSE_BYTES = 2 * 1024 * 1024;

const CATEGORY_WORDS: Record<string, string> = {
  road_closure: "road closure",
  transit_disruption: "transit disruption",
  power_outage: "power outage",
  police_activity: "police activity",
  parking_traffic: "traffic congestion",
  sporting_event: "sporting event",
  campus_event: "campus event",
};

/** Output schema: Nimble forbids format, pattern, min/max and a root anyOf; validation lives in Verity. */
export const AGENT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string", description: "The source page URL." },
          published_date: { type: "string", description: "The source's publication date and time exactly as the source states it (ISO 8601 if possible). Empty if not stated." },
          event_time: { type: "string", description: "When the source says the event happened, exactly as stated (ISO 8601 if possible). Empty if not stated." },
          says: { type: "string", enum: ["happening", "ended", "not_happening", "unrelated"] },
        },
        required: ["url"],
      },
    },
  },
  required: ["sources"],
} as const;

export function buildAgentPrompt(input: { category: string; title: string; locationTerms: string[]; city: string | null; region: string | null; firstSeenAt: Date; scheduledStartAt: Date | null; reason: string }): string {
  const what = CATEGORY_WORDS[input.category] ?? input.category.replace(/_/g, " ");
  const where = [...input.locationTerms.slice(0, 2), input.city, input.region].map((p) => sanitizeQueryText(p)).filter(Boolean).join(", ");
  const when = input.scheduledStartAt && CATEGORY_KIND[input.category as keyof typeof CATEGORY_KIND] === "planned"
    ? `It is scheduled to start ${input.scheduledStartAt.toISOString()}.`
    : `It was first reported around ${input.firstSeenAt.toISOString()}.`;
  return [
    `Check whether this reported real-world event is happening: a ${what} described as "${sanitizeQueryText(input.title)}" at ${where || "an unspecified place"}. ${when}`,
    "Find current reports from official agencies, the organizations involved and local news. For each source, give its URL, whether it says the event is happening, has ended, or is not happening, and its publication date and event time exactly as the source states them.",
    "Cite the exact sentences you rely on. Do not guess dates.",
  ].join("\n");
}

const startSchema = z.object({ id: z.string().min(1).max(128), web_search_agent_id: z.string().min(1).max(128).nullish(), status: z.string().max(32).nullish() });
const runSchema = z.object({ id: z.string().max(128).nullish(), status: z.string().max(32) });
const citationSchema = z.object({
  url: z.string().max(4096),
  title: z.string().max(2000).nullish(),
  excerpts: z.array(z.string().max(5000)).max(20).nullish(),
  source_category: z.string().max(40).nullish(),
  source_type: z.string().max(40).nullish(),
});
const claimSchema = z.object({ citations: z.array(z.unknown()).max(50).nullish() });
const resultSchema = z.object({
  output: z.object({
    type: z.string().max(20).nullish(),
    content: z.unknown(),
    trust: z.object({ claims: z.array(z.unknown()).max(300).nullish() }).passthrough(),
  }),
});
const proposalSchema = z.object({ url: z.string().max(4096), published_date: z.string().max(200).nullish(), event_time: z.string().max(200).nullish() });

/** Citations and proposals from a result body; everything else is discarded. Invalid items are skipped, never guessed. */
export function parseAgentResult(body: unknown): { citations: AgentCitation[]; proposals: AgentProposal[] } | null {
  const parsed = resultSchema.safeParse(body);
  if (!parsed.success) return null;
  const citations: AgentCitation[] = [];
  for (const rawClaim of parsed.data.output.trust.claims ?? []) {
    const claim = claimSchema.safeParse(rawClaim);
    if (!claim.success) continue;
    for (const rawCitation of claim.data.citations ?? []) {
      const c = citationSchema.safeParse(rawCitation);
      if (!c.success || citations.length >= 100) continue;
      citations.push({ url: c.data.url, title: c.data.title ?? null, excerpts: (c.data.excerpts ?? []).slice(0, 10), providerCategory: c.data.source_category ?? null, providerSourceType: c.data.source_type ?? null });
    }
  }
  const proposals: AgentProposal[] = [];
  const content = parsed.data.output.content;
  const sources = content && typeof content === "object" && "sources" in content && Array.isArray((content as { sources: unknown }).sources) ? (content as { sources: unknown[] }).sources : [];
  for (const raw of sources.slice(0, 30)) {
    const p = proposalSchema.safeParse(raw);
    if (p.success) proposals.push({ url: p.data.url, publishedAt: p.data.published_date ?? null, eventTime: p.data.event_time ?? null });
  }
  return { citations, proposals };
}

export function createNimbleInvestigator(options: { apiKey: string; baseUrl: string; fetch?: typeof fetch }): AgentInvestigator {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", accept: "application/json" };
  const id = (value: string) => encodeURIComponent(value);

  async function call(method: string, path: string, signal: AbortSignal, body?: unknown): Promise<{ status: number; json: unknown; retryAfter: number | null } | { error: string }> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: "error" });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      return { error: name === "TimeoutError" || name === "AbortError" ? "agent_timeout" : "agent_network" };
    }
    let text: string | null;
    try {
      text = await readCapped(response, MAX_AGENT_RESPONSE_BYTES);
    } catch {
      return { error: "agent_network" };
    }
    if (text === null) return { error: "agent_response_too_large" };
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, retryAfter: parseRetryAfter(response.headers.get("retry-after"), json) };
  }

  return {
    name: "nimble-agent",
    configured: true,

    async start({ event, context, reason, effort, signal }): Promise<AgentStart> {
      const body = {
        input: buildAgentPrompt({ category: event.category, title: event.title, locationTerms: context.locationTerms, city: context.city, region: context.region, firstSeenAt: event.firstSeenAt, scheduledStartAt: event.scheduledStartAt, reason }),
        effort,
        use_case: "research",
        output_schema: AGENT_OUTPUT_SCHEMA,
        enable_events: false,
      };
      const r = await call("POST", AGENT_RUNS_PATH, signal, body);
      if ("error" in r) return { status: "unavailable", errorCode: r.error, retryAfterSeconds: null };
      if (r.status < 200 || r.status > 299) {
        const outcome = statusOutcome(r.status, r.retryAfter);
        const code = outcome.ok ? "agent_unexpected" : outcome.code.replace(/^nimble_/, "agent_");
        return { status: !outcome.ok && outcome.kind === "transient" ? "unavailable" : "permanent_error", errorCode: code, retryAfterSeconds: outcome.ok ? null : outcome.retryAfterSeconds };
      }
      const started = startSchema.safeParse(r.json);
      // Accepted but unreadable: a run may exist. The worker keeps its slot claimed (fails closed).
      if (!started.success) throw new Error("agent_start_unreadable");
      return { status: "started", runId: started.data.id, agentId: started.data.web_search_agent_id ?? null };
    },

    async poll(ref: AgentRunRef, signal: AbortSignal): Promise<AgentPoll> {
      if (!ref.agentId) return { status: "failed", errorCode: "agent_resource_unknown" };
      const runPath = `/v2/agents/${id(ref.agentId)}/runs/${id(ref.runId)}`;
      const state = await call("GET", runPath, signal);
      if ("error" in state) return { status: "unavailable", errorCode: state.error };
      if (state.status === 404) return { status: "failed", errorCode: "agent_run_not_found" };
      if (state.status < 200 || state.status > 299) return { status: "unavailable", errorCode: `agent_http_${state.status}` };
      const run = runSchema.safeParse(state.json);
      if (!run.success) return { status: "unavailable", errorCode: "agent_malformed_response" };
      if (run.data.status === "queued" || run.data.status === "running") return { status: "running" };
      if (run.data.status !== "completed") return { status: "failed", errorCode: `agent_${run.data.status.replace(/[^a-z_]/gi, "").slice(0, 30) || "failed"}` };

      const result = await call("GET", `${runPath}/result`, signal);
      if ("error" in result) return { status: "unavailable", errorCode: result.error };
      if (result.status === 409) return { status: "running" };
      if (result.status === 422 || result.status === 404) return { status: "failed", errorCode: "agent_result_unavailable" };
      if (result.status < 200 || result.status > 299) return { status: "unavailable", errorCode: `agent_http_${result.status}` };
      const parsed = parseAgentResult(result.json);
      if (!parsed) return { status: "failed", errorCode: "agent_malformed_result" };
      return { status: "completed", ...parsed };
    },

    async cleanup(ref: AgentRunRef, signal: AbortSignal): Promise<AgentCleanup> {
      if (!ref.agentId) return "failed";
      const r = await call("DELETE", `/v2/agents/${id(ref.agentId)}`, signal);
      if ("error" in r) return "failed";
      if (r.status === 404) return "not_found";
      return r.status >= 200 && r.status <= 299 ? "deleted" : "failed";
    },
  };
}
