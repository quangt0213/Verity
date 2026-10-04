import type { EventCategory } from "@verity/contracts";
import { detectAttributions } from "./attribution";
import { reconcileTimes, toEvidenceTime, type EvidenceTime } from "./dates";
import type { NormalizedEvidence } from "./evidence";
import type { SearchContext } from "./geocoding";
import { unionSteps, withPublished } from "./merge";
import { classifyOfficial, OFFICIAL_SOURCES, type OfficialSource } from "./official-sources";
import { DEFAULT_POLICY, type VerificationPolicy } from "./policy";
import { classifyStance } from "./stance";
import { matchLocation, selectExcerpt } from "./text-evidence";
import { canonicalizeUrl, publisherDomain } from "./url";

/**
 * Search + Extract → ONE evidence record. A page read for a search result
 * enriches that same record (never a second, independent one), keeping its
 * provenance: retrievalSteps records "search" then "extract", and the URL
 * actually read is kept as finalUrl.
 *
 * Conservative by construction:
 *  - the page must be the same resource: a redirect to another site, or to a
 *    different registry organization, is rejected (the Search record stays);
 *  - source class and "primary" still come only from the reviewed registry;
 *  - the excerpt is a verbatim sentence of the page's main text, and stance is
 *    classified on that one sentence by the same conservative classifier as
 *    Search: more text never loosens classification. When the page yields no
 *    usable sentence, the Search view is kept as it was;
 *  - the page's own publication metadata and the Search date are reconciled:
 *    a more precise consistent value wins; a material conflict drops both.
 */

export interface ExtractedPage {
  /** The URL Verity asked for (a canonical Search or citation URL). */
  requestedUrl: string;
  /** Canonical form of the URL actually read, after redirects (already screened). */
  finalUrl: string;
  title: string | null;
  /** Main-content plain text, capped (page-metadata.ts PAGE_LIMITS.textChars). */
  text: string;
  /** Publication time from the page's own metadata (page-metadata.ts), with its precision. */
  published: EvidenceTime | null;
  publishedConflict: boolean;
  /** Provider reference (e.g. a Nimble Extract task id), for provenance. */
  ref: string | null;
}

export type Enriched =
  | { ok: true; evidence: NormalizedEvidence; timeConflict: boolean; excerptFromPage: boolean }
  | { ok: false; reason: "unsafe_final_url" | "redirected_off_site" | "redirected_other_organization" };

export function enrichWithPage(
  e: NormalizedEvidence,
  page: ExtractedPage,
  input: { category: EventCategory; context: SearchContext; policy?: VerificationPolicy; registry?: readonly OfficialSource[] },
): Enriched {
  const policy = input.policy ?? DEFAULT_POLICY;
  const registry = input.registry ?? OFFICIAL_SOURCES;
  const final = canonicalizeUrl(page.finalUrl);
  if (!final.ok || !e.canonicalUrl) return { ok: false, reason: "unsafe_final_url" };
  if (final.url !== e.canonicalUrl) {
    // Without a registrable domain (unknown suffix), only the identical host counts as the same site.
    const site = (url: string) => publisherDomain(url) ?? new URL(url).hostname;
    if (site(final.url) !== site(e.canonicalUrl)) return { ok: false, reason: "redirected_off_site" };
    const before = classifyOfficial(e.canonicalUrl, input.category, registry);
    const after = classifyOfficial(final.url, input.category, registry);
    if ((before?.organization ?? null) !== (after?.organization ?? null) || (before?.sourceClass ?? null) !== (after?.sourceClass ?? null)) {
      return { ok: false, reason: "redirected_other_organization" };
    }
  }

  const title = e.title ?? page.title;
  const pageExcerpt = selectExcerpt(page.text, input.category, input.context);
  const excerpt = pageExcerpt ?? e.excerpt;
  const stance = pageExcerpt ? classifyStance(pageExcerpt, input.category) : e.stance;
  const locationMatch = pageExcerpt ? matchLocation([title ?? "", pageExcerpt].join(". "), input.context) : e.locationMatch;
  const attributionText = [title, page.text.slice(0, 4000)].filter(Boolean).join("\n");
  const searchPublished = toEvidenceTime(e.publishedAt, e.publishedAtPrecision);
  const reconciled = page.publishedConflict
    ? { time: null, conflict: true }
    : reconcileTimes(page.published, searchPublished, policy.timeConflictToleranceMinutes, policy.dayPrecision);

  const evidence = withPublished(
    {
      ...e,
      title,
      excerpt,
      stance,
      locationMatch,
      attributions: pageExcerpt ? detectAttributions(attributionText) : e.attributions,
      retrievalMethod: "extract",
      retrievalSteps: unionSteps(e.retrievalSteps, ["extract"]),
      finalUrl: final.url !== e.canonicalUrl ? final.url : null,
      extractRef: page.ref,
    },
    reconciled.time,
  );
  return { ok: true, evidence, timeConflict: reconciled.conflict, excerptFromPage: pageExcerpt !== null };
}
