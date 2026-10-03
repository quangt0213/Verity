import { z } from "zod";
import { LIMITS } from "./limits";

export type UrlCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".home.arpa",
  ".corp",
  ".arpa",
];

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Syntactic screen for user-submitted source links. It accepts only public
 * http(s) URLs that use a domain name. IP literals are rejected outright, which
 * covers loopback, RFC 1918, link-local, metadata (169.254.169.254) and the
 * numeric encodings the WHATWG parser normalizes to dotted IPv4.
 *
 * This is a first gate, not a complete SSRF defense: the Verity service must
 * also resolve DNS and reject private addresses before any fetch, and should
 * route fetches through Nimble rather than fetching directly.
 */
export function checkPublicHttpUrl(raw: string): UrlCheck {
  if (raw.length > LIMITS.sourceUrlMax) return { ok: false, reason: "Link is too long" };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "Not a valid link" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "Only http and https links are allowed" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "Links with embedded credentials are not allowed" };
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    return { ok: false, reason: "Links must use the standard web ports" };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253) return { ok: false, reason: "Not a valid link" };
  if (host.startsWith("[") || host.includes(":") || IPV4_LITERAL.test(host)) {
    return { ok: false, reason: "Links must use a domain name, not an IP address" };
  }
  if (!host.includes(".")) return { ok: false, reason: "Links must use a public domain name" };
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: "Links to private or local networks are not allowed" };
  }
  return { ok: true, url };
}

export const publicHttpUrlSchema = z
  .string()
  .max(LIMITS.sourceUrlMax, { message: "Link is too long" })
  .transform((value, ctx) => {
    const result = checkPublicHttpUrl(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.reason });
      return z.NEVER;
    }
    return result.url.toString();
  });

/** True only for absolute http(s) URLs. Use before rendering any link from data. */
export function isSafeHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
