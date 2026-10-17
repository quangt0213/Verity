import { CATEGORY_KIND, foldDiacritics, type EventCategory, type EvidenceStance } from "@verity/contracts";

/**
 * Conservative, deterministic stance classification of ONE sentence with
 * respect to an event category. Keyword presence alone is never enough: the
 * classifier looks for negation, reversal ("closed … but reopened"),
 * historical framing, hedging, rumors and quotation, and answers "context"
 * whenever it cannot safely tell. A false support or contradiction is worse
 * than no answer: "context" never counts toward a decision. No model is used.
 */

/** Words that describe the event happening (stems; matched on word boundaries). */
const ACTIVE_TERMS: Record<EventCategory, string[]> = {
  road_closure: ["closed", "closure", "closures", "blocked", "shut down", "shut", "lanes closed"],
  crash: ["crash", "collision", "accident", "wreck", "pileup", "overturned"],
  flooding: ["flooding", "flooded", "flood", "underwater", "inundated"],
  fire: ["fire", "blaze", "burning", "wildfire", "flames"],
  police_activity: ["police activity", "standoff", "police investigation", "shelter in place", "lockdown"],
  transit_disruption: ["delays", "delayed", "suspended", "disruption", "service halted", "single tracking", "out of service"],
  construction: ["construction", "roadwork", "road work", "lane closure", "lane closures", "detour"],
  power_outage: ["outage", "outages", "without power", "power out", "blackout", "lost power"],
  protest: ["protest", "protesters", "demonstration", "demonstrators", "rally", "march"],
  parade: ["parade"],
  concert: ["concert", "show", "performance"],
  sporting_event: ["game", "match", "tournament", "race"],
  festival: ["festival", "fair"],
  campus_event: ["event", "ceremony", "commencement"],
  parking_traffic: ["traffic", "congestion", "backed up", "gridlock"],
  other: [],
};

/** Words that say it is over. */
const ENDED_TERMS = [
  "reopened",
  "re-opened",
  "reopens",
  "reopening",
  "cleared",
  "lifted",
  "restored",
  "resumed",
  "back to normal",
  "all lanes open",
  "lanes are open",
  "extinguished",
  "receded",
  "has ended",
  "have ended",
  "ended",
  "called off",
  "cancelled",
  "canceled",
  "dispersed",
];
/** "Contained" ends a fire only when complete; "40% contained" means it's still burning. */
const FULLY_CONTAINED = /\b(?:100\s?%|fully|completely)\s+contained\b/i;
const PARTLY_CONTAINED = /\b\d{1,2}\s?%\s+contained\b/i;

const NEGATORS = /\b(?:not|no|never|isn't|is not|aren't|are not|wasn't|was not|weren't|were not|hasn't|has not|haven't|have not|neither|nor|without any|zero)\b(?:\s+\S+){0,3}\s*$/i;
const NO_LONGER = /\bno longer\b(?:\s+\S+){0,3}\s*$/i;
const DENIAL = /\b(?:false|fake|hoax|debunked|denied|denies|incorrect|untrue|inaccurate|misinformation|no evidence|no reports? of)\b/i;
const HEARSAY = /\b(?:rumou?rs?|unconfirmed|alleged(?:ly)?|claims? that|claimed that|purported(?:ly)?|social media posts?|posts? (?:claim|said|say)|viral)\b/i;
const HYPOTHETICAL = /\b(?:may|might|could|would|if|whether|expected to|plans? to|planned|scheduled to|will be|will close|possible|possibly|potential|threat of|risk of|warning|watch)\b/i;
const HISTORICAL = /\b(?:yesterday|last (?:week|month|year|night|weekend)|earlier this (?:week|month|year)|previously|in the past|years? ago|months? ago|weeks? ago|in (?:19|20)\d{2}|anniversary|history|historic)\b/i;
const PRESENT = /\b(?:now|currently|still|remains?|ongoing|this (?:morning|afternoon|evening)|today|tonight|right now|at this hour|as of)\b/i;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function positions(text: string, terms: string[]): number[] {
  const found: number[] = [];
  for (const term of terms) {
    const re = new RegExp(`\\b${escape(term)}\\b`, "gi");
    for (const m of text.matchAll(re)) found.push(m.index!);
  }
  return found.sort((a, b) => a - b);
}

/** Inside a double- or curly-quoted span: a quoted claim, not the publisher's own statement. */
function inQuotes(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const straight = (before.match(/"/g) ?? []).length % 2 === 1;
  const curly = before.lastIndexOf("“") > before.lastIndexOf("”");
  return straight || curly;
}

/**
 * Event words used as part of an organization or role name ("CAL FIRE",
 * "fire department", "police chief") are not mentions of the event itself.
 */
const NAME_AFTER = /^\s*(?:department|dept\b|station|stations|chief|officials?|crews?|captain|marshal|district|authority|agency|engines?|trucks?|spokesperson|spokesman|spokeswoman|officers?)\b/i;
const NAME_BEFORE = /\b(?:cal|county|city|state|forest|volunteer)\s*$/i;
function eventMentions(text: string, terms: string[]): number[] {
  return positions(text, terms).filter((i) => {
    const term = terms.find((t) => text.slice(i, i + t.length).toLowerCase() === t.toLowerCase()) ?? "";
    return !NAME_AFTER.test(text.slice(i + term.length)) && !NAME_BEFORE.test(text.slice(Math.max(0, i - 12), i));
  });
}

export function activeTerms(category: EventCategory): string[] {
  return ACTIVE_TERMS[category];
}

/**
 * Positions where the event's own name is mentioned ("Día de San José").
 * `names` are case-insensitive patterns over accent-folded text (identity.ts).
 */
function nameMentions(text: string, names: readonly RegExp[]): number[] {
  return names.flatMap((re) => [...text.matchAll(new RegExp(re.source, "gi"))].map((m) => m.index!));
}

/**
 * Classify one sentence. `names` (optional) are patterns for the event's own
 * distinctive name: for a named event, a mention of its name is a mention of
 * the event, exactly like a category word, and the same negation, hearsay,
 * quotation and framing guards apply to it.
 */
export function classifyStance(sentence: string, category: EventCategory, names: readonly RegExp[] = []): EvidenceStance {
  const text = foldDiacritics(sentence.replace(/\s+/g, " ").trim());
  if (!text) return "context";
  const active = [...eventMentions(text, ACTIVE_TERMS[category]), ...nameMentions(text, names)].sort((a, b) => a - b);
  const ended = positions(text, ENDED_TERMS);
  const fullyContained = category === "fire" && FULLY_CONTAINED.test(text);
  if (active.length === 0 && ended.length === 0 && !fullyContained) return "context";

  // Claims the publisher doesn't itself assert, and speculation, are never a stance.
  if (HEARSAY.test(text)) return "context";
  if (active.some((i) => inQuotes(text, i)) || ended.some((i) => inQuotes(text, i))) return "context";
  if (category === "fire" && PARTLY_CONTAINED.test(text) && !FULLY_CONTAINED.test(text)) {
    // Partly contained: still burning, but only say so plainly.
    if (HISTORICAL.test(text) || HYPOTHETICAL.test(text)) return "context";
  }

  // Negation right before an event word: "not closed", "no flooding", "no longer closed".
  for (const i of active) {
    const lead = text.slice(Math.max(0, i - 40), i);
    if (NO_LONGER.test(lead)) return "ended";
    if (NEGATORS.test(lead)) return "contradicts";
  }
  if (DENIAL.test(text) && active.length > 0) return "contradicts";

  // A fire that is fully contained is over, whatever else the sentence mentions.
  if (fullyContained) return HISTORICAL.test(text) && !PRESENT.test(text) ? "context" : "ended";

  // Reversal or completion: "closed yesterday but reopened this morning".
  if (ended.length > 0) {
    for (const i of ended) {
      const lead = text.slice(Math.max(0, i - 40), i);
      if (NEGATORS.test(lead)) return "context"; // "has not reopened": unclear, leave it
    }
    const lastActive = active.at(-1) ?? -1;
    const lastEnded = ended.at(-1)!;
    if (lastEnded > lastActive) return HYPOTHETICAL.test(text) && !PRESENT.test(text) ? "context" : "ended";
    return "context"; // "reopened, then closed again" and other tangles
  }

  // Past or hypothetical framing is not current support.
  if (HISTORICAL.test(text) && !PRESENT.test(text)) return "context";
  if (CATEGORY_KIND[category] === "disruption" && HYPOTHETICAL.test(text)) return "context";

  return "supports";
}

/**
 * Announcement framing: the sentence says the event WILL happen ("will be
 * held", "is scheduled for", "tickets on sale", "join us next Saturday"),
 * and says nothing about it happening now. An announcement establishes that
 * an event is planned, never that it is occurring (rules.ts).
 */
const ANNOUNCEMENT =
  /\b(?:will (?:be held|be hosted|take place|return|kick off|feature|celebrate|be|run|begin|start|open|bring|showcase|include)|(?:is|are|was|were) (?:scheduled|set|planned|slated|expected)|scheduled (?:for|to)|set (?:for|to) (?:take place|return|begin|start)|slated (?:for|to)|planned for|plans? to|upcoming|coming (?:up|soon)|join us|save the date|mark your calendars?|tickets? (?:are |go )?(?:on sale|available)|register now|rsvp|this coming|next (?:week|weekend|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;
const UNDERWAY = /\b(?:now|currently|underway|under way|ongoing|is happening|are happening|kicked off|got under ?way|is in full swing|right now|at this hour|so far today|draws|drew|packed|crowds? (?:filled|gathered|packed))\b/i;

export function announcementFraming(sentence: string | null | undefined): boolean {
  if (!sentence) return false;
  const text = foldDiacritics(sentence);
  return ANNOUNCEMENT.test(text) && !UNDERWAY.test(text);
}
