import type { EventCategory } from "@verity/contracts";
import type { NormalizedEvidence } from "./evidence";
import type { SearchContext } from "./geocoding";
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

export function normalizePlaceText(text: string): string {
  let t = ` ${text.toLowerCase().replace(/[^a-z0-9&\s-]/g, " ")} `;
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
 * exact: the text names the reporter's street/landmark (or the derived street);
 * near: it names the neighborhood; unclear: city only or nothing. Never
 * "mismatch" from text alone: absence of a name isn't evidence of a different place.
 */
export function matchLocation(text: string, context: SearchContext): NormalizedEvidence["locationMatch"] {
  const hay = normalizePlaceText(text);
  const names = (term: string | null) => (term ? placeParts(term).some((part) => hay.includes(` ${part} `)) : false);
  const precise = [...context.locationTerms.filter((_, i) => context.termSources[i] === "reporter"), context.street];
  if (precise.some((term) => names(term))) return "exact";
  if (names(context.neighborhood)) return "near";
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
 * "ended" word) and preferably the location. Null when nothing safe exists:
 * a missing quote is fine, a rewritten one is not.
 */
export function selectExcerpt(text: string | null | undefined, category: EventCategory, context: SearchContext): string | null {
  if (!text) return null;
  const words = [...activeTerms(category), ...ENDED_HINTS];
  const mentionsEvent = (s: string) => words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(s));
  const candidates = sentences(text).filter(mentionsEvent);
  if (candidates.length === 0) return null;
  const located = candidates.find((s) => matchLocation(s, context) !== "unclear");
  const chosen = (located ?? candidates[0]!).slice(0, MAX_EXCERPT);
  // Defensive: the excerpt must be an exact substring of what the source returned.
  return text.includes(chosen) ? chosen : null;
}
