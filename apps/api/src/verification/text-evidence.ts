import { foldDiacritics, type EventCategory } from "@verity/contracts";
import type { NormalizedEvidence } from "./evidence";
import type { SearchContext } from "./geocoding";
import { isCountry, isUnitedStates, usState } from "./place-names";
import { activeTerms } from "./stance";

/**
 * Provider-neutral helpers for turning returned page text into evidence
 * fields: a VERBATIM excerpt (never rewritten) and a conservative location
 * match. Used by every retriever's normalizer.
 */

const MAX_EXCERPT = 1000;
const ENDED_HINTS = ["reopened", "cleared", "restored", "contained", "lifted", "resumed", "ended"];

/** Street-name normalization so "Mission St" matches "Mission Street". */
const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bstreet\b/g, "st"],
  [/\bavenue\b/g, "ave"],
  [/\bboulevard\b/g, "blvd"],
  [/\broad\b/g, "rd"],
  [/\bdrive\b/g, "dr"],
  [/\bhighway\b/g, "hwy"],
  [/\binterstate\b/g, "i"],
  [/\bfreeway\b/g, "fwy"],
  [/\bexpressway\b/g, "expy"],
  [/\bparkway\b/g, "pkwy"],
  [/\blane\b/g, "ln"],
  [/\bplace\b/g, "pl"],
  [/\bcourt\b/g, "ct"],
  [/\bnorth\b/g, "n"],
  [/\bsouth\b/g, "s"],
  [/\beast\b/g, "e"],
  [/\bwest\b/g, "w"],
  [/\band\b/g, "&"],
];

/** Lowercase, accent-folded ("César Chávez" = "Cesar Chavez"), punctuation-free, with street words abbreviated. */
export function normalizePlaceText(text: string): string {
  let t = ` ${foldDiacritics(text).toLowerCase().replace(/[^a-z0-9&\s-]/g, " ")} `;
  for (const [re, short] of ABBREVIATIONS) t = t.replace(re, short);
  return t.replace(/\s+/g, " ");
}

/** The distinctive parts of a location term ("Mission St & 22nd St" → ["mission st", "22nd st"]). */
export function placeParts(term: string): string[] {
  return normalizePlaceText(term)
    .split(/&|\bat\b|\bnear\b|,|\//)
    .map((p) => p.trim())
    .filter((p) => p.length >= 3 && /[a-z]/.test(p));
}

/**
 * Other ways a venue is commonly written: "Plaza de César Chávez" is also
 * "César Chávez Plaza". The venue-type word is always kept, so the bare name
 * ("César Chávez", which also names streets and holidays) never matches.
 */
const VENUE_TYPES = "plaza|park|parque|square";
export function venueAliases(part: string): string[] {
  const out = [part];
  const leading = new RegExp(`^(${VENUE_TYPES}) (?:de la |del |de )?(.+)$`).exec(part);
  if (leading) out.push(`${leading[2]} ${leading[1]}`, `${leading[1]} ${leading[2]}`);
  const trailing = new RegExp(`^(.+) (${VENUE_TYPES})$`).exec(part);
  if (trailing) out.push(`${trailing[2]} ${trailing[1]}`, `${trailing[2]} de ${trailing[1]}`);
  return [...new Set(out)];
}

const STREET_OR_VENUE = /\d|&| (?:st|ave|blvd|rd|dr|hwy|fwy|i|ln|pl|ct|way|pkwy|expy|plaza|park|parque|square|center|centre|station|bridge|hall|stadium|arena|at) /;

const sameName = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b) && normalizePlaceText(a!).trim() === normalizePlaceText(b!).trim();

/** A segment that only names a city, state or country of this context: never a precise location. */
function isAreaName(segment: string, context: Pick<SearchContext, "city" | "region">): boolean {
  const s = normalizePlaceText(segment).trim();
  return sameName(s, context.city) || sameName(s, context.region) || usState(s) !== null || isCountry(s) || isUnitedStates(s);
}

export interface LabelParts {
  /** Street, intersection or venue: can establish an exact location. */
  precise: string[];
  /** Secondary qualifiers (a district, "near City Hall"): at most a nearby location. */
  nearby: string[];
}

/**
 * Split a compound label such as "Plaza de César Chávez, San Jose, CA":
 * the first comma segment is the precise place; later segments are
 * qualifiers. City, state and country names are never location evidence on
 * their own (a city-only match never establishes an exact location); a
 * segment right before a state or country segment is read as the city.
 */
export function splitLocationLabel(term: string, context: Pick<SearchContext, "city" | "region">): LabelParts {
  const segments = term.split(",").map((s) => s.trim()).filter(Boolean);
  const beforeState = (i: number) => i + 1 < segments.length && isAreaName(segments[i + 1]!, { city: null, region: null });
  // The first segment is read as a city by position only when it doesn't look like a street or venue ("Mission St, CA").
  const area = segments.map((s, i) => isAreaName(s, context) || (beforeState(i) && (i > 0 || !STREET_OR_VENUE.test(normalizePlaceText(s)))));
  const precise: string[] = [];
  const nearby: string[] = [];
  segments.forEach((segment, i) => {
    if (area[i]) return;
    const parts = placeParts(segment).filter((p) => !isAreaName(p, context)).flatMap(venueAliases);
    (i === 0 ? precise : nearby).push(...parts);
  });
  return { precise: [...new Set(precise)], nearby: [...new Set(nearby)] };
}

/**
 * The text names this context's city but qualifies it as somewhere else:
 * "San José, Costa Rica" or "San Jose, Ill." for an event in San Jose,
 * California. Only an explicit "City, Qualifier" (or "City (Qualifier)")
 * counts, and only when no mention of the city carries our own state.
 */
export function placeConflict(text: string, context: Pick<SearchContext, "city" | "region" | "countryCode" | "locationTerms">): boolean {
  const fromLabel = labelArea(context.locationTerms, context);
  const city = context.city ?? fromLabel.city;
  if (!city) return false;
  const region = context.region ?? fromLabel.state;
  const ourState = region ? usState(normalizePlaceText(region).trim()) : null;
  const ourCountry = context.countryCode ?? (ourState ? "US" : null);
  if (!ourCountry) return false;
  const folded = foldDiacritics(text).slice(0, 50_000);
  const cityWords = foldDiacritics(city).toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim().split(/\s+/);
  const mention = new RegExp(`\\b${cityWords.map(escapeRe).join("[\\s.-]+")}\\b\\s*[,(]\\s*([A-Za-z][A-Za-z.'’]*(?:\\s+[A-Za-z][A-Za-z.'’]*){0,2})`, "gi");
  let conflict = false;
  let ours = false;
  for (const m of folded.matchAll(mention)) {
    // The qualifier must be capitalized as written ("CA", "Costa Rica"), so a lowercase "in", "la" or "or" is not a state.
    const raw = m[1]!.replace(/['’]s\b/g, "").replace(/\./g, "").split(/\s+/);
    if (!/^[A-Z]/.test(raw[0]!)) continue;
    const words = raw.map((w) => w.toLowerCase());
    for (let n = Math.min(3, words.length); n >= 1; n--) {
      const candidate = words.slice(0, n).join(" ");
      const state = usState(candidate);
      // A two-letter state code only as an uppercase code ("CA"), never an ordinary word ("In", "Me").
      if (state && (n > 1 || candidate.length > 2 || raw[0] === raw[0]!.toUpperCase())) {
        if (ourCountry === "US" && ourState && state.name !== ourState.name) conflict = true;
        else ours = true;
        break;
      }
      if (isUnitedStates(candidate)) {
        if (ourCountry === "US") ours = true;
        else conflict = true;
        break;
      }
      if (isCountry(candidate)) {
        if (ourCountry === "US") conflict = true;
        break;
      }
    }
  }
  return conflict && !ours;
}

/** The city and state named in a "Venue, City, ST" label, for when the geocoder gave none. */
export function labelArea(terms: readonly string[], context: Pick<SearchContext, "region">): { city: string | null; state: string | null } {
  for (const term of terms) {
    const segments = term.split(",").map((s) => s.trim()).filter(Boolean);
    for (let i = 1; i + 1 < segments.length; i++) {
      const next = normalizePlaceText(segments[i + 1]!).trim();
      if (isAreaName(next, { city: null, region: context.region })) return { city: segments[i]!, state: usState(next)?.name ?? null };
    }
  }
  return { city: null, state: null };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * exact: the text names the reporter's street/intersection/venue (or the
 * derived street); near: it names the neighborhood or a secondary part of a
 * reporter's label; mismatch: it explicitly places this city somewhere else
 * ("San José, Costa Rica"); unclear: city only or nothing. Absence of a name
 * is never a mismatch: only an explicit conflicting qualifier is.
 */
export function matchLocation(text: string, context: SearchContext): NormalizedEvidence["locationMatch"] {
  const hay = normalizePlaceText(text);
  const hit = (parts: string[]) => parts.some((part) => hay.includes(` ${part} `));
  const labels = context.locationTerms.filter((_, i) => context.termSources[i] === "reporter").map((term) => splitLocationLabel(term, context));
  const street = context.street ? placeParts(context.street).filter((p) => !isAreaName(p, context)) : [];
  if (hit([...labels.flatMap((l) => l.precise), ...street])) return "exact";
  const neighborhood = context.neighborhood ? placeParts(context.neighborhood).filter((p) => !isAreaName(p, context)) : [];
  if (hit([...labels.flatMap((l) => l.nearby), ...neighborhood])) return "near";
  if (placeConflict(text, context)) return "mismatch";
  return "unclear";
}

/** Split plain text into sentences, keeping each sentence's exact characters. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?\n]+(?:[.!?]+["”’)]*|\n|$)/g;
  for (const m of text.matchAll(re)) {
    const s = m[0].trim();
    if (s.length >= 20) out.push(s);
  }
  return out;
}

/**
 * Choose ONE sentence, copied verbatim, that mentions the event (an event or
 * "ended" word, or the event's own name) and preferably the event's name and
 * location. Null when nothing safe exists: a missing quote is fine, a
 * rewritten one is not.
 */
export function selectExcerpt(
  text: string | null | undefined,
  category: EventCategory,
  context: SearchContext,
  names: readonly RegExp[] = [],
): string | null {
  if (!text) return null;
  const words = [...activeTerms(category), ...ENDED_HINTS];
  // Name patterns run on accent-folded text, as in identity.ts and stance.ts (no street abbreviations).
  const named = (s: string) => names.some((re) => re.test(foldDiacritics(s)));
  const mentionsEvent = (s: string) => named(s) || words.some((w) => new RegExp(`\\b${escapeRe(w)}\\b`, "i").test(s));
  const candidates = sentences(text).filter(mentionsEvent);
  if (candidates.length === 0) return null;
  const located = (s: string) => {
    const m = matchLocation(s, context);
    return m === "exact" || m === "near";
  };
  const chosen = (candidates.find((s) => named(s) && located(s)) ?? candidates.find(named) ?? candidates.find(located) ?? candidates[0]!).slice(0, MAX_EXCERPT);
  // Defensive: the excerpt must be an exact substring of what the source returned.
  return text.includes(chosen) ? chosen : null;
}
