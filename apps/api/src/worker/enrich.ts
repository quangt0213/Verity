import { enrichWithPage } from "../verification/enrich";
import type { NormalizedEvidence } from "../verification/evidence";
import { selectExtractCandidates } from "../verification/extract-selection";
import type { SearchContext } from "../verification/geocoding";
import { assignLineages } from "../verification/lineage";
import { DEFAULT_POLICY } from "../verification/policy";
import { decide, type CommunitySignals, type Retrieval } from "../verification/rules";
import { heartbeat, type Lease } from "./jobs";
import type { EventForRetrieval, ExtractOutcome } from "./ports";
import type { WorkerDeps } from "./process";
import { reserveExtract, type Run } from "./runs";

/**
 * The deterministic enrichment stage: Search → candidate selection → Extract,
 * one page at a time, re-deciding after each page and stopping as soon as the
 * deterministic decision no longer asks for more evidence. The ceiling
 * (config.nimble.maxExtractsPerJob, at most 4) is a limit, not a target.
 *
 * Extraction is best-effort enrichment, never a reason to fail the job: a
 * page that can't be read is skipped; a provider outage or an exhausted
 * budget stops extraction and is reported, so the worker can hold back the
 * (more expensive) Agent while cheaper deterministic options remain unused.
 */

export type EnrichmentStop =
  /** Extraction is not configured or disabled by budget settings. */
  | "disabled"
  /** The evidence was already decisive; no (more) pages were needed. */
  | "decided"
  /** No eligible candidates remain. */
  | "exhausted"
  /** The per-job ceiling was reached. */
  | "ceiling"
  /** The provider was unavailable or rejected us, or today's budget ran out: cheap options remain unused. */
  | "blocked";

export interface EnrichmentResult {
  found: NormalizedEvidence[];
  /** Provider calls made (each counted on the run before the call). */
  extracts: number;
  /** Pages that enriched a record. */
  pagesUsed: number;
  stop: EnrichmentStop;
  note: string | null;
}

/** Stored records not re-observed in this run, plus this run's observations. */
export function combine(stored: NormalizedEvidence[], found: NormalizedEvidence[]): NormalizedEvidence[] {
  const urls = new Set(found.map((f) => f.canonicalUrl).filter(Boolean));
  return [...stored.filter((e) => !e.canonicalUrl || !urls.has(e.canonicalUrl)), ...found];
}

export async function enrichWithExtracts(
  deps: WorkerDeps,
  input: {
    lease: Lease;
    run: Run;
    event: EventForRetrieval;
    context: SearchContext;
    stored: NormalizedEvidence[];
    found: NormalizedEvidence[];
    community: CommunitySignals;
    retrieval: Retrieval;
  },
): Promise<EnrichmentResult | "lost_lease"> {
  const policy = deps.policy ?? DEFAULT_POLICY;
  const { config } = deps;
  const ceiling = Math.min(4, config.nimble.maxExtractsPerJob);
  let found = input.found;
  if (!deps.extractor.configured || ceiling === 0 || config.nimble.dailyExtractBudget === 0) {
    return { found, extracts: 0, pagesUsed: 0, stop: "disabled", note: null };
  }
  // The ceiling is per JOB: earlier attempts of this run already used some of it.
  const max = Math.max(0, ceiling - input.run.extractCount);
  if (max === 0) return { found, extracts: 0, pagesUsed: 0, stop: "ceiling", note: null };

  const settled = () =>
    decide({ event: input.event, evidence: assignLineages(combine(input.stored, found), policy), community: input.community, retrieval: input.retrieval, now: deps.now(), policy }).escalation === null;

  const candidates = selectExtractCandidates({ found, stored: input.stored, max, policy });
  let extracts = 0;
  let pagesUsed = 0;
  const skipped: string[] = [];

  for (const candidate of candidates) {
    if (settled()) return { found, extracts, pagesUsed, stop: "decided", note: skipped[0] ?? null };
    if (extracts >= max) return { found, extracts, pagesUsed, stop: "ceiling", note: skipped[0] ?? null };
    if (!(await heartbeat(deps.db, input.lease, deps.now()))) return "lost_lease";

    const reservation = await reserveExtract(deps.db, input.lease, input.run.id, config, deps.now());
    if (reservation.status === "lost_lease") return "lost_lease";
    if (reservation.status === "budget_exhausted") return { found, extracts, pagesUsed, stop: "blocked", note: "extract_budget_exhausted" };
    extracts += 1;

    let outcome: ExtractOutcome;
    try {
      outcome = await deps.extractor.extract({ url: candidate.canonicalUrl!, signal: AbortSignal.timeout(policy.external.extractTimeoutSeconds * 1000) });
    } catch {
      outcome = { status: "unavailable", code: "extract_error", retryAfterSeconds: null };
    }
    if (outcome.status === "unavailable" || outcome.status === "permanent_error") {
      return { found, extracts, pagesUsed, stop: "blocked", note: outcome.code };
    }
    if (outcome.status === "page_failed") {
      skipped.push(outcome.code);
      continue;
    }
    const enriched = enrichWithPage(candidate, outcome.page, { category: input.event.category, context: input.context, policy });
    if (!enriched.ok) {
      skipped.push(`extract_${enriched.reason}`);
      continue;
    }
    // The same record, enriched in place: Search and Extract never become two sources.
    found = found.map((f) => (f.canonicalUrl === candidate.canonicalUrl ? enriched.evidence : f));
    pagesUsed += 1;
  }
  return { found, extracts, pagesUsed, stop: settled() ? "decided" : extracts >= max ? "ceiling" : "exhausted", note: skipped[0] ?? null };
}
