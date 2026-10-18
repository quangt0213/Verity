import { CATEGORY_KIND, foldDiacritics, normalizeSingleLine, type EventCategory } from "@verity/contracts";
import type { SearchContext } from "../../verification/geocoding";
import { buildEventIdentity, type EventIdentity } from "../../verification/identity";
import { officialDomainsFor } from "../../verification/official-sources";
import { DEFAULT_POLICY, type VerificationPolicy } from "../../verification/policy";
import { labelArea } from "../../verification/text-evidence";
import type { EventForRetrieval } from "../../worker/ports";
import type { SearchRequest } from "./client";

/**
 * Deterministic search queries for one event. Only event wording, category,
 * place names and the (established or claimed) schedule month are used;
 * never coordinates, reporter or account data. User-entered text is
 * sanitized: search operators and quotes are removed and lengths are capped,
 * so a report can't steer the provider's query syntax. The only quotes in a
 * query are the ones Verity adds around an already-sanitized event name.
 *
 * Disruptions, and planned events whose title names no specific event
 * ("Festival at the plaza"), search by category:
 *   q1  news focus: category words + the strongest location term + city/state
 *       (the only mode that returns publication dates, per the S4.1 probes)
 *   q2  general search for the same words, restricted to the official domains
 *       for that place (official pages are not "news"), if any
 *   q3  fallback: the event's own title + city, general search
 *
 * NAMED planned events ("Día San José 2026", see identity.ts) search for the
 * event itself, because category words alone find every festival anywhere:
 *   q1  general: "event name" + venue + city + month/year when known
 *   q2  the official domains for the place and category if any, else news
 *       focus: "event name" + city/state + month/year (dated coverage)
 *   q3  fallback: the category query (category words + venue + city/state)
 *
 * The retriever issues q3 only when q1/q2 found too little. All use lite
 * depth: standard costs 4.5x as much and returns no page content without
 * full_content; page text comes from Extract on selected URLs instead.
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
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Remove anything a search engine might read as an operator, and quotes; keep words, numbers, &, # and hyphens. */
export function sanitizeQueryText(value: string | null | undefined): string {
  if (!value) return "";
  return normalizeSingleLine(value)
    // Contact details a reporter may have typed never leave Verity: emails and phone-like digit runs.
    .replace(/[^\s@]+@[^\s@]+/g, " ")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, " ")
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
const contains = (haystack: string, needle: string) => needle !== "" && foldDiacritics(haystack).toLowerCase().includes(foldDiacritics(needle).toLowerCase());
const titleCase = (s: string | null) => (s ? s.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : null);

/** The schedule to search around: the established one, else the oldest reporter claim. */
function scheduleStart(event: EventForRetrieval): Date | null {
  if (CATEGORY_KIND[event.category] !== "planned") return null;
  return event.scheduledStartAt ?? event.reportedSchedules?.[0]?.start ?? null;
}

function timeWindow(event: EventForRetrieval, policy: VerificationPolicy): Pick<SearchRequest, "timeRange" | "startDate"> {
  const start = scheduleStart(event);
  if (start) {
    const from = new Date(start.getTime() - policy.planned.announcementLeadDays * 24 * 60 * 60_000);
    return { startDate: from.toISOString().slice(0, 10) };
  }
  const stale = policy.categories[event.category].staleMinutes;
  if (stale <= 60) return { timeRange: "hour" };
  if (stale <= 24 * 60) return { timeRange: "day" };
  if (stale <= 7 * 24 * 60) return { timeRange: "week" };
  return { timeRange: "month" };
}

/**
 * The event's name as the reporter wrote it (accents kept), for a quoted
 * phrase: the sanitized title from its first to its last distinctive word,
 * without years. Quoted only when it has several words.
 */
function quotedName(title: string, name: NonNullable<EventIdentity["name"]>): string {
  const words = sanitizeQueryText(title).replace(/(?<!\d)20\d\d(?!\d)/g, " ").replace(/\s+/g, " ").trim().split(" ");
  const distinctive = (w: string) => name.tokens.includes(foldDiacritics(w).toLowerCase());
  const first = words.findIndex(distinctive);
  const last = words.length - 1 - [...words].reverse().findIndex(distinctive);
  const phrase = first < 0 ? name.phrase : words.slice(first, last + 1).join(" ");
  return phrase.includes(" ") ? `"${phrase}"` : phrase;
}

export function buildQueries(
  event: EventForRetrieval,
  context: SearchContext,
  options: { maxSearches: number; maxResults: number; policy?: VerificationPolicy },
): QuerySpec[] {
  if (!context.searchable) return [];
  const policy = options.policy ?? DEFAULT_POLICY;
  const what = CATEGORY_WORDS[event.category];
  // A compound label ("Plaza de César Chávez, San Jose, CA") contributes its first part; city and state are added once.
  const label = context.locationTerms[0] ?? "";
  const fromLabel = labelArea(context.locationTerms, context);
  const where = sanitizeQueryText(fromLabel.city && label.includes(",") ? label.split(",")[0] : label);
  const cityName = context.city ?? fromLabel.city;
  const regionName = context.region ?? titleCase(fromLabel.state);
  const city = sanitizeQueryText(cityName);
  const region = sanitizeQueryText(regionName);
  const area = join(contains(where, city) ? "" : city, region);
  const base = { searchDepth: "lite" as const, maxResults: options.maxResults, country: context.countryCode ?? "US", ...timeWindow(event, policy) };
  const domains = officialDomainsFor({ region: regionName, city: cityName }, event.category);
  const categoryQuery = join(what, where, area);
  const queries: QuerySpec[] = [];

  const identity = buildEventIdentity(event, context);
  if (identity.name) {
    const name = quotedName(event.title, identity.name);
    const start = scheduleStart(event);
    const when = start ? `${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()}` : identity.year !== null ? String(identity.year) : "";
    const inCity = contains(name, city) ? "" : city;
    queries.push({ id: "q1", query: join(name, contains(name, where) ? "" : where, contains(where, city) ? "" : inCity, when), ...base });
    if (domains.length > 0) queries.push({ id: "q2", query: join(name, inCity), ...base, includeDomains: domains });
    else queries.push({ id: "q2", query: join(name, inCity, region, when), ...base, focus: "news" });
    // The category query becomes a bounded fallback: it finds every festival in town, not this one.
    if (categoryQuery.split(" ").length >= 2) queries.push({ id: "q3", query: categoryQuery, ...base, focus: "news" });
    return queries.slice(0, Math.max(0, options.maxSearches));
  }

  if (categoryQuery.split(" ").length >= 2) queries.push({ id: "q1", query: categoryQuery, ...base, focus: "news" });
  if (domains.length > 0 && (where || area)) queries.push({ id: "q2", query: join(what, where || area), ...base, includeDomains: domains });

  const title = sanitizeQueryText(event.title);
  const q3 = join(title, contains(title, city) ? "" : city);
  if (title.split(" ").length >= 3 && q3.toLowerCase() !== categoryQuery.toLowerCase()) queries.push({ id: "q3", query: q3, ...base });

  return queries.slice(0, Math.max(0, options.maxSearches));
}
