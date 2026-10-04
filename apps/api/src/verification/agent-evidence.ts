import type { EventCategory } from "@verity/contracts";
import { detectAttributions } from "./attribution";
import { dayLabel, parseDateValue, timesConsistent, type DayZoneSlack, type EvidenceTime } from "./dates";
import type { NormalizedEvidence } from "./evidence";
import type { SearchContext } from "./geocoding";
import { classifyOfficial, OFFICIAL_SOURCES, type OfficialSource } from "./official-sources";
import { DEFAULT_POLICY, type VerificationPolicy } from "./policy";
import { activeTerms, classifyStance } from "./stance";
import { matchLocation, selectExcerpt, sentences } from "./text-evidence";
import { canonicalizeUrl, publisherDomain } from "./url";

/**
 * Agent citations → NormalizedEvidence. The Agent investigates; Verity
 * decides. Nothing the model asserts becomes evidence by itself:
 *
 *  - Evidence comes ONLY from citations (a URL the provider read plus verbatim
 *    excerpts). No citation, no evidence record.
 *  - The URL must canonicalize (public http(s)); source class and "primary"
 *    come only from the reviewed registry. The provider's "official"/"primary"
 *    labels are ignored: the Agent can't promote an unknown site.
 *  - The quote is a verbatim excerpt sentence; stance and location are
 *    classified on it by the same conservative rules as Search.
 *  - DATE POLICY: a model-proposed publication or event time is never a time
 *    in itself. It becomes publishedAt / eventTimeAsReported only when a cited
 *    excerpt EXPLICITLY contains that date (and the time and zone, for an
 *    instant); the value and precision are the excerpt's, not the model's.
 *    A clock time without a date in the excerpt ("at 3:42 p.m.") establishes
 *    no absolute time. Otherwise the field stays null, and the proposal is
 *    reported as unsupported so the worker may read the page (Extract)
 *    within budget.
 *  - A citation WITHOUT verbatim text establishes nothing and creates no
 *    record. Its URL is reported, so the worker may read that page (Extract)
 *    within budget; evidence then comes from the page itself, never from the
 *    model.
 */

export interface AgentCitationInput {
  url: string;
  title: string | null;
  excerpts: string[];
}

export interface AgentProposalInput {
  url: string;
  publishedAt: string | null;
  eventTime: string | null;
}

export interface UnsupportedProposal {
  /** Canonical URL of the cited source. */
  url: string;
  field: "published" | "event_time";
  /** The model's raw value, kept only so a later page read can look for it. */
  proposed: string;
}

export interface AgentEvidenceResult {
  evidence: NormalizedEvidence[];
  unsupported: UnsupportedProposal[];
  /** Cited pages with no verbatim text: no evidence unless the page itself is read. */
  excerptless: Array<{ url: string; title: string | null }>;
  stats: { citations: number; accepted: number; rejectedUrls: number; withoutExcerpt: number; proposedTimes: number; acceptedTimes: number };
}

const MAX_SOURCES = 20;
const MAX_EXCERPTS = 5;
const MAX_EXCERPT_CHARS = 2000;
const MAX_DATE_MATCHES = 20;

// ---------------------------------------------------------------------------
// Explicit dates in prose (excerpts and page sentences): conservative formats
// only. Numeric "10/03/2026" is ambiguous (US vs elsewhere) and never read.
// ---------------------------------------------------------------------------

const MONTH = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const MONTH_FIRST = new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d\\d)\\b`, "gi");
const DAY_FIRST = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\.?,?\\s+(20\\d\\d)\\b`, "gi");
const ISO_IN_TEXT = /\b(20\d\d-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:?\d\d))?)\b/g;
const CLOCK = /\b(\d{1,2}):(\d{2})\s*([ap])\.?\s?m\.?\s*(PDT|PST|EDT|EST|CDT|CST|MDT|MST|UTC|GMT)\b/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ZONE_HOURS: Record<string, number> = { UTC: 0, GMT: 0, EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7 };

function monthIndex(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

/** A clock time WITH a zone next to a written date turns it into an instant; otherwise it stays a day. */
function withClock(day: Date, text: string, start: number, end: number): EvidenceTime {
  const window = text.slice(Math.max(0, start - 30), Math.min(text.length, end + 30));
  const m = CLOCK.exec(window);
  if (!m) return { at: day, precision: "day" };
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 1 || hour > 12 || minute > 59) return { at: day, precision: "day" };
  if (m[3]!.toLowerCase() === "p" && hour !== 12) hour += 12;
  if (m[3]!.toLowerCase() === "a" && hour === 12) hour = 0;
  const offset = ZONE_HOURS[m[4]!.toUpperCase()]!;
  return { at: new Date(day.getTime() + ((hour - offset) * 60 + minute) * 60_000), precision: "instant" };
}

/** Every explicit, plausible date (with its real precision) written in the text. */
export function findExplicitDates(text: string, now: Date, slack: DayZoneSlack = DEFAULT_POLICY.dayPrecision): EvidenceTime[] {
  const out: EvidenceTime[] = [];
  const bounded = text.slice(0, 20_000);
  const add = (t: EvidenceTime | null) => {
    // Re-validate through the strict parser's plausibility rules (not in the future, not absurdly old).
    if (t && out.length < MAX_DATE_MATCHES && parseDateValue(t.precision === "day" ? t.at.toISOString().slice(0, 10) : t.at.toISOString(), now, slack)) out.push(t);
  };
  for (const re of [MONTH_FIRST, DAY_FIRST]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(bounded)) && n++ < MAX_DATE_MATCHES) {
      const [month, day] = re === MONTH_FIRST ? [monthIndex(m[1]!), Number(m[2])] : [monthIndex(m[2]!), Number(m[1])];
      const label = dayLabel(Number(m[3]), month, day);
      if (label) add(withClock(label, bounded, m.index, m.index + m[0].length));
    }
  }
  ISO_IN_TEXT.lastIndex = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = ISO_IN_TEXT.exec(bounded)) && n++ < MAX_DATE_MATCHES) add(parseDateValue(m[1], now, slack));
  return out;
}

/**
 * The time a proposal refers to, IF the given texts explicitly establish it:
 * the first explicit date in the texts consistent with the proposed value.
 * The returned value and precision are the text's own, never the model's.
 */
export function establishTime(proposed: string, texts: string[], now: Date, policy: VerificationPolicy = DEFAULT_POLICY): EvidenceTime | null {
  const p = parseDateValue(proposed, now, policy.dayPrecision);
  if (!p) return null;
  for (const text of texts) {
    for (const found of findExplicitDates(text, now, policy.dayPrecision)) {
      // An exact proposal must match an exact statement within tolerance; a date-level match keeps day precision.
      if (timesConsistent(p, found, policy.timeConflictToleranceMinutes, policy.dayPrecision)) return found;
    }
  }
  return null;
}

/** Sentences of a page that mention the event (for an event time stated in the page itself). */
export function eventSentences(text: string, category: EventCategory): string[] {
  const words = activeTerms(category);
  return sentences(text.slice(0, 50_000))
    .filter((s) => words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(s)))
    .slice(0, 200);
}

/**
 * A placeholder for a cited page with no verbatim text, used ONLY as an
 * extraction target. It carries no excerpt and no stance, and is never stored
 * unless reading the page turned it into evidence.
 */
export function citedPageTarget(cited: { url: string; title: string | null }, input: { category: EventCategory; context: SearchContext; now: Date; runId: string | null; registry?: readonly OfficialSource[] }): NormalizedEvidence {
  const official = classifyOfficial(cited.url, input.category, input.registry ?? OFFICIAL_SOURCES);
  const domain = publisherDomain(cited.url);
  const publisher = (official?.organization ?? domain ?? new URL(cited.url).hostname).slice(0, 200);
  return {
    id: null,
    canonicalUrl: cited.url,
    originalUrl: null,
    publisherDomain: domain,
    publisher,
    sourceName: publisher,
    sourceType: official ? "official_feed" : "web_page",
    sourceClass: official?.sourceClass ?? "UNKNOWN",
    title: cited.title,
    eventTimeAsReported: null,
    eventTimePrecision: null,
    publishedAt: null,
    publishedAtPrecision: null,
    retrievedAt: input.now,
    excerpt: null,
    note: "Cited by Verity's research agent.",
    stance: "context",
    locationMatch: matchLocation(cited.title ?? "", input.context),
    isPrimary: official?.primaryForCategory ?? false,
    attributions: [],
    originRef: null,
    retrievalMethod: "agent",
    retrievalSteps: ["agent"],
    finalUrl: null,
    extractRef: null,
    classifiedBy: "rules",
    query: null,
    providerRequestId: input.runId?.slice(0, 128) ?? null,
  };
}

export function agentEvidence(input: {
  citations: AgentCitationInput[];
  proposals: AgentProposalInput[];
  category: EventCategory;
  context: SearchContext;
  now: Date;
  runId: string | null;
  policy?: VerificationPolicy;
  registry?: readonly OfficialSource[];
}): AgentEvidenceResult {
  const policy = input.policy ?? DEFAULT_POLICY;
  const registry = input.registry ?? OFFICIAL_SOURCES;
  const stats = { citations: input.citations.length, accepted: 0, rejectedUrls: 0, withoutExcerpt: 0, proposedTimes: 0, acceptedTimes: 0 };

  // Group citations by canonical URL: one resource, one record.
  const groups = new Map<string, { title: string | null; excerpts: string[] }>();
  for (const c of input.citations) {
    const canonical = typeof c.url === "string" ? canonicalizeUrl(c.url) : { ok: false as const };
    if (!canonical.ok) {
      stats.rejectedUrls += 1;
      continue;
    }
    const excerpts = c.excerpts.filter((e) => typeof e === "string" && e.trim().length > 0).map((e) => e.slice(0, MAX_EXCERPT_CHARS));
    const group = groups.get(canonical.url) ?? { title: null, excerpts: [] };
    group.title ??= typeof c.title === "string" ? c.title.trim().slice(0, 300) || null : null;
    for (const e of excerpts) if (group.excerpts.length < MAX_EXCERPTS && !group.excerpts.includes(e)) group.excerpts.push(e);
    groups.set(canonical.url, group);
  }
  const proposalsByUrl = new Map<string, AgentProposalInput>();
  for (const p of input.proposals) {
    const canonical = canonicalizeUrl(p.url);
    if (canonical.ok && !proposalsByUrl.has(canonical.url)) proposalsByUrl.set(canonical.url, p);
  }

  const evidence: NormalizedEvidence[] = [];
  const unsupported: UnsupportedProposal[] = [];
  const excerptless: AgentEvidenceResult["excerptless"] = [];
  for (const [url, group] of groups) {
    if (evidence.length >= MAX_SOURCES) break;
    // A citation without any verbatim text supports nothing.
    if (group.excerpts.length === 0) {
      stats.withoutExcerpt += 1;
      if (excerptless.length < MAX_SOURCES) excerptless.push({ url, title: group.title });
      continue;
    }
    const sentence = selectExcerpt(group.excerpts.join("\n"), input.category, input.context);
    const excerpt = sentence ?? (group.excerpts[0]!.length <= 1000 ? group.excerpts[0]! : null);
    const stance = sentence ? classifyStance(sentence, input.category) : "context";
    const official = classifyOfficial(url, input.category, registry);
    const domain = publisherDomain(url);
    const publisher = (official?.organization ?? domain ?? new URL(url).hostname).slice(0, 200);

    const proposal = proposalsByUrl.get(url);
    const establish = (field: UnsupportedProposal["field"], raw: string | null | undefined): EvidenceTime | null => {
      if (!raw || typeof raw !== "string" || !raw.trim()) return null;
      stats.proposedTimes += 1;
      const t = establishTime(raw.trim().slice(0, 64), group.excerpts, input.now, policy);
      if (t) stats.acceptedTimes += 1;
      else unsupported.push({ url, field, proposed: raw.trim().slice(0, 64) });
      return t;
    };
    const published = establish("published", proposal?.publishedAt);
    const eventTime = establish("event_time", proposal?.eventTime);

    evidence.push({
      id: null,
      canonicalUrl: url,
      originalUrl: null,
      publisherDomain: domain,
      publisher,
      sourceName: publisher,
      sourceType: official ? "official_feed" : "web_page",
      sourceClass: official?.sourceClass ?? "UNKNOWN",
      title: group.title,
      eventTimeAsReported: eventTime?.at ?? null,
      eventTimePrecision: eventTime?.precision ?? null,
      publishedAt: published?.at ?? null,
      publishedAtPrecision: published?.precision ?? null,
      retrievedAt: input.now,
      excerpt,
      note: "Cited by Verity's research agent.",
      stance,
      locationMatch: matchLocation([group.title ?? "", excerpt ?? ""].join(". "), input.context),
      isPrimary: official?.primaryForCategory ?? false,
      attributions: detectAttributions([group.title, ...group.excerpts].filter(Boolean).join("\n").slice(0, 4000)),
      originRef: null,
      retrievalMethod: "agent",
      retrievalSteps: ["agent"],
      finalUrl: null,
      extractRef: null,
      classifiedBy: "rules",
      query: null,
      providerRequestId: input.runId?.slice(0, 128) ?? null,
    });
    stats.accepted += 1;
  }
  return { evidence, unsupported, excerptless, stats };
}
