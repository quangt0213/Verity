import { createHash } from "node:crypto";
import { jaccard, textTokens } from "@verity/contracts";
import { ownOriginKeys } from "./attribution";
import { evidenceKey, type EvidenceRecord, type LineageReason, type NormalizedEvidence } from "./evidence";
import { DEFAULT_POLICY, evidenceTime, type VerificationPolicy } from "./policy";

/**
 * Evidence lineage: which records trace back to the same origin, so they count
 * once toward independence. URL count ≠ source count, and publisher count ≠
 * source count.
 *
 * Records are related ONLY by strong, explainable links:
 *   canonical_url         the same canonical resource
 *   same_origin_metadata  the same explicit origin reference (e.g. wire story id)
 *   syndication           both carry, or one IS, the same wire/syndication origin
 *   explicit_attribution  both attribute, or one is, the same named origin
 *   near_duplicate        substantially the same text
 * Publisher identity alone is NOT a link: two articles from one newspaper can
 * be independent reports, and two different publishers repeating one wire story
 * are one lineage. Community reports always form their own single lineage.
 *
 * Each linked record stores its reason, the record it was related to, and the
 * attributed origin when relevant, so every grouping can be explained.
 */

export const COMMUNITY_LINEAGE_ID = "community";

/** Strongest first: when two records are related in several ways, the strongest reason is recorded. */
const REASON_STRENGTH: Record<Exclude<LineageReason, "own_origin" | "community">, number> = {
  canonical_url: 5,
  same_origin_metadata: 4,
  syndication: 3,
  explicit_attribution: 2,
  near_duplicate: 1,
};
type LinkReason = keyof typeof REASON_STRENGTH;

interface Link {
  reason: LinkReason;
  via: string | null;
}

const CLASS_RANK: Record<NormalizedEvidence["sourceClass"], number> = {
  OFFICIAL: 0,
  FIRST_PARTY: 1,
  REPUTABLE_NEWS: 2,
  LOCAL_NEWS: 3,
  SOCIAL: 4,
  UNKNOWN: 5,
  COMMUNITY: 6,
};

function similarityTokens(e: NormalizedEvidence): Set<string> {
  return textTokens([e.title, e.excerpt].filter(Boolean).join(" "));
}

/** The strongest link between two records, if any. */
function linkBetween(
  a: NormalizedEvidence,
  b: NormalizedEvidence,
  ctx: { origins: Map<NormalizedEvidence, Set<string>>; tokens: Map<NormalizedEvidence, Set<string>>; policy: VerificationPolicy },
): Link | null {
  if (a.canonicalUrl && a.canonicalUrl === b.canonicalUrl) return { reason: "canonical_url", via: null };
  if (a.originRef && a.originRef === b.originRef) return { reason: "same_origin_metadata", via: a.originRef };

  // Shared attributed origin, or one record attributes to what the other IS.
  const shared: Link[] = [];
  const consider = (kinds: Array<"explicit" | "syndication">, label: string) =>
    shared.push({ reason: kinds.includes("syndication") ? "syndication" : "explicit_attribution", via: label });
  for (const x of a.attributions) {
    for (const y of b.attributions) if (x.origin === y.origin) consider([x.kind, y.kind], x.label);
    if (ctx.origins.get(b)!.has(x.origin)) consider([x.kind], x.label);
  }
  for (const y of b.attributions) if (ctx.origins.get(a)!.has(y.origin)) consider([y.kind], y.label);
  if (shared.length > 0) return shared.sort((p, q) => REASON_STRENGTH[q.reason] - REASON_STRENGTH[p.reason])[0]!;

  const ta = ctx.tokens.get(a)!;
  const tb = ctx.tokens.get(b)!;
  const min = ctx.policy.lineage.nearDuplicateMinTokens;
  if (ta.size >= min && tb.size >= min && jaccard(ta, tb) >= ctx.policy.lineage.nearDuplicateSimilarity) {
    return { reason: "near_duplicate", via: null };
  }
  return null;
}

/** Representative preference: primary, then official/first-party, then earliest (event or publication) time, then earliest retrieval. */
function representativeOrder(a: NormalizedEvidence, b: NormalizedEvidence, keyA: string, keyB: string): number {
  if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
  if (CLASS_RANK[a.sourceClass] !== CLASS_RANK[b.sourceClass]) return CLASS_RANK[a.sourceClass] - CLASS_RANK[b.sourceClass];
  const ta = evidenceTime(a)?.getTime() ?? Number.POSITIVE_INFINITY;
  const tb = evidenceTime(b)?.getTime() ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta - tb;
  if (a.retrievedAt.getTime() !== b.retrievedAt.getTime()) return a.retrievedAt.getTime() - b.retrievedAt.getTime();
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

function lineageIdFor(representativeKey: string): string {
  return `lin_${createHash("sha256").update(representativeKey).digest("hex").slice(0, 32)}`;
}

/**
 * Assign every record (stored and newly retrieved, for one event) to a
 * lineage. Deterministic: the same records always produce the same lineages,
 * reasons and representatives.
 */
export function assignLineages(records: NormalizedEvidence[], policy: VerificationPolicy = DEFAULT_POLICY): EvidenceRecord[] {
  const keys = records.map((r, i) => evidenceKey(r, `idx:${i}`));
  const external = records.map((r, i) => ({ r, i })).filter(({ r }) => r.sourceType !== "community_report");
  const ctx = {
    origins: new Map(records.map((r) => [r, ownOriginKeys(r)] as const)),
    tokens: new Map(records.map((r) => [r, similarityTokens(r)] as const)),
    policy,
  };

  // Graph of strong links between external records.
  const links = new Map<number, Array<{ to: number; link: Link }>>();
  for (const { i } of external) links.set(i, []);
  for (let x = 0; x < external.length; x++) {
    for (let y = x + 1; y < external.length; y++) {
      const a = external[x]!;
      const b = external[y]!;
      const link = linkBetween(a.r, b.r, ctx);
      if (!link) continue;
      links.get(a.i)!.push({ to: b.i, link });
      links.get(b.i)!.push({ to: a.i, link });
    }
  }

  const out: EvidenceRecord[] = new Array(records.length);
  const seen = new Set<number>();
  for (const { i: start } of external) {
    if (seen.has(start)) continue;
    // Collect the connected component.
    const component: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const n = stack.pop()!;
      component.push(n);
      for (const { to } of links.get(n)!) {
        if (seen.has(to)) continue;
        seen.add(to);
        stack.push(to);
      }
    }
    component.sort((a, b) => representativeOrder(records[a]!, records[b]!, keys[a]!, keys[b]!));
    const root = component[0]!;
    const lineageId = lineageIdFor(keys[root]!);

    // Explain each member by a breadth-first path from the representative,
    // preferring the strongest link at each step.
    const parent = new Map<number, { from: number; link: Link }>();
    const visited = new Set([root]);
    const queue = [root];
    while (queue.length > 0) {
      const n = queue.shift()!;
      const next = [...links.get(n)!]
        .filter(({ to }) => !visited.has(to))
        .sort((p, q) => REASON_STRENGTH[q.link.reason] - REASON_STRENGTH[p.link.reason] || p.to - q.to);
      for (const { to, link } of next) {
        if (visited.has(to)) continue;
        visited.add(to);
        parent.set(to, { from: n, link });
        queue.push(to);
      }
    }
    for (const n of component) {
      const p = parent.get(n);
      out[n] = {
        ...records[n]!,
        lineage: p
          ? { lineageId, reason: p.link.reason, relatedTo: keys[p.from]!, via: p.link.via, countsAsIndependent: false }
          : { lineageId, reason: "own_origin", relatedTo: null, via: null, countsAsIndependent: true },
      };
    }
  }

  // Community reports: one lineage; its earliest report is the representative.
  const community = records
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.sourceType === "community_report")
    .sort((a, b) => representativeOrder(a.r, b.r, keys[a.i]!, keys[b.i]!));
  community.forEach(({ r, i }, position) => {
    out[i] = {
      ...r,
      lineage: { lineageId: COMMUNITY_LINEAGE_ID, reason: "community", relatedTo: null, via: null, countsAsIndependent: position === 0 },
    };
  });

  return out;
}
