import type { EventCategory, EventStatus } from "@verity/contracts";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { events, reports, sourceRecords } from "../db/schema";
import { fromSourceRecord, type NormalizedEvidence } from "../verification/evidence";
import { buildSearchContext, lookupPlace, type ReverseGeocoder, type SearchContext } from "../verification/geocoding";
import { assignLineages } from "../verification/lineage";
import { mergeWithStored } from "../verification/merge";
import { DEFAULT_POLICY, type VerificationPolicy } from "../verification/policy";
import { decide, type EscalationReason, type Retrieval } from "../verification/rules";
import { canonicalizeUrl } from "../verification/url";
import { activeSignals, applyVerification, triggerCounts, type TriggerCounts } from "./apply";
import type { WorkerConfig } from "./config";
import { setVerificationState } from "./effects";
import { heartbeat, lockOwnedJob, type Lease } from "./jobs";
import { combine, enrichWithExtracts, type EnrichmentResult } from "./enrich";
import type { AgentInvestigator, EventForRetrieval, EvidenceExtractor, EvidenceRetriever, RetrievalResult } from "./ports";
import { claimAgentSlot, ensureRun, reserveSearches, saveAgentRunId, settleSearches, type Run } from "./runs";
import { deferForBudget, settleFailure, type SettleOutcome } from "./settle";

/**
 * One attempt at one verification job:
 *
 *   short transaction: confirm lease, create/resume the logical run
 *   reads (no transaction): event, reporters' place labels, stored evidence
 *   external work (no transaction): geocode → search → [one bounded agent run]
 *   one atomic apply transaction (apply.ts)
 *
 * No database transaction is ever open while a provider is being called.
 */

export interface WorkerLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface WorkerDeps {
  db: Database;
  config: WorkerConfig;
  policy?: VerificationPolicy;
  retriever: EvidenceRetriever;
  extractor: EvidenceExtractor;
  investigator: AgentInvestigator;
  /** Already wrapped by the durable cache; null when no geocoding provider is configured. */
  geocoder: ReverseGeocoder | null;
  now: () => Date;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log: WorkerLog;
}

export type ProcessOutcome = "state_changed" | "no_change" | SettleOutcome;

interface Snapshot {
  event: EventForRetrieval & { latitude: number; longitude: number; approximateLocation: string };
  labels: string[];
  stored: NormalizedEvidence[];
  seen: TriggerCounts;
}

async function loadSnapshot(db: Database, eventId: string): Promise<Snapshot | null> {
  // Counts first: anything arriving after this point is caught by the follow-up check.
  const seen = await triggerCounts(db, eventId);
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) return null;
  const labelRows = await db
    .selectDistinct({ label: reports.locationLabel })
    .from(reports)
    .where(and(eq(reports.eventId, eventId), isNotNull(reports.locationLabel)))
    .limit(5);
  const stored = (await db.select().from(sourceRecords).where(eq(sourceRecords.eventId, eventId))).map(fromSourceRecord);
  return {
    event: {
      id: event.id,
      category: event.category as EventCategory,
      status: event.status as EventStatus,
      title: event.title,
      summary: event.summary,
      firstSeenAt: event.firstSeenAt,
      scheduledStartAt: event.scheduledStartAt,
      scheduledEndAt: event.scheduledEndAt,
      latitude: event.latitude,
      longitude: event.longitude,
      approximateLocation: event.approximateLocation,
    },
    labels: labelRows.map((r) => r.label!).filter(Boolean),
    stored,
    seen,
  };
}

/**
 * Re-validate what an adapter returned: external evidence must carry a valid
 * canonical URL (one record per resource). Anything else is dropped, never
 * guessed at.
 */
export function sanitizeEvidence(evidence: NormalizedEvidence[]): NormalizedEvidence[] {
  const out: NormalizedEvidence[] = [];
  const seen = new Set<string>();
  for (const e of evidence) {
    if (e.sourceType === "community_report" || !e.canonicalUrl) continue;
    const canonical = canonicalizeUrl(e.canonicalUrl);
    if (!canonical.ok || seen.has(canonical.url)) continue;
    seen.add(canonical.url);
    out.push({ ...e, id: null, canonicalUrl: canonical.url });
  }
  return out;
}

/** Merge each observation into the stored record for the same canonical URL (see merge.ts). */
export function mergeIntoStored(found: NormalizedEvidence[], stored: NormalizedEvidence[], policy: VerificationPolicy): NormalizedEvidence[] {
  const byUrl = new Map(stored.filter((e) => e.canonicalUrl).map((e) => [e.canonicalUrl!, e]));
  return found.flatMap((f) => {
    const merged = mergeWithStored(byUrl.get(f.canonicalUrl!), f, policy);
    return merged ? [merged] : [];
  });
}

function withTimeout(seconds: number): AbortSignal {
  return AbortSignal.timeout(Math.max(1, seconds) * 1000);
}

async function search(deps: WorkerDeps, snap: Snapshot, context: SearchContext): Promise<RetrievalResult> {
  const policy = deps.policy ?? DEFAULT_POLICY;
  try {
    return await deps.retriever.search({
      event: snap.event,
      context,
      maxSearches: deps.config.nimble.maxSearchesPerJob,
      signal: withTimeout(policy.external.searchTimeoutSeconds),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { status: "unavailable", evidence: [], searchCount: 0, errorCode: timedOut ? "search_timeout" : "search_error", retryAfterSeconds: null };
  }
}

type AgentOutcome =
  | { status: "completed"; evidence: NormalizedEvidence[] }
  | { status: "skipped"; code: string }
  | { status: "poll_timeout" }
  | { status: "lost_lease" };

/** At most ONE paid investigation per logical run, ever. Retries poll the saved run instead. */
async function investigate(deps: WorkerDeps, lease: Lease, run: Run, snap: Snapshot, context: SearchContext, reason: EscalationReason): Promise<AgentOutcome> {
  const policy = deps.policy ?? DEFAULT_POLICY;
  const { config } = deps;
  let runId = run.agentRunId;

  if (!runId) {
    if (run.agentRequestedAt) {
      // Claimed by an earlier attempt but no id was saved (crash or lost
      // response after the call). Fail closed: never buy a second one.
      return { status: "skipped", code: "agent_outcome_unknown" };
    }
    const slot = await claimAgentSlot(deps.db, { lease, runId: run.id, reason, config, now: deps.now() });
    if (slot.status === "lost_lease") return { status: "lost_lease" };
    if (slot.status !== "claimed") return { status: "skipped", code: slot.status === "already_claimed" ? "agent_outcome_unknown" : `agent_${slot.status}` };
    const effort = reason === "conflicting_sources" ? config.nimble.agentConflictEffort : config.nimble.agentEffort;
    let started;
    try {
      started = await deps.investigator.start({ event: snap.event, context, reason, effort, signal: withTimeout(policy.external.searchTimeoutSeconds) });
    } catch {
      // Unknown whether the provider created a run: the slot stays claimed (fail closed).
      return { status: "skipped", code: "agent_start_failed" };
    }
    if (started.status !== "started") return { status: "skipped", code: `agent_${started.errorCode}` };
    runId = started.runId;
    await saveAgentRunId(deps.db, run.id, runId);
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = deps.now().getTime() + config.nimble.agentPollTimeoutSeconds * 1000;
  while (deps.now().getTime() < deadline) {
    if (!(await heartbeat(deps.db, lease, deps.now()))) return { status: "lost_lease" };
    let poll;
    try {
      poll = await deps.investigator.poll(runId, withTimeout(policy.external.searchTimeoutSeconds));
    } catch {
      poll = { status: "running" as const };
    }
    if (poll.status === "completed") return { status: "completed", evidence: poll.evidence };
    if (poll.status === "failed") return { status: "skipped", code: "agent_failed" };
    await sleep(policy.external.agentPollIntervalSeconds * 1000);
  }
  return { status: "poll_timeout" };
}

export async function processJob(deps: WorkerDeps, lease: Lease): Promise<ProcessOutcome> {
  const policy = deps.policy ?? DEFAULT_POLICY;
  const { db, log } = deps;
  const fail = (kind: "transient" | "permanent", errorCode: string, retryAfterSeconds: number | null = null) =>
    settleFailure(db, lease, { kind, errorCode, retryAfterSeconds, now: deps.now(), random: deps.random, policy });

  try {
    const run = await db.transaction(async (tx) => {
      if (!(await lockOwnedJob(tx, lease))) return null;
      const r = await ensureRun(tx, lease, deps.now());
      await setVerificationState(tx, lease.eventId, "in_progress", deps.now());
      return r;
    });
    if (!run) return "lost_lease";

    const snap = await loadSnapshot(db, lease.eventId);
    if (!snap) return await fail("permanent", "event_missing");

    // Derived place names; a geocoder failure only means less context.
    const place = deps.geocoder
      ? (await lookupPlace(deps.geocoder, snap.event, withTimeout(policy.external.geocodeTimeoutSeconds))).place
      : null;
    const context = buildSearchContext(
      { category: snap.event.category, title: snap.event.title, approximateLocation: snap.event.approximateLocation, reportLocationLabels: snap.labels },
      place,
    );

    let retrieval: Retrieval;
    let found: NormalizedEvidence[] = [];
    let note: string | null = null;
    let stats: RetrievalResult["stats"] | null = null;
    if (!context.searchable) {
      retrieval = "not_attempted";
      note = "no_searchable_location";
    } else if (!deps.retriever.configured) {
      return await fail("transient", "retriever_not_configured");
    } else {
      const reservation = await reserveSearches(db, lease, run.id, deps.config, deps.now());
      if (reservation.status === "lost_lease") return "lost_lease";
      if (reservation.status === "budget_exhausted") return await deferForBudget(db, lease, { now: deps.now(), reason: "search_budget_exhausted", policy });
      const result = await search(deps, snap, context);
      await settleSearches(db, run.id, reservation, result.searchCount);
      if (result.status === "unavailable") return await fail("transient", result.errorCode ?? "search_unavailable", result.retryAfterSeconds);
      if (result.status === "permanent_error") return await fail("permanent", result.errorCode ?? "search_rejected");
      retrieval = result.status;
      found = sanitizeEvidence(result.evidence);
      stats = result.stats ?? null;
      // A partial search (some queries failed) still applies what succeeded; record why.
      if (result.errorCode) note = result.errorCode;
    }

    // One record per resource: fold this run's observations into the stored records.
    found = mergeIntoStored(found, snap.stored, policy);
    const community = await activeSignals(db, lease.eventId);

    // Deterministic enrichment: read selected pages (Extract), stopping as soon as the decision is settled.
    let enrichment: EnrichmentResult = { found, extracts: 0, pagesUsed: 0, stop: "disabled", note: null };
    if (retrieval === "ok" && found.length > 0) {
      const result = await enrichWithExtracts(deps, { lease, run, event: snap.event, context, stored: snap.stored, found, community, retrieval });
      if (result === "lost_lease") return "lost_lease";
      enrichment = result;
      found = result.found;
      note ??= result.note;
    }

    // Escalate only if ordinary evidence leaves a real question, and only once per run.
    const preliminary = decide({ event: snap.event, evidence: assignLineages(combine(snap.stored, found), policy), community, retrieval, now: deps.now(), policy });
    const agentAllowed = deps.investigator.configured && deps.config.nimble.dailyAgentBudget > 0 && deps.config.nimble.agentMaxPerEvent > 0;
    // Cheaper deterministic options come first: while extraction is blocked (outage, budget), the Agent waits.
    const agentHeldBack = enrichment.stop === "blocked";
    if (preliminary.escalation && agentAllowed && agentHeldBack) note ??= "agent_held_extract_blocked";
    if (preliminary.escalation && agentAllowed && !agentHeldBack && context.searchable) {
      const agent = await investigate(deps, lease, run, snap, context, preliminary.escalation);
      if (agent.status === "lost_lease") return "lost_lease";
      if (agent.status === "poll_timeout") {
        // The saved run id is polled again on the next attempt (no new purchase).
        if (lease.attempt < lease.maxAttempts) return await fail("transient", "agent_poll_timeout");
        note = "agent_poll_timeout";
      } else if (agent.status === "skipped") {
        note = agent.code;
      } else {
        found = mergeIntoStored(sanitizeEvidence([...found, ...agent.evidence]), snap.stored, policy);
      }
    }

    const applied = await applyVerification(db, { lease, runId: run.id, evidence: found, retrieval, note, now: deps.now(), seen: snap.seen, policy });
    if (applied.outcome === "lost_lease") return "lost_lease";
    log.info(
      {
        jobId: lease.jobId,
        eventId: lease.eventId,
        attempt: lease.attempt,
        outcome: applied.outcome,
        rule: applied.decision.ruleId,
        newSources: applied.newSourceIds.length,
        followUp: applied.followUp,
        note,
        searches: stats?.performed ?? null,
        extracts: enrichment.extracts,
        pagesUsed: enrichment.pagesUsed,
        enrichmentStop: enrichment.stop,
        results: stats?.results ?? null,
        accepted: stats?.accepted ?? null,
        usable: stats?.usable ?? null,
      },
      "verification applied",
    );
    return applied.outcome;
  } catch (error) {
    // Only a short code is logged: never messages that might carry data or secrets.
    log.error({ jobId: lease.jobId, eventId: lease.eventId, attempt: lease.attempt, error: error instanceof Error ? error.name : "unknown" }, "verification attempt failed");
    try {
      return await fail("transient", "worker_error");
    } catch {
      return "lost_lease"; // The lease reaper will recover the job.
    }
  }
}
