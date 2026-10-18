import { CATEGORY_KIND, foldDiacritics, type EventCategory } from "@verity/contracts";
import { dayLabel } from "./dates";
import type { IdentityVerdict, NormalizedEvidence } from "./evidence";
import type { SearchContext } from "./geocoding";
import { activeTerms } from "./stance";
import { placeConflict } from "./text-evidence";

/**
 * Event identity: is this source about THIS event, or only about something
 * that shares its category words? Deterministic and pure; no model.
 *
 * Sharing the word "festival" with a report is not evidence about it. For a
 * NAMED planned event ("Día San José 2026") a source may take a stance only
 * when it names the event; any source is excluded when it is explicitly about
 * another place ("San José, Costa Rica"), another date, or another edition
 * ("Día San José 2025"). Excluded sources stay as context: they are kept and
 * shown, but never count toward a decision. This only ever makes
 * qualification stricter; the decision rules themselves are unchanged.
 *
 * Verdicts:
 *   match      names the event, and nothing contradicts place, date or edition
 *   uncertain  a named event the source doesn't name (shared category words only)
 *   mismatch   explicitly another place, date or edition
 *   unchecked  the event has no distinctive name, and nothing contradicts it
 */

export interface ScheduleWindow {
  start: Date;
  end: Date | null;
}

export interface IdentityInput {
  category: EventCategory;
  title: string;
  /** The event's established schedule (never set from a reporter's claim). */
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;
  /** Reporters' claimed schedules (reports.scheduled_*): hints for matching, never an established schedule. */
  reportedSchedules?: readonly ScheduleWindow[];
}

export interface EventName {
  /** Distinctive words of the title, accent-folded and lowercase, in title order. */
  tokens: string[];
  /** Matches the name in accent-folded text, with up to two short words between its words ("Día de San José"). Case-insensitive, not global. */
  pattern: RegExp;
  /** The name as words, for queries ("Dia San Jose"). */
  phrase: string;
}

export interface EventIdentity {
  category: EventCategory;
  planned: boolean;
  /** Null when the title names no specific event ("Festival at the plaza", "Road blocked"). */
  name: EventName | null;
  /** The edition year, from the title or the schedule. */
  year: number | null;
  /** When the event may take place: the established schedule if any, else reporters' claims. */
  windows: ScheduleWindow[];
  windowSource: "established" | "reported" | null;
  context: SearchContext;
}

const STOPWORDS = new Set(["the", "and", "for", "with", "from", "near", "del", "las", "los", "les", "des", "das", "dos", "und", "von"]);

/** Words that describe a kind of event or the scene, not which event it is. */
const GENERIC = new Set([
  "event", "events", "celebration", "celebrations", "celebrate", "celebrating", "annual", "yearly", "fest", "festival", "festivals",
  "fiesta", "fiestas", "feria", "fair", "fairs", "show", "shows", "concert", "concerts", "parade", "parades", "march", "rally",
  "protest", "game", "games", "match", "race", "tournament", "ceremony", "commencement", "graduation", "market", "markets",
  "party", "gathering", "music", "live", "free", "big", "huge", "large", "small", "local", "community", "public", "happening",
  "going", "today", "tonight", "now", "right", "currently", "ongoing", "weekend", "this", "morning", "afternoon", "evening", "night",
  "lots", "many", "people", "crowd", "crowds", "crowded", "busy", "packed", "outside", "downtown", "street", "streets", "plaza",
  "park", "square", "area", "here", "there", "around", "new", "first", "lot", "closed", "closure", "blocked", "traffic", "road",
  "ave", "avenue", "blvd", "boulevard", "campus", "outdoor", "family", "kids", "happy", "see", "come", "join",
]);

const words = (text: string) => foldDiacritics(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MAX_NAME_TOKENS = 5;

/** The event's distinctive name, or null when its title is generic or only names the place. */
export function eventName(title: string, category: EventCategory, context: Pick<SearchContext, "locationTerms" | "city" | "region" | "neighborhood" | "street">): EventName | null {
  const categoryWords = new Set(activeTerms(category).flatMap(words));
  const locationWords = new Set([...context.locationTerms, context.city, context.region, context.neighborhood, context.street].filter((t): t is string => Boolean(t)).flatMap(words));
  const tokens = words(title).filter((w, i, all) => w.length >= 3 && !/^\d+$/.test(w) && !STOPWORDS.has(w) && !GENERIC.has(w) && !categoryWords.has(w) && all.indexOf(w) === i);
  // A long string of words is a description of the scene, not a name.
  if (tokens.length === 0 || tokens.length > MAX_NAME_TOKENS) return null;
  // Only place words ("Plaza de César Chávez festival"): the place, not an event name.
  if (tokens.every((t) => locationWords.has(t))) return null;
  const gap = "(?:[^a-z0-9]+[a-z0-9]+){0,2}?[^a-z0-9]+";
  return { tokens, pattern: new RegExp(`(?<![a-z0-9])${tokens.map(escapeRe).join(gap)}(?![a-z0-9])`, "i"), phrase: tokens.join(" ") };
}

export function buildEventIdentity(event: IdentityInput, context: SearchContext): EventIdentity {
  const planned = CATEGORY_KIND[event.category] === "planned";
  const established = event.scheduledStartAt ? [{ start: event.scheduledStartAt, end: event.scheduledEndAt }] : [];
  const reported = (event.reportedSchedules ?? []).slice(0, 5);
  const windows = planned ? (established.length > 0 ? established : reported) : [];
  const titleYear = /(?<!\d)(20\d\d)(?!\d)/.exec(event.title);
  return {
    category: event.category,
    planned,
    name: planned ? eventName(event.title, event.category, context) : null,
    year: titleYear ? Number(titleYear[1]) : windows[0] ? windows[0].start.getUTCFullYear() : null,
    windows,
    windowSource: windows.length === 0 ? null : established.length > 0 ? "established" : "reported",
    context,
  };
}

// ---------------------------------------------------------------------------
// Dates written in the text (future dates included: announcements state them)
// ---------------------------------------------------------------------------

const EN_MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const ES_MONTH = "(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)";
const EN_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ES_MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
// "March 19, 2026", "March 19-21, 2026", "19 March 2026", "19 de marzo de 2026", "2026-03-19". Numeric "3/19/2026" is ambiguous and never read.
const MONTH_FIRST = new RegExp(`\\b${EN_MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*(?:-|–|to|through)\\s*(\\d{1,2})(?:st|nd|rd|th)?)?,?\\s+(20\\d\\d)\\b`, "gi");
const DAY_FIRST = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${EN_MONTH}\\.?,?\\s+(20\\d\\d)\\b`, "gi");
const SPANISH = new RegExp(`\\b(\\d{1,2})\\s+de\\s+${ES_MONTH}(?:\\s+(?:de|del)|,)?\\s+(20\\d\\d)\\b`, "gi");
const ISO = /\b(20\d\d)-(\d\d)-(\d\d)\b/g;
const MAX_DATES = 30;

/** Every explicit calendar date (with a year) written in the text, as day labels. */
export function statedDates(text: string): Date[] {
  const bounded = foldDiacritics(text).slice(0, 50_000);
  const out: Date[] = [];
  const add = (y: number, m: number, d: number) => {
    const label = m > 0 ? dayLabel(y, m, d) : null;
    if (label && out.length < MAX_DATES && !out.some((o) => o.getTime() === label.getTime())) out.push(label);
  };
  const en = (name: string) => EN_MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
  for (const m of bounded.matchAll(MONTH_FIRST)) {
    add(Number(m[4]), en(m[1]!), Number(m[2]));
    if (m[3]) add(Number(m[4]), en(m[1]!), Number(m[3]));
  }
  for (const m of bounded.matchAll(DAY_FIRST)) add(Number(m[3]), en(m[2]!), Number(m[1]));
  for (const m of bounded.matchAll(SPANISH)) add(Number(m[3]), ES_MONTHS.indexOf(m[2]!.toLowerCase()) + 1, Number(m[1]));
  for (const m of bounded.matchAll(ISO)) add(Number(m[1]), Number(m[2]), Number(m[3]));
  return out;
}

const HOUR = 60 * 60_000;
/** A stated calendar day may be off by a day from the schedule (time zones, multi-day events, day-before coverage). */
const DATE_TOLERANCE_MS = 24 * HOUR;

/** The calendar day (in any time zone) overlaps the window, within the tolerance. */
export function dayInWindow(day: Date, window: ScheduleWindow): boolean {
  const earliest = day.getTime() - 14 * HOUR;
  const latest = day.getTime() + 36 * HOUR;
  const start = window.start.getTime();
  const end = (window.end ?? window.start).getTime();
  return latest >= start - DATE_TOLERANCE_MS && earliest <= end + DATE_TOLERANCE_MS;
}

// ---------------------------------------------------------------------------

export interface IdentityCheck {
  verdict: IdentityVerdict;
  name: "present" | "absent" | "not_named";
  /** The source explicitly places the event's city somewhere else. */
  placeConflict: boolean;
  /** Explicit dates are stated and none fits the schedule. */
  dateConflict: boolean;
  /** The name is written with another year ("Día San José 2025"). */
  editionConflict: boolean;
}

export function checkIdentity(
  source: { title: string | null; excerpt: string | null; text: string; locationMatch: NormalizedEvidence["locationMatch"] },
  identity: EventIdentity,
): IdentityCheck {
  // The name must be in what the record shows (title or quoted sentence); conflicts are looked for in everything returned.
  const shown = foldDiacritics([source.title, source.excerpt].filter(Boolean).join(". "));
  const whole = [source.title ?? "", source.text].join("\n").slice(0, 50_000);
  const name = identity.name ? (identity.name.pattern.test(shown) ? "present" : "absent") : "not_named";

  const conflictsPlace = source.locationMatch !== "exact" && (source.locationMatch === "mismatch" || placeConflict(whole, identity.context));

  let dateConflict = false;
  if (identity.planned && identity.windows.length > 0) {
    const dates = statedDates(whole);
    dateConflict = dates.length > 0 && !dates.some((d) => identity.windows.some((w) => dayInWindow(d, w)));
  }

  let editionConflict = false;
  if (identity.name && identity.year !== null) {
    const edition = new RegExp(`${identity.name.pattern.source}[^a-z0-9]{1,3}(20\\d\\d)(?!\\d)`, "gi");
    const years = [...foldDiacritics(whole).matchAll(edition)].map((m) => Number(m[1]));
    editionConflict = years.length > 0 && !years.includes(identity.year);
  }

  const verdict: IdentityVerdict =
    conflictsPlace || dateConflict || editionConflict ? "mismatch" : name === "present" ? "match" : name === "absent" ? "uncertain" : "unchecked";
  return { verdict, name, placeConflict: conflictsPlace, dateConflict, editionConflict };
}

/**
 * Apply an identity check to a record: anything that isn't about this event
 * becomes context (it never counts toward a decision, whatever its words
 * say), and an explicitly different place is recorded as a location mismatch.
 */
export function applyIdentity(e: NormalizedEvidence, check: IdentityCheck): NormalizedEvidence {
  const keeps = check.verdict === "match" || check.verdict === "unchecked";
  return {
    ...e,
    stance: keeps ? e.stance : "context",
    locationMatch: check.placeConflict && e.locationMatch !== "exact" ? "mismatch" : e.locationMatch,
    identity: check.verdict,
  };
}

/** Name patterns for excerpt selection and stance (empty for an unnamed event). */
export const namePatterns = (identity: EventIdentity | null | undefined): RegExp[] => (identity?.name ? [identity.name.pattern] : []);
