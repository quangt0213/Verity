import { CATEGORY_KIND, normalizeSingleLine, type EventCategory } from "@verity/contracts";
import type { SearchContext } from "../../verification/geocoding";
import { officialDomainsFor } from "../../verification/official-sources";
import { DEFAULT_POLICY, type VerificationPolicy } from "../../verification/policy";
import type { EventForRetrieval } from "../../worker/ports";
import type { SearchRequest } from "./client";

/**
 * Deterministic search queries for one event. Only event wording, category
 * and place names are used; never coordinates, reporter or account data.
 * User-entered text is sanitized: search operators and quotes are removed and
 * lengths are capped, so a report can't steer the provider's query syntax.
 *
 *   q1  category words + the strongest location term + city/state
 *   q2  the same, restricted to official domains for that place (if any)
 *   q3  the event's own title + city
 */

export interface QuerySpec extends SearchRequest {
  id: "q1" | "q2" | "q3";
}

const CATEGORY_WORDS: Record<EventCategory, string> = {
  road_closure: "road closure",
  crash: "crash",
  flooding: "flooding",
  fire: "fire",
  police_activity: "police activity",
  transit_disruption: "transit delays",
  construction: "construction",
  power_outage: "power outage",
  protest: "protest",
  parade: "parade",
  concert: "concert",
  sporting_event: "game",
  festival: "festival",
  campus_event: "campus event",
  parking_traffic: "traffic",
  other: "",
};

const MAX_PART = 80;
const MAX_QUERY = 200;

/** Remove anything a search engine might read as an operator, and quotes; keep words, numbers, &, # and hyphens. */
export function sanitizeQueryText(value: string | null | undefined): string {
  if (!value) return "";
  return normalizeSingleLine(value)
    .replace(/\b(?:site|inurl|intitle|intext|filetype|cache|related|link|ext):\S*/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[^\p{L}\p{N}&#\s-]/gu, " ")
    .replace(/(^|\s)-+/g, "$1")
    .replace(/\b(?:OR|AND|NOT)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PART)
    .trim();
}

const join = (...parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).join(" ").slice(0, MAX_QUERY).trim();

function timeWindow(event: EventForRetrieval, policy: VerificationPolicy): Pick<SearchRequest, "timeRange" | "startDate"> {
  if (CATEGORY_KIND[event.category] === "planned" && event.scheduledStartAt) {
    const from = new Date(event.scheduledStartAt.getTime() - policy.planned.announcementLeadDays * 24 * 60 * 60_000);
    return { startDate: from.toISOString().slice(0, 10) };
  }
  const stale = policy.categories[event.category].staleMinutes;
  if (stale <= 60) return { timeRange: "hour" };
  if (stale <= 24 * 60) return { timeRange: "day" };
  if (stale <= 7 * 24 * 60) return { timeRange: "week" };
  return { timeRange: "month" };
}

export function buildQueries(
  event: EventForRetrieval,
  context: SearchContext,
  options: { maxSearches: number; maxResults: number; policy?: VerificationPolicy },
): QuerySpec[] {
  if (!context.searchable) return [];
  const policy = options.policy ?? DEFAULT_POLICY;
  const what = CATEGORY_WORDS[event.category];
  const where = sanitizeQueryText(context.locationTerms[0] ?? "");
  const area = join(sanitizeQueryText(context.city), sanitizeQueryText(context.region));
  const base = { searchDepth: "standard" as const, maxResults: options.maxResults, country: context.countryCode ?? "US", ...timeWindow(event, policy) };

  const queries: QuerySpec[] = [];
  const q1 = join(what, where, area);
  if (q1.split(" ").length >= 2) queries.push({ id: "q1", query: q1, ...base });

  const domains = officialDomainsFor({ region: context.region, city: context.city }, event.category);
  if (domains.length > 0 && (where || area)) queries.push({ id: "q2", query: join(what, where || area), ...base, includeDomains: domains });

  const title = sanitizeQueryText(event.title);
  const q3 = join(title, sanitizeQueryText(context.city));
  if (title.split(" ").length >= 3 && q3.toLowerCase() !== q1.toLowerCase()) queries.push({ id: "q3", query: q3, ...base });

  return queries.slice(0, Math.max(0, options.maxSearches));
}
