import type { Attribution } from "./evidence";
import { publisherDomain } from "./url";

/**
 * Deterministic attribution detection. Only explicit, named origins count:
 * "according to Caltrans", "Caltrans said in a statement", a wire dateline
 * "(AP) —", or a wire byline. Generic subjects ("police", "officials",
 * "witnesses") are ignored: they don't identify one originating source, so they
 * must not merge otherwise-independent reports.
 */

const WIRE_ALIASES: Record<string, string> = {
  ap: "associated press",
  "associated press": "associated press",
  reuters: "reuters",
  afp: "agence france presse",
  "agence france presse": "agence france presse",
  "agence france-presse": "agence france presse",
  upi: "united press international",
  "united press international": "united press international",
};

/** Wire services' own sites, so a record FROM the wire matches records attributed TO it. */
const WIRE_DOMAINS: Record<string, string> = {
  "apnews.com": "associated press",
  "ap.org": "associated press",
  "reuters.com": "reuters",
  "afp.com": "agence france presse",
  "upi.com": "united press international",
};

const GENERIC_SUBJECTS = new Set([
  "police",
  "officials",
  "authorities",
  "witnesses",
  "residents",
  "sources",
  "reports",
  "a spokesperson",
  "a spokesman",
  "a spokeswoman",
  "the spokesperson",
  "he",
  "she",
  "they",
  "it",
  "we",
  "i",
]);

/** Normalize an organization name into an origin key ("The Associated Press" → "associated press"). */
export function normalizeOrigin(name: string): string | null {
  const key = name
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .replace(/[^a-z0-9&\s-]/g, " ")
    .replace(/^\s*the\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!key || key.length < 2 || GENERIC_SUBJECTS.has(key)) return null;
  return WIRE_ALIASES[key] ?? key;
}

// A capitalized organization name of up to six words ("San Francisco Fire Department", "Caltrans", "SFMTA").
const ORG = String.raw`((?:[A-Z][\w&.'’-]*|AP)(?:\s+(?:of|and|for|the|[A-Z][\w&.'’-]*)){0,5})`;
const EXPLICIT_PATTERNS = [
  new RegExp(String.raw`\baccording to (?:the |a )?${ORG}`, "g"),
  new RegExp(String.raw`${ORG} (?:said in a statement|announced|confirmed in a statement|reported in a statement)`, "g"),
];
const SYNDICATION_PATTERNS = [
  /\((AP|Reuters|AFP|UPI)\)\s*[—–-]/g,
  /^\s*(?:By\s+)?(?:The\s+)?(Associated Press|Reuters|Agence France-Presse|AFP)\s*$/gim,
  /\b(?:copyright|©)\s*(?:\d{4}\s+)?(?:The\s+)?(Associated Press|Reuters|Agence France-Presse|AFP)\b/gi,
];

export function detectAttributions(text: string | null | undefined): Attribution[] {
  if (!text) return [];
  const found = new Map<string, Attribution>();
  const add = (label: string, kind: Attribution["kind"]) => {
    const trimmed = label.trim().replace(/[.,;:]+$/, "");
    const origin = normalizeOrigin(trimmed);
    if (!origin) return;
    const existing = found.get(origin);
    // A syndication marker is the stronger statement about origin; keep it if both appear.
    if (!existing || (existing.kind === "explicit" && kind === "syndication")) found.set(origin, { origin, label: trimmed, kind });
  };
  for (const pattern of SYNDICATION_PATTERNS) for (const m of text.matchAll(pattern)) add(m[1]!, "syndication");
  for (const pattern of EXPLICIT_PATTERNS) for (const m of text.matchAll(pattern)) add(m[1]!, "explicit");
  return [...found.values()];
}

/**
 * The origin keys a record itself represents: its publisher's name and, for
 * wire services, the wire. Used to relate "X reports" to "according to X".
 */
export function ownOriginKeys(e: { publisher: string | null; sourceName: string; canonicalUrl: string | null }): Set<string> {
  const keys = new Set<string>();
  for (const name of [e.publisher, e.sourceName]) {
    const key = name ? normalizeOrigin(name) : null;
    if (key) keys.add(key);
  }
  const domain = e.canonicalUrl ? publisherDomain(e.canonicalUrl) : null;
  if (domain && WIRE_DOMAINS[domain]) keys.add(WIRE_DOMAINS[domain]);
  return keys;
}
