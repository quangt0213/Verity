import { parseDateValue, reconcileTimes, timesConsistent, type DayZoneSlack, type EvidenceTime } from "./dates";

/**
 * Deterministic reading of a fetched page: publication time from the page's
 * own metadata, its title, and its main text as plain text. The page is
 * HOSTILE DATA: it is only pattern-matched with bounded work, never executed,
 * rendered or interpreted by a model.
 *
 * Publication time, by precedence (all from explicit publication metadata):
 *   1. schema.org JSON-LD `datePublished` on an article/page-like object
 *   2. <meta property|name="article:published_time">
 *   3. other explicit publication metadata: itemprop="datePublished",
 *      pubdate / publishdate / dcterms.issued / DC.date.issued / parsely-pub-date
 *   4. <time datetime> that is semantically a publication time
 *      (itemprop="datePublished" or the `pubdate` attribute)
 * Never: dateModified, article:modified_time, og:updated_time, copyright
 * years, footer dates, or dates in the prose. If credible fields materially
 * conflict, the publication time is null. Precision is preserved (an exact
 * timestamp is an instant, a date alone is a day).
 */

export const PAGE_LIMITS = {
  /** HTML scanned for metadata (head and early body). */
  htmlScanChars: 1_000_000,
  jsonLdBlocks: 10,
  jsonLdBlockChars: 100_000,
  jsonLdNodes: 2_000,
  jsonLdDepth: 8,
  metaTags: 400,
  timeTags: 60,
  /** Publication-date candidates examined in total. */
  dateCandidates: 20,
  /** Plain text kept for excerpt selection, stance, attribution and location. */
  textChars: 100_000,
  titleChars: 300,
} as const;

export type PublicationSource = "json_ld" | "article_meta" | "meta" | "time_element";
const TIER: Record<PublicationSource, number> = { json_ld: 1, article_meta: 2, meta: 3, time_element: 4 };

export interface PublicationTime {
  time: EvidenceTime | null;
  /** Credible fields disagreed materially; the time was withheld. */
  conflict: boolean;
  source: PublicationSource | null;
  /** How many credible candidates were found. */
  candidates: number;
}

const ARTICLE_TYPES = /^(?:Article|NewsArticle|ReportageNews|AnalysisNewsArticle|BackgroundNewsArticle|OpinionNewsArticle|ReviewNewsArticle|LiveBlogPosting|BlogPosting|Report|WebPage|SpecialAnnouncement)$/;
const META_PUBLISHED = new Set(["pubdate", "publishdate", "publish-date", "publish_date", "dcterms.issued", "dc.date.issued", "parsely-pub-date"]);

/** Attributes of one tag. Values are raw text; nothing is decoded beyond what dates need. */
function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  // Skip the tag name.
  const body = tag.replace(/^<\s*[a-zA-Z0-9]+/, "").replace(/\/?>$/, "");
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = re.exec(body)) && count++ < 40) out.set(m[1]!.toLowerCase(), (m[2] ?? m[3] ?? m[4] ?? "").trim());
  return out;
}

function* matches(re: RegExp, text: string, max: number): Generator<RegExpExecArray> {
  let m: RegExpExecArray | null;
  let n = 0;
  while (n < max && (m = re.exec(text))) {
    n += 1;
    yield m;
  }
}

function typesOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string").map((x) => x.replace(/^https?:\/\/schema\.org\//, ""));
}

/** datePublished values of article/page-like JSON-LD objects (bounded traversal). */
function jsonLdDates(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (const m of matches(re, html, PAGE_LIMITS.jsonLdBlocks)) {
    const raw = m[1]!;
    if (raw.length > PAGE_LIMITS.jsonLdBlockChars) continue;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    let nodes = 0;
    const visit = (value: unknown, depth: number) => {
      if (depth > PAGE_LIMITS.jsonLdDepth || nodes++ > PAGE_LIMITS.jsonLdNodes || value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const v of value) visit(v, depth + 1);
        return;
      }
      const node = value as Record<string, unknown>;
      if (typesOf(node).some((t) => ARTICLE_TYPES.test(t)) && typeof node.datePublished === "string") out.push(node.datePublished);
      for (const [key, v] of Object.entries(node)) {
        // Comments, reviews and the like carry their own dates; only follow structural keys.
        if (key === "@graph" || key === "mainEntity" || key === "mainEntityOfPage" || key === "hasPart") visit(v, depth + 1);
      }
    };
    visit(data, 0);
  }
  return out;
}

export function extractPublication(htmlInput: string, now: Date, slack: DayZoneSlack, toleranceMinutes: number): PublicationTime {
  const html = htmlInput.slice(0, PAGE_LIMITS.htmlScanChars);
  const raw: Array<{ source: PublicationSource; value: string }> = [];
  for (const value of jsonLdDates(html)) raw.push({ source: "json_ld", value });
  for (const m of matches(/<meta\b[^>]*>/gi, html, PAGE_LIMITS.metaTags)) {
    const a = attributes(m[0]);
    const key = (a.get("property") ?? a.get("name") ?? "").toLowerCase();
    const content = a.get("content");
    if (!content) continue;
    if (key === "article:published_time") raw.push({ source: "article_meta", value: content });
    else if (META_PUBLISHED.has(key) || a.get("itemprop")?.toLowerCase() === "datepublished") raw.push({ source: "meta", value: content });
  }
  for (const m of matches(/<time\b[^>]*>/gi, html, PAGE_LIMITS.timeTags)) {
    const a = attributes(m[0]);
    const datetime = a.get("datetime");
    if (datetime && (a.get("itemprop")?.toLowerCase() === "datepublished" || a.has("pubdate"))) raw.push({ source: "time_element", value: datetime });
  }

  const candidates = raw
    .slice(0, PAGE_LIMITS.dateCandidates)
    .map((c) => ({ source: c.source, time: parseDateValue(c.value, now, slack) }))
    .filter((c): c is { source: PublicationSource; time: EvidenceTime } => c.time !== null)
    .sort((a, b) => TIER[a.source] - TIER[b.source]);
  if (candidates.length === 0) return { time: null, conflict: false, source: null, candidates: 0 };

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (!timesConsistent(candidates[i]!.time, candidates[j]!.time, toleranceMinutes, slack)) {
        return { time: null, conflict: true, source: null, candidates: candidates.length };
      }
    }
  }
  // All consistent: the highest-precedence value, made precise by a consistent exact timestamp if one exists.
  const best = candidates[0]!;
  let time = best.time;
  for (const c of candidates.slice(1)) time = reconcileTimes(time, c.time, toleranceMinutes, slack).time ?? time;
  return { time, conflict: false, source: best.source, candidates: candidates.length };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
const decodeBasic = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, e: string) => ENTITIES[e]!);
const clean = (s: string) => decodeBasic(s).replace(/<[^>]*>/g, " ").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();

/** The page's own title: og:title, else <title>. Plain text, capped. */
export function extractTitle(htmlInput: string): string | null {
  const html = htmlInput.slice(0, PAGE_LIMITS.htmlScanChars);
  for (const m of matches(/<meta\b[^>]*>/gi, html, PAGE_LIMITS.metaTags)) {
    const a = attributes(m[0]);
    if ((a.get("property") ?? a.get("name"))?.toLowerCase() === "og:title" && a.get("content")) return clean(a.get("content")!).slice(0, PAGE_LIMITS.titleChars) || null;
  }
  const t = /<title\b[^>]*>([\s\S]{0,2000}?)<\/title\s*>/i.exec(html);
  return t ? clean(t[1]!).slice(0, PAGE_LIMITS.titleChars) || null : null;
}

/**
 * Markdown (Nimble's Readability main-content conversion) to plain text, so
 * excerpts quote the page's words without markup. Links keep their text,
 * images and link targets are dropped, and line structure is kept for
 * sentence splitting.
 */
export function markdownToText(markdown: string): string {
  return markdown
    .slice(0, PAGE_LIMITS.textChars * 2)
    .replace(/!\[[^\]]{0,500}\]\([^)]{0,2000}\)/g, "")
    .replace(/\[([^\]]{0,500})\]\([^)]{0,2000}\)/g, "$1")
    .replace(/^[ \t]*\[[^\]]{1,200}\]:[ \t]*\S+.*$/gm, " ")
    .replace(/<[^>]{0,2000}>/g, " ")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, "")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/\|/g, " ")
    // Control characters (except line breaks, which separate sentences) become spaces.
    .replace(/(?!\n)\p{Cc}/gu, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, PAGE_LIMITS.textChars);
}
