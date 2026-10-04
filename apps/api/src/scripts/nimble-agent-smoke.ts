import { createNimbleInvestigator } from "../providers/nimble/agent";
import { agentEvidence } from "../verification/agent-evidence";
import { buildSearchContext } from "../verification/geocoding";
import { loadWorkerConfig } from "../worker/config";
import type { AgentPoll, EventForRetrieval } from "../worker/ports";

/**
 * OPT-IN live smoke test of the Nimble Web Search Agent: exactly ONE
 * low-effort investigation of ONE fixed, harmless public topic (traffic on a
 * public bridge), then cleanup of the agent resource it created.
 *
 *   NIMBLE_LIVE_SMOKE=1 npm run smoke:nimble-agent -w @verity/api
 *
 * Never part of npm test / npm run check. Uses no event, report or user data
 * and no database. Prints only safe metadata: statuses, counts, booleans and
 * timing. Never the key, the prompt answer, model reasoning, excerpts or URLs.
 * Cost at the documented price: low effort, $0.025 per task.
 */

const POLL_EVERY_MS = 5_000;
const POLL_LIMIT_MS = 180_000;

const keysOf = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort() : null);
const kind = (v: unknown) => (v === undefined ? "missing" : v === null ? "null" : Array.isArray(v) ? (v.length ? "array" : "empty_array") : typeof v);

/** Field names and counts of a result body: enough to see why citations lack excerpts, without exposing content. */
function describeShape(body: unknown): Record<string, unknown> {
  const output = (body as { output?: Record<string, unknown> })?.output;
  const content = output?.content as Record<string, unknown> | undefined;
  const sources = Array.isArray(content?.sources) ? (content!.sources as unknown[]) : null;
  const trust = output?.trust as Record<string, unknown> | undefined;
  const claims = Array.isArray(trust?.claims) ? (trust!.claims as Array<Record<string, unknown>>) : [];
  const citations = claims.flatMap((c) => (Array.isArray(c.citations) ? (c.citations as Array<Record<string, unknown>>) : []));
  const count = (values: string[]) => values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});
  return {
    topLevelKeys: keysOf(body),
    outputKeys: keysOf(output),
    outputType: typeof output?.type === "string" ? output.type : kind(output?.type),
    contentKind: kind(content),
    contentKeys: keysOf(content),
    sourcesCount: sources?.length ?? null,
    sourceItemKeys: [...new Set((sources ?? []).flatMap((s) => keysOf(s) ?? []))].sort(),
    sourceDateFieldKinds: count((sources ?? []).flatMap((s) => [`published_date:${kind((s as Record<string, unknown>)?.published_date)}`, `event_time:${kind((s as Record<string, unknown>)?.event_time)}`])),
    trustKeys: keysOf(trust),
    claimCount: claims.length,
    claimKeys: [...new Set(claims.flatMap((c) => keysOf(c) ?? []))].sort(),
    citationKeys: [...new Set(citations.flatMap((c) => keysOf(c) ?? []))].sort(),
    citationExcerptKinds: count(citations.map((c) => kind(c.excerpts))),
  };
}

async function main() {
  if (process.env.NIMBLE_LIVE_SMOKE !== "1") {
    console.error("Refusing: set NIMBLE_LIVE_SMOKE=1 to start one live low-effort Nimble agent run.");
    process.exit(2);
  }
  if (process.env.VITEST || process.env.CI) {
    console.error("Refusing: the live smoke test never runs under the test runner or CI.");
    process.exit(2);
  }
  const config = loadWorkerConfig(process.env);
  if (!config.nimble.apiKey) {
    console.error("NIMBLE_API_KEY is not set.");
    process.exit(2);
  }

  const now = new Date();
  // A fixed, synthetic investigation: no Verity event, report or person behind it.
  const event: EventForRetrieval = {
    id: "00000000-0000-4000-8000-000000000000",
    category: "parking_traffic",
    status: "DEVELOPING",
    title: "Heavy traffic on the Bay Bridge",
    summary: "",
    firstSeenAt: new Date(now.getTime() - 60 * 60_000),
    scheduledStartAt: null,
    scheduledEndAt: null,
  };
  const context = buildSearchContext(
    { category: event.category, title: event.title, approximateLocation: "San Francisco-Oakland Bay Bridge", reportLocationLabels: [] },
    { street: null, neighborhood: null, city: "San Francisco", region: "California", countryCode: "US", provider: "smoke", retrievedAt: now },
  );

  let calls = 0;
  let resultShape: Record<string, unknown> | null = null;
  // Counts requests, and records the SHAPE of the result (key names and counts, never values).
  const countingFetch: typeof fetch = async (input, init) => {
    calls += 1;
    const response = await fetch(input, init);
    if (!String(input).endsWith("/result") || !response.ok) return response;
    const text = await response.text();
    try {
      resultShape = describeShape(JSON.parse(text));
    } catch {
      resultShape = { parseable: false };
    }
    return new Response(text, { status: response.status, headers: response.headers });
  };
  const investigator = createNimbleInvestigator({ apiKey: config.nimble.apiKey, baseUrl: config.nimble.baseUrl, fetch: countingFetch });
  const started = performance.now();
  const report: Record<string, unknown> = { effort: "low", documentedCost: "$0.025 per low-effort task" };

  const start = await investigator.start({ event, context, reason: "insufficient_independent", effort: "low", signal: AbortSignal.timeout(30_000) }).catch(() => null);
  report.creationSucceeded = start?.status === "started";
  report.agentResourceReturned = start?.status === "started" && start.agentId !== null;
  if (!start || start.status !== "started") {
    report.startStatus = start?.status ?? "error";
    report.startCode = start ? start.errorCode : "start_threw";
    console.log(JSON.stringify({ ...report, requests: calls, elapsedMs: Math.round(performance.now() - started) }, null, 2));
    process.exit(1);
  }
  const ref = { runId: start.runId, agentId: start.agentId };

  let poll: AgentPoll = { status: "running" };
  let polls = 0;
  let pollErrors = 0;
  const deadline = Date.now() + POLL_LIMIT_MS;
  while (poll.status === "running" || poll.status === "unavailable") {
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_EVERY_MS));
    polls += 1;
    poll = await investigator.poll(ref, AbortSignal.timeout(30_000)).catch(() => ({ status: "unavailable" as const, errorCode: "poll_threw" }));
    if (poll.status === "unavailable") pollErrors += 1;
  }
  report.polls = polls;
  report.pollErrors = pollErrors;
  report.pollingSucceeded = poll.status === "completed" || poll.status === "failed";
  report.terminalState = poll.status === "running" || poll.status === "unavailable" ? "not_terminal_within_limit" : poll.status;
  if (poll.status === "failed") report.failureCode = poll.errorCode;
  if (poll.status === "completed") {
    const validated = agentEvidence({ citations: poll.citations, proposals: poll.proposals, category: event.category, context, now: new Date(), runId: ref.runId });
    report.citationCount = poll.citations.length;
    report.distinctCitedPages = new Set(poll.citations.map((c) => c.url)).size;
    report.citationsValidated = { acceptedAsEvidence: validated.stats.accepted, rejectedUrls: validated.stats.rejectedUrls, withoutExcerpt: validated.stats.withoutExcerpt };
    report.proposedTimes = validated.stats.proposedTimes;
    report.timesEstablishedByCitation = validated.stats.acceptedTimes;
    report.unsupportedProposals = validated.unsupported.length;
    report.evidenceStances = validated.evidence.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.stance]: (acc[e.stance] ?? 0) + 1 }), {});
    report.evidenceClasses = validated.evidence.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.sourceClass]: (acc[e.sourceClass] ?? 0) + 1 }), {});
  }

  report.resultShape = resultShape;

  // Clean up the agent resource the run created (also when the run didn't finish in time).
  report.cleanupResult = await investigator.cleanup(ref, AbortSignal.timeout(15_000)).catch(() => "failed");
  console.log(JSON.stringify({ ...report, requests: calls, elapsedMs: Math.round(performance.now() - started) }, null, 2));
}

void main();
