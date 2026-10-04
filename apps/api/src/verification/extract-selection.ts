import type { NormalizedEvidence } from "./evidence";
import { assignLineages } from "./lineage";
import { isEnriched } from "./merge";
import { DEFAULT_POLICY, type VerificationPolicy } from "./policy";

/**
 * Which provider-returned pages are worth reading (Nimble Extract), in order.
 * Deterministic and pure. The result is a PRIORITY LIST under a ceiling: the
 * worker reads pages one at a time and stops as soon as the decision no
 * longer needs more evidence, so the ceiling is rarely reached.
 *
 * Eligible: external records returned by a provider in this run (Search
 * results, Agent citations), never community reports or user-submitted
 * links; not already read; not about another place; plausibly about this
 * event; and with a gap reading the page can fill (no exact time, no usable
 * sentence, or an unclear location).
 *
 * Order: identified sources (OFFICIAL/FIRST_PARTY, primary first), then
 * relevance (location named, stance taken), then a missing time (page
 * metadata often has an exact one), then the provider's own order.
 * Diversity: at most ONE page per lineage (obvious duplicates such as
 * syndicated copies or the same URL are never read twice), and a publisher
 * not yet chosen is preferred over a second page from the same publisher.
 */

export interface ExtractNeeds {
  time: boolean;
  content: boolean;
  location: boolean;
}

export function extractNeeds(e: NormalizedEvidence): ExtractNeeds {
  const exactTime = (e.publishedAt && e.publishedAtPrecision === "instant") || (e.eventTimeAsReported && e.eventTimePrecision === "instant");
  return { time: !exactTime, content: e.excerpt === null || e.stance === "context", location: e.locationMatch === "unclear" };
}

export function selectExtractCandidates(input: {
  /** This run's provider observations, already merged with stored records. */
  found: NormalizedEvidence[];
  stored: NormalizedEvidence[];
  max: number;
  policy?: VerificationPolicy;
}): NormalizedEvidence[] {
  const policy = input.policy ?? DEFAULT_POLICY;
  if (input.max <= 0) return [];
  const verifying = new Set<string>(policy.rules.verifiedSourceClasses);
  const foundUrls = new Set(input.found.map((f) => f.canonicalUrl).filter(Boolean));
  const all = [...input.stored.filter((s) => !s.canonicalUrl || !foundUrls.has(s.canonicalUrl)), ...input.found];
  const lineageOf = new Map(assignLineages(all, policy).map((r, i) => [all[i]!, r.lineage.lineageId]));

  // Lineages whose content Verity has already read from a page: another copy adds nothing.
  const readLineages = new Set(all.filter(isEnriched).map((r) => lineageOf.get(r)!));

  const eligible = input.found
    .map((e, index) => ({ e, index, needs: extractNeeds(e), identified: verifying.has(e.sourceClass) }))
    .filter(({ e, needs, identified }) => {
      if (e.sourceType === "community_report" || !e.canonicalUrl) return false;
      if (!e.retrievalSteps.includes("search") && !e.retrievalSteps.includes("agent")) return false;
      if (isEnriched(e) || e.locationMatch === "mismatch") return false;
      const relevant = e.excerpt !== null || e.locationMatch === "exact" || e.locationMatch === "near" || identified;
      return relevant && (needs.time || needs.content || needs.location);
    });

  const rank = (c: (typeof eligible)[number]) => [
    c.identified ? (c.e.isPrimary ? 0 : 1) : 2,
    -((c.e.locationMatch === "exact" ? 2 : c.e.locationMatch === "near" ? 1 : 0) + (c.e.stance !== "context" ? 1 : 0)),
    c.needs.time ? 0 : 1,
    c.index,
  ];
  const ordered = eligible.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
    return 0;
  });

  const chosen: NormalizedEvidence[] = [];
  const lineages = new Set<string>(readLineages);
  const publishers = new Set<string>();
  for (const pass of ["new_publisher", "any_publisher"] as const) {
    for (const { e } of ordered) {
      if (chosen.length >= input.max) return chosen;
      const lineage = lineageOf.get(e)!;
      const publisher = e.publisherDomain ?? e.canonicalUrl!;
      if (chosen.includes(e) || lineages.has(lineage)) continue;
      if (pass === "new_publisher" && publishers.has(publisher)) continue;
      chosen.push(e);
      lineages.add(lineage);
      publishers.add(publisher);
    }
  }
  return chosen;
}
