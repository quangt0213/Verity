import type { NormalizedEvidence } from "../../verification/evidence";
import type { OfficialSource } from "../../verification/official-sources";
import type { EvidenceRetriever, RetrievalResult } from "../../worker/ports";
import { createNimbleSearchClient, MAX_RESULTS, type NimbleSearchClient } from "./client";
import { normalizeResult } from "./normalize";
import { buildQueries } from "./query";

/**
 * EvidenceRetriever backed by Nimble Search. Runs the deterministic queries in
 * order, keeps whatever succeeded when a later query fails (a failed query is
 * never contradicting evidence), de-duplicates by canonical URL, and reports
 * counts for cost analysis.
 *
 * Early stop: q3 (title search) runs only if q1/q2 produced fewer than
 * `enoughUsable` usable items.
 */
export function createNimbleRetriever(options: {
  apiKey: string;
  baseUrl: string;
  now: () => Date;
  fetch?: typeof fetch;
  client?: NimbleSearchClient;
  registry?: readonly OfficialSource[];
  enoughUsable?: number;
}): EvidenceRetriever {
  const client = options.client ?? createNimbleSearchClient({ apiKey: options.apiKey, baseUrl: options.baseUrl, fetch: options.fetch });
  const enoughUsable = options.enoughUsable ?? 2;

  return {
    name: "nimble-search",
    configured: true,
    async search({ event, context, maxSearches, signal }): Promise<RetrievalResult> {
      const queries = buildQueries(event, context, { maxSearches, maxResults: MAX_RESULTS });
      const evidence = new Map<string, NormalizedEvidence>();
      const failures: Array<{ kind: "transient" | "permanent"; code: string; retryAfterSeconds: number | null }> = [];
      let performed = 0;
      let succeeded = 0;
      let results = 0;
      let usable = 0;

      for (const spec of queries) {
        if (spec.id === "q3" && usable >= enoughUsable) break;
        if (signal.aborted) {
          failures.push({ kind: "transient", code: "nimble_timeout", retryAfterSeconds: null });
          break;
        }
        performed += 1;
        const outcome = await client.search(spec, signal);
        if (!outcome.ok) {
          failures.push(outcome);
          // Credentials or payment problems won't fix themselves within this job.
          if (outcome.kind === "permanent" && (outcome.code === "nimble_auth" || outcome.code === "nimble_payment_required")) break;
          continue;
        }
        succeeded += 1;
        results += outcome.results.length;
        for (const item of outcome.results) {
          const normalized = normalizeResult(item, { category: event.category, context, query: spec.query, requestId: outcome.requestId, now: options.now(), registry: options.registry });
          if (!normalized.ok || evidence.has(normalized.evidence.canonicalUrl!)) continue;
          evidence.set(normalized.evidence.canonicalUrl!, normalized.evidence);
          if (normalized.usable) usable += 1;
        }
      }

      const stats = { queries: queries.length, performed, succeeded, results, accepted: evidence.size, usable };
      const firstFailure = failures[0] ?? null;
      const retryAfterSeconds = failures.reduce<number | null>((max, f) => (f.retryAfterSeconds && f.retryAfterSeconds > (max ?? 0) ? f.retryAfterSeconds : max), null);

      if (evidence.size > 0) {
        return { status: "ok", evidence: [...evidence.values()], searchCount: performed, errorCode: firstFailure ? `partial_${firstFailure.code}`.slice(0, 64) : null, retryAfterSeconds: null, stats };
      }
      if (firstFailure && failures.some((f) => f.kind === "transient")) {
        // Nothing usable came back and something failed transiently: results may exist. Retry rather than conclude.
        return { status: "unavailable", evidence: [], searchCount: performed, errorCode: firstFailure.code, retryAfterSeconds, stats };
      }
      if (firstFailure && succeeded === 0) {
        return { status: "permanent_error", evidence: [], searchCount: performed, errorCode: firstFailure.code, retryAfterSeconds: null, stats };
      }
      return { status: "no_results", evidence: [], searchCount: performed, errorCode: null, retryAfterSeconds: null, stats };
    },
  };
}
