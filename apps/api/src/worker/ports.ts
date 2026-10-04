import type { EventCategory, EventStatus } from "@verity/contracts";
import type { ExtractedPage } from "../verification/enrich";
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
  stats?: { queries: number; performed: number; succeeded: number; results: number; accepted: number; usable: number; promising?: number };
}

export interface EvidenceRetriever {
  readonly name: string;
  /** False when no provider is configured: the worker then reports retrieval as unavailable without calling it. */
  readonly configured: boolean;
  search(request: { event: EventForRetrieval; context: SearchContext; maxSearches: number; signal: AbortSignal }): Promise<RetrievalResult>;
}

/** One page read by an extractor, reduced to the fields Verity needs (no raw HTML or full body). */
export type { ExtractedPage };

export type ExtractOutcome =
  | { status: "ok"; page: ExtractedPage }
  /** This page can't be used (blocked, failed, unsafe redirect, no content); try another candidate. */
  | { status: "page_failed"; code: string }
  /** The provider itself is unavailable (rate limit, 5xx, timeout): stop extracting for now. */
  | { status: "unavailable"; code: string; retryAfterSeconds: number | null }
  /** Credentials or account problems: stop extracting. */
  | { status: "permanent_error"; code: string };

export interface EvidenceExtractor {
  readonly name: string;
  readonly configured: boolean;
  /**
   * Read ONE page. Each call may cost money. Callers pass only URLs that a
   * provider (Search, or an Agent citation) returned: never user-submitted
   * links or report text.
   */
  extract(request: { url: string; signal: AbortSignal }): Promise<ExtractOutcome>;
}

export const unconfiguredExtractor: EvidenceExtractor = {
  name: "unconfigured",
  configured: false,
  extract: async () => ({ status: "permanent_error", code: "extractor_not_configured" }),
};

/** The provider's identifiers for one investigation: the run, and the resource it belongs to (needed to poll and clean up). */
export interface AgentRunRef {
  runId: string;
  /** Null only for runs saved before migration 0005; such runs can't be polled (fail closed). */
  agentId: string | null;
}

export type AgentStart =
  | { status: "started"; runId: string; agentId: string | null }
  | { status: "unavailable" | "permanent_error"; errorCode: string; retryAfterSeconds: number | null };

/**
 * What a completed investigation may hand to Verity: CITATIONS ONLY. A
 * citation is a URL the provider read plus verbatim excerpts from it. The
 * investigator can't return evidence records, a source class, a stance or a
 * verdict; agent-evidence.ts derives everything deterministically from the
 * citations, and the decision engine decides.
 */
export interface AgentCitation {
  url: string;
  title: string | null;
  /** Verbatim excerpts from the page, as the provider quoted them. */
  excerpts: string[];
  /** The provider's labels, recorded for analysis only: never a source class. */
  providerCategory: string | null;
  providerSourceType: string | null;
}

/**
 * Model-proposed fields for a cited URL. NOT evidence: a proposal only says
 * which time to look for, and it becomes a time only if the cited excerpt (or
 * the page itself, via Extract) explicitly establishes it.
 */
export interface AgentProposal {
  url: string;
  publishedAt: string | null;
  eventTime: string | null;
}

export type AgentPoll =
  | { status: "running" }
  | { status: "completed"; citations: AgentCitation[]; proposals: AgentProposal[] }
  | { status: "failed" | "unavailable"; errorCode: string };

export type AgentCleanup = "deleted" | "not_found" | "failed";

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
  poll(ref: AgentRunRef, signal: AbortSignal): Promise<AgentPoll>;
  /** Remove (deactivate) the resource an investigation created, after it finished. Free; failure never affects the verdict. */
  cleanup(ref: AgentRunRef, signal: AbortSignal): Promise<AgentCleanup>;
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
  cleanup: async () => "failed",
};
