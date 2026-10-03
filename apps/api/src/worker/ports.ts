import type { EventCategory, EventStatus } from "@verity/contracts";
import type { NormalizedEvidence } from "../verification/evidence";
import type { SearchContext } from "../verification/geocoding";
import type { EscalationReason } from "../verification/rules";

/**
 * The worker's boundary to the outside world. Implementations (Nimble in S4/S5,
 * fakes in tests) translate their provider's responses INTO NormalizedEvidence;
 * nothing provider-specific crosses this boundary.
 *
 * Contract for every port: retrieval outcomes are not evidence. "No results",
 * "unavailable" and errors never mean the event is false.
 */

/** What a retriever may know about the event: wording, category, timing and derived place names. Never reporter identity. */
export interface EventForRetrieval {
  id: string;
  category: EventCategory;
  status: EventStatus;
  title: string;
  summary: string;
  firstSeenAt: Date;
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;
}

export type RetrievalStatus =
  | "ok"
  /** The provider answered and found nothing relevant. */
  | "no_results"
  /** Transient: timeout, rate limit, 5xx, network, malformed response. Retry later. */
  | "unavailable"
  /** Will not succeed on retry (e.g. rejected credentials or request). */
  | "permanent_error";

export interface RetrievalResult {
  status: RetrievalStatus;
  evidence: NormalizedEvidence[];
  /** Searches actually performed (for cost provenance). */
  searchCount: number;
  /** Short machine code, never a provider message or body. */
  errorCode: string | null;
  retryAfterSeconds: number | null;
  /** Cost/quality counters for analysis (logged by the worker). */
  stats?: { queries: number; performed: number; succeeded: number; results: number; accepted: number; usable: number };
}

export interface EvidenceRetriever {
  readonly name: string;
  /** False when no provider is configured: the worker then reports retrieval as unavailable without calling it. */
  readonly configured: boolean;
  search(request: { event: EventForRetrieval; context: SearchContext; maxSearches: number; signal: AbortSignal }): Promise<RetrievalResult>;
}

export type AgentStart =
  | { status: "started"; runId: string }
  | { status: "unavailable" | "permanent_error"; errorCode: string; retryAfterSeconds: number | null };

export type AgentPoll =
  | { status: "running" }
  | { status: "completed"; evidence: NormalizedEvidence[] }
  | { status: "failed" | "unavailable"; errorCode: string };

export interface AgentInvestigator {
  readonly name: string;
  readonly configured: boolean;
  /** Starts ONE bounded investigation. Each call may cost money: the worker calls it at most once per run. */
  start(request: {
    event: EventForRetrieval;
    context: SearchContext;
    reason: EscalationReason;
    effort: "low" | "medium";
    signal: AbortSignal;
  }): Promise<AgentStart>;
  poll(runId: string, signal: AbortSignal): Promise<AgentPoll>;
}

/** Ports for when no provider is configured: honest "unavailable", never fabricated evidence. */
export const unconfiguredRetriever: EvidenceRetriever = {
  name: "unconfigured",
  configured: false,
  search: async () => ({ status: "unavailable", evidence: [], searchCount: 0, errorCode: "retriever_not_configured", retryAfterSeconds: null }),
};

export const unconfiguredInvestigator: AgentInvestigator = {
  name: "unconfigured",
  configured: false,
  start: async () => ({ status: "permanent_error", errorCode: "agent_not_configured", retryAfterSeconds: null }),
  poll: async () => ({ status: "failed", errorCode: "agent_not_configured" }),
};
