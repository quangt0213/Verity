import { checkPublicHttpUrl } from "@verity/contracts";
import { parse } from "tldts";

/**
 * Canonical source URLs. One canonical URL means one source record per event,
 * so canonicalization must never merge two different resources: when unsure,
 * keep the URL as it is (a false negative only costs a duplicate record, which
 * lineage analysis can still relate; a false positive silently loses evidence).
 *
 * What changes:
 *  - hostname case and a trailing dot; default ports (via the URL parser)
 *  - well-known tracking parameters (utm_*, click ids, mailing-list ids)
 *  - the order of the remaining query parameters (stable for repeated keys)
 *  - an empty query string, and a navigation-only fragment
 * What never changes: scheme, "www." and other subdomains, path (including its
 * case and trailing slash), meaningful query parameters, AMP or mobile
 * variants, and hash routes ("#/...", "#!...") that select content.
 */

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "yclid",
  "twclid",
  "ttclid",
  "igshid",
  "li_fat_id",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "oly_anon_id",
  "oly_enc_id",
  "vero_id",
  "mkt_tok",
]);

function isTrackingParam(name: string): boolean {
  const key = name.toLowerCase();
  return key.startsWith("utm_") || TRACKING_PARAMS.has(key);
}

/** Hash routes select content in single-page apps; plain anchors only navigate within a page. */
function isContentFragment(hash: string): boolean {
  return hash.startsWith("#/") || hash.startsWith("#!");
}

export type CanonicalUrl = { ok: true; url: string; changed: boolean } | { ok: false; reason: string };

export function canonicalizeUrl(raw: string): CanonicalUrl {
  const checked = checkPublicHttpUrl(raw);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const url = new URL(checked.url.toString());

  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");

  // Work on the raw "a=b" segments so values keep their exact encoding:
  // re-serializing through URLSearchParams would rewrite ",", "~", spaces, etc.
  const segments = url.search.replace(/^\?/, "").split("&").filter(Boolean);
  const keyOf = (segment: string) => {
    const rawKey = segment.split("=", 1)[0]!;
    try {
      return decodeURIComponent(rawKey.replace(/\+/g, " "));
    } catch {
      return rawKey;
    }
  };
  const kept = segments.filter((segment) => !isTrackingParam(keyOf(segment)));
  // Array.prototype.sort is stable, so repeated keys keep their relative order.
  kept.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  url.search = kept.length > 0 ? `?${kept.join("&")}` : "";

  if (url.hash && !isContentFragment(url.hash)) url.hash = "";

  const canonical = url.toString();
  return { ok: true, url: canonical, changed: canonical !== checked.url.toString() };
}

/**
 * The organization a URL belongs to, from the Public Suffix List (including
 * private suffixes, so two blogs on one hosting platform stay distinct):
 * "news.bbc.co.uk" and "www.bbc.co.uk" are both "bbc.co.uk"; "alice.github.io"
 * and "bob.github.io" differ. Publisher identity is NOT evidence lineage: two
 * articles from one publisher can be independent reports.
 */
export function publisherDomain(urlOrHost: string): string | null {
  const host = /^[a-z][a-z0-9+.-]*:\/\//i.test(urlOrHost) ? safeHostname(urlOrHost) : urlOrHost.toLowerCase();
  if (!host) return null;
  const info = parse(host, { allowPrivateDomains: true });
  if (info.isIp || !info.domain || (!info.isIcann && !info.isPrivate)) return null;
  return info.domain;
}

function safeHostname(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}
