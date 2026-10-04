import { and, asc, isNotNull, isNull, notInArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { OPEN_RUN_OUTCOMES, verificationRuns } from "../db/schema";
import { agentEvidence, citedPageTarget, establishTime, eventSentences, type UnsupportedProposal } from "../verification/agent-evidence";
import { enrichWithPage } from "../verification/enrich";
import type { NormalizedEvidence } from "../verification/evidence";
import { selectExtractCandidates } from "../verification/extract-selection";
import type { SearchContext } from "../verification/geocoding";
import { mergeWithStored, unionSteps, withEventTime } from "../verification/merge";
import { DEFAULT_POLICY } from "../verification/policy";
import type { EscalationReason } from "../verification/rules";
import type { EnrichmentStop } from "./enrich";
import { heartbeat, type Lease } from "./jobs";
import type { AgentCitation, AgentInvestigator, AgentProposal, AgentRunRef, EventForRetrieval, ExtractOutcome } from "./ports";
import type { WorkerDeps } from "./process";
import { claimAgentSlot, markAgentCleanedUp, reserveExtract, saveAgentRun, type Run } from "./runs";

/**
 * Agent escalation: the LAST, exceptional step.
 *
 *   Search → Extract → deterministic decision → Agent (only if still needed)
 *     → citations become evidence → deterministic decision again
 *
 * A new (paid) investigation starts only when the decision still asks for one
 * (insufficient, conflicting or ambiguous evidence) AND the cheaper
 * deterministic options are used up: extraction finished its candidates or hit
 * its ceiling, or is disabled. It never starts while extraction is blocked by
 * an outage or budget, and never just because a result lacked a date or a
 * source is unidentified. A saved, already-paid run is always resumed
 * (polling is free). Budgets, cooldown and lifetime caps apply (runs.ts).
 */

export interface AgentGate {
  /** Start a new investigation now. */
  start: boolean;
  /** Why an otherwise-justified investigation was held back. */
  heldCode: string | null;
}

export function agentGate(input: { escalation: EscalationReason | null; enrichmentStop: EnrichmentStop; searchable: boolean; enabled: boolean }): AgentGate {
  if (!input.escalation || !input.enabled || !input.searchable) return { start: false, heldCode: null };
  if (input.enrichmentStop === "blocked") return { start: false, heldCode: "agent_held_extract_blocked" };
  if (input.enrichmentStop === "decided") return { start: false, heldCode: null };
  return { start: true, heldCode: null };
}

export type AgentOutcome =
  | { status: "completed"; ref: AgentRunRef; citations: AgentCitation[]; proposals: AgentProposal[] }
  /** Not run, or ended without a usable result. `ref` is set when a provider resource exists (for cleanup). */
  | { status: "skipped"; code: string; ref: AgentRunRef | null }
  | { status: "poll_timeout" }
  | { status: "lost_lease" };

const timeout = (seconds: number) => AbortSignal.timeout(Math.max(1, seconds) * 1000);

/**
 * At most ONE paid investigation per logical run, ever. `reason` null means
 * "resume only": poll a saved run, never start one.
 */
export async function investigate(
  deps: WorkerDeps,
  input: { lease: Lease; run: Run; event: EventForRetrieval; context: SearchContext; reason: EscalationReason | null },
): Promise<AgentOutcome> {
  const policy = deps.policy ?? DEFAULT_POLICY;
  const { config } = deps;
  const { lease, run } = input;
  let ref: AgentRunRef | null = run.agentRunId ? { runId: run.agentRunId, agentId: run.agentId } : null;

  if (!ref) {
    if (run.agentRequestedAt) {
      // Claimed by an earlier attempt but no id was saved (crash or lost
      // response after the call). Fail closed: never buy a second one.
      return { status: "skipped", code: "agent_outcome_unknown", ref: null };
    }
    if (!input.reason) return { status: "skipped", code: "agent_not_needed", ref: null };
    const slot = await claimAgentSlot(deps.db, { lease, runId: run.id, reason: input.reason, config, now: deps.now() });
    if (slot.status === "lost_lease") return { status: "lost_lease" };
    if (slot.status !== "claimed") return { status: "skipped", code: slot.status === "already_claimed" ? "agent_outcome_unknown" : `agent_${slot.status}`, ref: null };
    const effort = input.reason === "conflicting_sources" ? config.nimble.agentConflictEffort : config.nimble.agentEffort;
    let started;
    try {
      started = await deps.investigator.start({ event: input.event, context: input.context, reason: input.reason, effort, signal: timeout(policy.external.searchTimeoutSeconds) });
    } catch {
      // Unknown whether the provider created a run: the slot stays claimed (fail closed).
      return { status: "skipped", code: "agent_start_failed", ref: null };
    }
    if (started.status !== "started") return { status: "skipped", code: `agent_${started.errorCode}`.slice(0, 64), ref: null };
    ref = { runId: started.runId, agentId: started.agentId };
    await saveAgentRun(deps.db, run.id, { agentRunId: ref.runId, agentId: ref.agentId });
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = deps.now().getTime() + config.nimble.agentPollTimeoutSeconds * 1000;
  while (deps.now().getTime() < deadline) {
    if (!(await heartbeat(deps.db, lease, deps.now()))) return { status: "lost_lease" };
    let poll;
    try {
      poll = await deps.investigator.poll(ref, timeout(policy.external.searchTimeoutSeconds));
    } catch {
      poll = { status: "running" as const };
    }
    if (poll.status === "completed") return { status: "completed", ref, citations: poll.citations, proposals: poll.proposals };
    if (poll.status === "failed") return { status: "skipped", code: poll.errorCode.startsWith("agent_") ? poll.errorCode.slice(0, 64) : "agent_failed", ref };
    await sleep(policy.external.agentPollIntervalSeconds * 1000);
  }
  return { status: "poll_timeout" };
}

/**
 * Remove the provider resource the investigation created, once its run is over.
 * Never affects the verdict; a failure is reported and retried by the sweep.
 */
export async function cleanupAgent(deps: Pick<WorkerDeps, "db" | "investigator" | "now">, runRowId: string, ref: AgentRunRef | null): Promise<"cleaned" | "failed" | "nothing"> {
  if (!ref?.agentId) return "nothing";
  let result;
  try {
    result = await deps.investigator.cleanup(ref, AbortSignal.timeout(15_000));
  } catch {
    result = "failed" as const;
  }
  if (result === "failed") return "failed";
  await markAgentCleanedUp(deps.db, runRowId, deps.now());
  return "cleaned";
}

/** Finished runs whose agent resource still exists (cleanup failed earlier): retry, a few per sweep. Free calls only. */
export async function sweepAgentResources(db: Database, investigator: AgentInvestigator, now: () => Date, limit = 10): Promise<number> {
  if (!investigator.configured) return 0;
  const rows = await db
    .select({ id: verificationRuns.id, agentRunId: verificationRuns.agentRunId, agentId: verificationRuns.agentId })
    .from(verificationRuns)
    .where(and(isNotNull(verificationRuns.agentId), isNull(verificationRuns.agentCleanedUpAt), notInArray(verificationRuns.outcome, [...OPEN_RUN_OUTCOMES])))
    .orderBy(asc(verificationRuns.startedAt))
    .limit(limit);
  let cleaned = 0;
  for (const row of rows) {
    if ((await cleanupAgent({ db, investigator, now }, row.id, { runId: row.agentRunId!, agentId: row.agentId })) === "cleaned") cleaned += 1;
  }
  return cleaned;
}

export interface AgentEvidenceUse {
  found: NormalizedEvidence[];
  /** Pages read to check claims the citations didn't establish. */
  extracts: number;
  stats: ReturnType<typeof agentEvidence>["stats"] & { unsupported: number; reextracted: number; establishedByPage: number; pagesFromCitations: number };
  note: string | null;
}

/**
 * Turn a completed investigation into evidence (citations only, agent-evidence.ts),
 * merge it into this run's records (one record per resource), then read the
 * cited page (Extract) ONLY for claims the citation did not establish, within
 * the job's remaining extraction ceiling. The model's value is never used:
 * a page read can only supply its own publication metadata, or an event-time
 * sentence that explicitly states the proposed time.
 */
export async function useAgentResult(
  deps: WorkerDeps,
  input: {
    lease: Lease;
    run: Run;
    event: EventForRetrieval;
    context: SearchContext;
    stored: NormalizedEvidence[];
    found: NormalizedEvidence[];
    outcome: Extract<AgentOutcome, { status: "completed" }>;
    /** Extractions still allowed for this job (ceiling minus what was used), 0 when extraction is unavailable. */
    extractsLeft: number;
  },
): Promise<AgentEvidenceUse | "lost_lease"> {
  const policy = deps.policy ?? DEFAULT_POLICY;
  const now = deps.now();
  const result = agentEvidence({ citations: input.outcome.citations, proposals: input.outcome.proposals, category: input.event.category, context: input.context, now, runId: input.outcome.ref.runId, policy });

  // One record per resource: a cited page already found by Search (or stored earlier) merges with it.
  const byUrl = new Map(input.found.map((f) => [f.canonicalUrl!, f]));
  const storedByUrl = new Map(input.stored.filter((s) => s.canonicalUrl).map((s) => [s.canonicalUrl!, s]));
  for (const e of result.evidence) {
    const existing = byUrl.get(e.canonicalUrl!) ?? storedByUrl.get(e.canonicalUrl!);
    const merged = existing ? mergeWithStored(existing, e, policy) : e;
    if (merged) byUrl.set(e.canonicalUrl!, { ...merged, retrievalSteps: unionSteps(existing?.retrievalSteps ?? [], e.retrievalSteps) });
  }
  let found = [...byUrl.values()];

  // Conditional re-extraction, best candidates first: cited pages with an unsupported proposal, and cited
  // pages with no verbatim text at all (those become evidence ONLY if the page itself is read).
  const unsupportedByUrl = new Map<string, UnsupportedProposal[]>();
  for (const u of result.unsupported) unsupportedByUrl.set(u.url, [...(unsupportedByUrl.get(u.url) ?? []), u]);
  const needing = found.filter((f) => unsupportedByUrl.has(f.canonicalUrl!) && f.retrievalSteps.includes("agent"));
  const known = new Set([...found, ...input.stored].map((f) => f.canonicalUrl).filter(Boolean));
  const placeholders = result.excerptless
    .filter((c) => !known.has(c.url))
    .map((c) => citedPageTarget(c, { category: input.event.category, context: input.context, now, runId: input.outcome.ref.runId }));
  const targets = selectExtractCandidates({ found: [...needing, ...placeholders], stored: input.stored, max: input.extractsLeft, policy });
  let pagesFromCitations = 0;
  let extracts = 0;
  let establishedByPage = 0;
  let note: string | null = null;
  for (const target of targets) {
    if (!(await heartbeat(deps.db, input.lease, deps.now()))) return "lost_lease";
    const reservation = await reserveExtract(deps.db, input.lease, input.run.id, deps.config, deps.now());
    if (reservation.status === "lost_lease") return "lost_lease";
    if (reservation.status === "budget_exhausted") {
      note = "extract_budget_exhausted";
      break;
    }
    extracts += 1;
    let outcome: ExtractOutcome;
    try {
      outcome = await deps.extractor.extract({ url: target.canonicalUrl!, signal: AbortSignal.timeout(policy.external.extractTimeoutSeconds * 1000) });
    } catch {
      outcome = { status: "unavailable", code: "extract_error", retryAfterSeconds: null };
    }
    if (outcome.status === "unavailable" || outcome.status === "permanent_error") {
      note = outcome.code;
      break;
    }
    if (outcome.status === "page_failed") continue;
    const enriched = enrichWithPage(target, outcome.page, { category: input.event.category, context: input.context, policy });
    if (!enriched.ok) continue;
    let updated = enriched.evidence;
    if (updated.publishedAt) establishedByPage += 1;
    // An event time only from a page sentence that mentions the event and explicitly states the proposed time.
    const proposedEventTime = unsupportedByUrl.get(target.canonicalUrl!)?.find((u) => u.field === "event_time")?.proposed;
    if (proposedEventTime && !updated.eventTimeAsReported) {
      const t = establishTime(proposedEventTime, eventSentences(outcome.page.text, input.event.category), now, policy);
      if (t) {
        updated = withEventTime(updated, t);
        establishedByPage += 1;
      }
    }
    if (found.some((f) => f.canonicalUrl === target.canonicalUrl)) {
      found = found.map((f) => (f.canonicalUrl === target.canonicalUrl ? updated : f));
    } else if (enriched.excerptFromPage) {
      // A text-less citation becomes evidence only through the page's own words.
      found = [...found, updated];
      pagesFromCitations += 1;
    }
  }
  return { found, extracts, stats: { ...result.stats, unsupported: result.unsupported.length, reextracted: extracts, establishedByPage, pagesFromCitations }, note };
}
