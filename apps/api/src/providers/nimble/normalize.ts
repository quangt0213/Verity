import type { EventCategory } from "@verity/contracts";
import { detectAttributions } from "../../verification/attribution";
import { parseDateValue, type DayZoneSlack, type EvidenceTime } from "../../verification/dates";
import { DEFAULT_POLICY } from "../../verification/policy";
import type { NormalizedEvidence } from "../../verification/evidence";
import type { SearchContext } from "../../verification/geocoding";
import { classifyOfficial, OFFICIAL_SOURCES, type OfficialSource } from "../../verification/official-sources";
import { classifyStance } from "../../verification/stance";
import { matchLocation, selectExcerpt } from "../../verification/text-evidence";
import { canonicalizeUrl, publisherDomain } from "../../verification/url";
import type { SearchResultItem } from "./client";

/**
 * Nimble search result → NormalizedEvidence. Everything Nimble-specific ends
 * here. Rules:
 *  - the URL must canonicalize (public http(s), no credentials); otherwise rejected;
 *  - OFFICIAL/FIRST_PARTY comes only from the reviewed registry or .gov, never
 *    from text or the provider, and "primary" only where the registry says the
 *    organization is authoritative for this category;
 *  - publishedAt comes only from a returned publication-date field, else null
 *    (never the retrieval time);
 *  - the quote is a verbatim sentence from the returned text, else null;
 *  - stance is classified on that sentence only, conservatively (stance.ts).
 */

const DATE_FIELDS = ["publish_date", "published_date", "published_at", "date_published", "publication_date"];

/**
 * A trustworthy publication time from additional_data, with its real
 * precision, or null. News focus returns date-only values ("2026-10-03"):
 * those are DAY precision, never midnight UTC. Relative phrases ("2 hours
 * ago") and bare years are rejected.
 */
export function parsePublishDate(additional: Record<string, unknown> | null | undefined, now: Date, slack: DayZoneSlack = DEFAULT_POLICY.dayPrecision): EvidenceTime | null {
  if (!additional) return null;
  for (const field of DATE_FIELDS) {
    const parsed = parseDateValue(additional[field], now, slack);
    if (parsed) return parsed;
  }
  return null;
}

export type Normalized = { ok: true; evidence: NormalizedEvidence; usable: boolean; promising: boolean } | { ok: false; reason: "invalid_url" | "no_text" };

export function normalizeResult(
  item: SearchResultItem,
  input: {
    category: EventCategory;
    context: SearchContext;
    query: string;
    requestId: string | null;
    now: Date;
    registry?: readonly OfficialSource[];
  },
): Normalized {
  const canonical = canonicalizeUrl(item.url);
  if (!canonical.ok) return { ok: false, reason: "invalid_url" };
  const text = [item.content, item.description].find((t) => t && t.trim().length > 0) ?? "";
  const title = item.title.trim().slice(0, 300) || null;
  if (!text && !title) return { ok: false, reason: "no_text" };

  const official = classifyOfficial(canonical.url, input.category, input.registry ?? OFFICIAL_SOURCES);
  const domain = publisherDomain(canonical.url);
  const publisher = official?.organization ?? domain ?? new URL(canonical.url).hostname;
  const excerpt = selectExcerpt(text, input.category, input.context);
  const stance = excerpt ? classifyStance(excerpt, input.category) : "context";
  const locationMatch = matchLocation([title ?? "", excerpt ?? ""].join(". "), input.context);
  const published = parsePublishDate(item.additional_data ?? null, input.now);

  const evidence: NormalizedEvidence = {
    id: null,
    canonicalUrl: canonical.url,
    originalUrl: canonical.changed ? item.url.slice(0, 2048) : null,
    publisherDomain: domain,
    publisher: publisher.slice(0, 200),
    sourceName: publisher.slice(0, 200),
    sourceType: official ? "official_feed" : "web_page",
    sourceClass: official?.sourceClass ?? "UNKNOWN",
    title,
    eventTimeAsReported: null,
    eventTimePrecision: null,
    publishedAt: published?.at ?? null,
    publishedAtPrecision: published?.precision ?? null,
    retrievedAt: input.now,
    excerpt,
    note: null,
    stance,
    locationMatch,
    isPrimary: official?.primaryForCategory ?? false,
    attributions: detectAttributions([title, excerpt ?? text.slice(0, 4000)].filter(Boolean).join("\n")),
    originRef: null,
    retrievalMethod: "search",
    retrievalSteps: ["search"],
    finalUrl: null,
    extractRef: null,
    classifiedBy: "rules",
    query: input.query.slice(0, 300),
    providerRequestId: input.requestId,
  };
  // "Usable" for cost analysis: a stance, a located mention and a publication time.
  const located = locationMatch === "exact" || locationMatch === "near";
  const usable = stance !== "context" && located && published !== null;
  // "Promising": relevant enough that reading the page (Extract) may complete it.
  const promising = stance !== "context" || located;
  return { ok: true, evidence, usable, promising };
}
