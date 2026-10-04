import {
  bboxContains,
  CATEGORY_KIND,
  communityResponseInputSchema,
  haversineMeters,
  isActiveStatus,
  jaccard,
  textTokens,
  listEventsQuerySchema,
  reportEventInputSchema,
  toEventSummary,
  type EventDetail,
  type EventStatus,
  type SignalType,
  type ListEventsResponse,
  type TimelineEntry,
} from "@verity/contracts";
import type { z } from "zod";
import { assertSafeId, VerityApiError } from "../errors";
import { readStored, STORAGE_KEYS, writeStored } from "../../lib/storage";
import { AUTH_UNAVAILABLE_MESSAGE, signalTypeFor, type VerityApi, type WriteResult } from "../types";
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
  /** The demo viewer's active answers per event, mirroring the service's one-answer-per-question rule. */
  const answers = new Map<string, Map<"validity" | "current_state", SignalType>>();
  let counter = 0;

  const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
  const readFollows = () =>
    readStored(STORAGE_KEYS.follows, (raw) => (Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string" && SAFE_ID.test(v)) : null), [] as string[]);

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
    writePolicy:
      options.writes === "simulate" ? { enabled: true, simulated: true, requiresSignIn: false } : { enabled: false, reason: "auth_unavailable" },
    sourceLabel: "Demo data (built in, not real events)",
    supportsUpdates: true,
    auth: null,

    async getMySignals(eventId) {
      return [...(answers.get(eventId)?.values() ?? [])];
    },

    async setFollowing(eventId, following) {
      if (!SAFE_ID.test(eventId)) return { ok: false, error: { code: "not_found", message: "Event not found." } };
      const current = readFollows().filter((id) => id !== eventId);
      writeStored(STORAGE_KEYS.follows, following ? [eventId, ...current].slice(0, 200) : current);
      return { ok: true, simulated: true, data: { following } };
    },

    listFollowing(signal) {
      return delayed(
        () =>
          readFollows()
            .map((id) => events.get(id))
            .filter((e): e is EventDetail => Boolean(e))
            .map(toEventSummary),
        signal,
      );
    },

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
      const reportTokens = textTokens(`${report.title} ${report.description ?? ""}`);
      const duplicate = [...events.values()].find(
        (e) =>
          isActiveStatus(e.status) &&
          CATEGORY_KIND[e.category] === CATEGORY_KIND[report.category] &&
          (e.category === report.category || jaccard(reportTokens, textTokens(e.title)) >= 0.5) &&
          haversineMeters(e.coordinates, report.location.coordinates) <= 300 &&
          jaccard(reportTokens, textTokens(`${e.title} ${e.summary}`)) >= 0.2,
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
            published_at_precision: "instant",
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

      // One active answer per question, like the service: repeating it is a
      // no-op and a different answer supersedes the old one.
      const type = signalTypeFor(response);
      let previous: SignalType | undefined;
      if (type) {
        const group = type === "CONFIRM" || type === "DISPUTE" ? "validity" : "current_state";
        const mine = answers.get(eventId) ?? new Map<"validity" | "current_state", SignalType>();
        previous = mine.get(group);
        if (previous === type) return { ok: true, simulated: true, data: { accepted: true, changed: false } };
        mine.set(group, type);
        answers.set(eventId, mine);
      }
      await wait();

      const at = now().toISOString();
      update(eventId, (e) => {
        const next = { ...e, last_updated_at: at, community: { ...e.community, still_happening: { ...e.community.still_happening } } };
        const adjust = (t: SignalType | undefined, delta: 1 | -1) => {
          if (t === "CONFIRM") {
            next.community_confirmation_count = Math.max(0, next.community_confirmation_count + delta);
            next.community.recent_confirmations = Math.max(0, next.community.recent_confirmations + delta);
          } else if (t === "DISPUTE") {
            next.community_dispute_count = Math.max(0, next.community_dispute_count + delta);
            next.community.recent_disputes = Math.max(0, next.community.recent_disputes + delta);
          } else if (t === "STILL_HAPPENING") next.community.still_happening.yes = Math.max(0, next.community.still_happening.yes + delta);
          else if (t === "NO_LONGER_HAPPENING") {
            next.community.still_happening.no = Math.max(0, next.community.still_happening.no + delta);
            next.community.resolved_reports = Math.max(0, next.community.resolved_reports + delta);
          } else if (t === "NOT_SURE") next.community.still_happening.not_sure = Math.max(0, next.community.still_happening.not_sure + delta);
        };
        // Community input adjusts counts only. Status changes belong to the
        // verification engine, which demo mode does not run.
        adjust(previous, -1);
        adjust(type ?? undefined, 1);
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
      return { ok: true, simulated: true, data: { accepted: true, changed: true } };
    },
  };
}
