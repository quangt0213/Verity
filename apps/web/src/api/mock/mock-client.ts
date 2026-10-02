import {
  bboxContains,
  CATEGORY_KIND,
  communityResponseInputSchema,
  isActiveStatus,
  listEventsQuerySchema,
  reportEventInputSchema,
  toEventSummary,
  type EventDetail,
  type EventStatus,
  type ListEventsResponse,
  type TimelineEntry,
} from "@verity/contracts";
import type { z } from "zod";
import { haversineMeters } from "../../lib/geo";
import { assertSafeId, VerityApiError } from "../errors";
import { AUTH_UNAVAILABLE_MESSAGE, type VerityApi, type WriteResult } from "../types";
import { buildDemoEvents } from "./fixtures";

export interface MockApiOptions {
  writes: "off" | "simulate";
  now?: () => Date;
  /** [min, max] artificial latency in ms. */
  latencyMs?: [number, number];
  /** Simulated verification timings for demo reports, in ms. */
  verificationDelaysMs?: { start: number; unavailable: number };
}

const STATUS_ORDER: Record<EventStatus, number> = {
  VERIFIED: 0,
  LIKELY: 1,
  CONFLICTING: 2,
  DEVELOPING: 3,
  UNVERIFIED: 4,
  STALE: 5,
  RESOLVED: 6,
  REJECTED: 7,
};

function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    fields[key] ??= issue.message;
  }
  return fields;
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * In-memory demo implementation of the Verity API.
 *
 * It mirrors the real contract (same schemas, same validation) so UI code is
 * identical against both. It never pretends to verify anything: a simulated
 * report stays UNVERIFIED and ends up "verification unavailable", because
 * there is no live verification service behind demo data.
 */
export function createMockApi(options: MockApiOptions): VerityApi {
  const now = options.now ?? (() => new Date());
  const [minLatency, maxLatency] = options.latencyMs ?? [250, 650];
  const delays = options.verificationDelaysMs ?? { start: 3_000, unavailable: 15_000 };
  const events = new Map<string, EventDetail>(buildDemoEvents(now()).map((e) => [e.id, e]));
  const responded = new Set<string>();
  let counter = 0;

  const wait = () =>
    new Promise<void>((resolve) => setTimeout(resolve, minLatency + Math.random() * (maxLatency - minLatency)));

  async function delayed<T>(fn: () => T, signal?: AbortSignal): Promise<T> {
    await wait();
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return fn();
  }

  function update(id: string, patch: (e: EventDetail) => EventDetail) {
    const current = events.get(id);
    if (current) events.set(id, patch(current));
  }

  function appendTimeline(e: EventDetail, entry: Omit<TimelineEntry, "id">): EventDetail {
    return { ...e, timeline: [...e.timeline, { ...entry, id: `${e.id.slice(-6)}-tl-${e.timeline.length + 1}` }] };
  }

  function simulateVerification(id: string) {
    setTimeout(() => {
      update(id, (e) =>
        appendTimeline(
          { ...e, verification_state: "in_progress" },
          {
            at: now().toISOString(),
            kind: "verification_started",
            label: "Verification started",
            detail: null,
            from_status: null,
            to_status: null,
            evidence_id: null,
          },
        ),
      );
    }, delays.start);
    setTimeout(() => {
      const at = now().toISOString();
      update(id, (e) =>
        appendTimeline(
          { ...e, verification_state: "unavailable", last_checked_at: at, last_updated_at: at },
          {
            at,
            kind: "verification_unavailable",
            label: "Verification unavailable in demo mode",
            detail: "Demo data has no live verification service, so nothing was checked or inferred.",
            from_status: null,
            to_status: null,
            evidence_id: null,
          },
        ),
      );
    }, delays.unavailable);
  }

  const notRecorded = async <T>(): Promise<WriteResult<T>> => ({
    ok: false,
    error: { code: "auth_unavailable", message: AUTH_UNAVAILABLE_MESSAGE },
  });

  return {
    mode: "mock",
    writePolicy: options.writes === "simulate" ? { enabled: true, simulated: true } : { enabled: false, reason: "auth_unavailable" },
    sourceLabel: "Demo data (built in, not real events)",

    listEvents(query, signal) {
      return delayed((): ListEventsResponse => {
        const parsed = listEventsQuerySchema.safeParse(query);
        if (!parsed.success) throw new VerityApiError("validation_failed", "Invalid event query", 400);
        const { bbox, categories, statuses, q } = parsed.data;
        const needle = q?.toLowerCase();
        const matches = [...events.values()].filter((e) => {
          if (bbox && !bboxContains(bbox, e.coordinates)) return false;
          if (categories && !categories.includes(e.category)) return false;
          if (statuses ? !statuses.includes(e.status) : e.status === "REJECTED") return false;
          if (needle) {
            const haystack = `${e.title} ${e.approximate_location} ${e.summary}`.toLowerCase();
            if (!haystack.includes(needle)) return false;
          }
          return true;
        });
        matches.sort(
          (a, b) =>
            Number(isActiveStatus(b.status)) - Number(isActiveStatus(a.status)) ||
            STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
            b.last_updated_at.localeCompare(a.last_updated_at),
        );
        return { events: matches.map(toEventSummary), generated_at: now().toISOString(), truncated: false };
      }, signal);
    },

    getEvent(id, signal) {
      return delayed(() => {
        const event = events.get(assertSafeId(id));
        if (!event) throw new VerityApiError("not_found", "Event not found", 404);
        return event;
      }, signal);
    },

    getEvidence(id, signal) {
      return delayed(() => {
        const event = events.get(assertSafeId(id));
        if (!event) throw new VerityApiError("not_found", "Event not found", 404);
        return event.evidence;
      }, signal);
    },

    async reportEvent(input) {
      if (options.writes !== "simulate") return notRecorded();
      const parsed = reportEventInputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          error: { code: "validation_failed", message: "Please fix the highlighted fields.", fields: fieldErrors(parsed.error) },
        };
      }
      await wait();
      const report = parsed.data;
      const at = now().toISOString();

      // Same idea as server-side duplicate detection: nearby + same kind + similar wording.
      const reportTokens = tokens(`${report.title} ${report.description ?? ""}`);
      const duplicate = [...events.values()].find(
        (e) =>
          isActiveStatus(e.status) &&
          CATEGORY_KIND[e.category] === CATEGORY_KIND[report.category] &&
          (e.category === report.category || jaccard(reportTokens, tokens(e.title)) >= 0.5) &&
          haversineMeters(e.coordinates, report.location.coordinates) <= 300 &&
          jaccard(reportTokens, tokens(`${e.title} ${e.summary}`)) >= 0.2,
      );
      if (duplicate) {
        update(duplicate.id, (e) =>
          appendTimeline(
            { ...e, community_confirmation_count: e.community_confirmation_count + 1, last_updated_at: at },
            {
              at,
              kind: "report_merged",
              label: "Similar report merged into this event",
              detail: null,
              from_status: null,
              to_status: null,
              evidence_id: null,
            },
          ),
        );
        return { ok: true, simulated: true, data: { event_id: duplicate.id, outcome: "attached_to_existing" } };
      }

      counter += 1;
      const id = `00000000-0000-4000-9000-${String(900_000 + counter).padStart(12, "0")}`;
      const created: EventDetail = {
        id,
        title: report.title,
        summary: report.description ?? "",
        category: report.category,
        coordinates: report.location.coordinates,
        approximate_location: report.location.label ?? "Location chosen on the map",
        affected_area: null,
        status: "UNVERIFIED",
        verification_state: "queued",
        origin: "community_report",
        source_count: 1,
        independent_source_count: 1,
        community_confirmation_count: 0,
        community_dispute_count: 0,
        first_seen_at: at,
        last_updated_at: at,
        last_verified_at: null,
        last_checked_at: null,
        scheduled_start_at: null,
        scheduled_end_at: null,
        expires_at: null,
        is_demo: true,
        current_claims: [{ id: `${id}-cl-1`, text: report.title, stance: "unconfirmed", evidence_ids: [`${id}-ev-1`] }],
        evidence_summary: "One community report. Not yet checked against other sources.",
        evidence: [
          {
            id: `${id}-ev-1`,
            event_id: id,
            source_type: "community_report",
            source_name: "Your report (demo)",
            source_url: report.source_url ?? null,
            source_domain: report.source_url ? new URL(report.source_url).hostname : null,
            publisher: null,
            published_at: at,
            retrieved_at: at,
            quote: report.description || report.title,
            agent_note: null,
            stance: "supports",
            source_class: "COMMUNITY",
            is_primary: true,
            lineage_id: `${id}-community`,
            counts_as_independent: true,
            freshness_state: "fresh",
            location_match: "unclear",
            time_match: "current",
          },
        ],
        timeline: [
          {
            id: `${id}-tl-1`,
            at,
            kind: "report_received",
            label: "Community report received",
            detail: null,
            from_status: null,
            to_status: null,
            evidence_id: null,
          },
        ],
        community: {
          window_minutes: 60,
          recent_confirmations: 0,
          recent_disputes: 0,
          resolved_reports: 0,
          still_happening: { yes: 0, no: 0, not_sure: 0 },
        },
      };
      events.set(id, created);
      simulateVerification(id);
      return { ok: true, simulated: true, data: { event_id: id, outcome: "created" } };
    },

    async respond(eventId, input) {
      if (options.writes !== "simulate") return notRecorded();
      const parsed = communityResponseInputSchema.safeParse(input);
      if (!parsed.success) {
        return { ok: false, error: { code: "validation_failed", message: "That response isn't valid.", fields: fieldErrors(parsed.error) } };
      }
      const event = events.get(eventId);
      if (!event) return { ok: false, error: { code: "not_found", message: "Event not found." } };
      const response = parsed.data;

      // One response of each kind per event, mirroring the server's uniqueness
      // rule. Updates are free text and may be added more than once.
      if (response.kind !== "update") {
        const key = `${eventId}:${response.kind}`;
        if (responded.has(key)) {
          return { ok: false, error: { code: "conflict", message: "You've already responded to this event." } };
        }
        responded.add(key);
      }
      await wait();

      const at = now().toISOString();
      update(eventId, (e) => {
        // Community input adjusts counts only. Status changes belong to the
        // verification engine, which demo mode does not run.
        const next = { ...e, last_updated_at: at, community: { ...e.community, still_happening: { ...e.community.still_happening } } };
        if (response.kind === "confirm") {
          next.community_confirmation_count += 1;
          next.community.recent_confirmations += 1;
        } else if (response.kind === "dispute") {
          next.community_dispute_count += 1;
          next.community.recent_disputes += 1;
        } else if (response.kind === "resolved") {
          next.community.resolved_reports += 1;
        } else if (response.kind === "still_happening") {
          next.community.still_happening[response.answer] += 1;
        }
        return response.kind === "update"
          ? appendTimeline(next, {
              at,
              kind: "community_update",
              label: "Community update added",
              detail: response.text,
              from_status: null,
              to_status: null,
              evidence_id: null,
            })
          : next;
      });
      return { ok: true, simulated: true, data: { accepted: true } };
    },
  };
}
