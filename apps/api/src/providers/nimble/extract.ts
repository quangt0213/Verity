import { z } from "zod";
import { DEFAULT_POLICY, type VerificationPolicy } from "../../verification/policy";
import { extractPublication, extractTitle, markdownToText } from "../../verification/page-metadata";
import { canonicalizeUrl } from "../../verification/url";
import type { EvidenceExtractor, ExtractOutcome } from "../../worker/ports";
import { parseRetryAfter, readCapped, statusOutcome } from "./client";

/**
 * Nimble Extract behind the EvidenceExtractor port, per the official API
 * checked 2026-10-03 (POST {base}/v2/extract; OpenAPI ExtractPayload):
 *
 *   { url, formats: ["html", "markdown"], markdown_backend: "main_content",
 *     driver: "vx6", render: false, country, locale, request_timeout }
 *
 * Deliberately minimal: plain HTTP fetch (no browser, no JavaScript), Mozilla
 * Readability main-content markdown, and NO cookies, custom headers, request
 * body, browser actions, network capture, parsers, callbacks or storage. The
 * fetched site receives nothing from Verity: Nimble's fetcher requests the
 * page, and only the Nimble key (in our Authorization header to Nimble)
 * leaves the worker.
 *
 * Security: callers pass only screened provider-returned URLs; this client
 * screens the URL again, then screens the FINAL URL and every redirect hop
 * (a redirect may lead somewhere private or unsafe). The page is hostile data:
 * it is parsed with bounded, deterministic pattern matching only. Response
 * size is capped, and only the fields Verity needs leave this module (no raw
 * HTML, no full body).
 */

export const EXTRACT_PATH = "/v2/extract";
/** HTML plus markdown of one page; larger responses are refused unread. */
export const MAX_EXTRACT_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

const pageSchema = z.object({
  task_id: z.string().max(200).nullish(),
  url: z.string().min(1).max(4096),
  status: z.string().max(40),
  status_code: z.number().int().nullish(),
  data: z
    .object({
      html: z.string().nullish(),
      markdown: z.string().nullish(),
      redirects: z.array(z.object({ url: z.string().max(4096).nullish() }).passthrough()).max(30).nullish(),
    })
    .passthrough(),
});

export function createNimbleExtractor(options: {
  apiKey: string;
  baseUrl: string;
  now: () => Date;
  fetch?: typeof fetch;
  policy?: VerificationPolicy;
  country?: string;
}): EvidenceExtractor {
  const doFetch = options.fetch ?? fetch;
  const policy = options.policy ?? DEFAULT_POLICY;
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}${EXTRACT_PATH}`;

  return {
    name: "nimble-extract",
    configured: true,
    async extract({ url, signal }): Promise<ExtractOutcome> {
      const requested = canonicalizeUrl(url);
      if (!requested.ok) return { status: "page_failed", code: "extract_unsafe_url" };

      const body = {
        url: requested.url,
        formats: ["html", "markdown"],
        markdown_backend: "main_content",
        driver: "vx6",
        render: false,
        country: options.country ?? "US",
        locale: "en",
        request_timeout: REQUEST_TIMEOUT_MS,
      };

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
          signal,
          redirect: "error",
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        return { status: "unavailable", code: name === "TimeoutError" || name === "AbortError" ? "extract_timeout" : "extract_network", retryAfterSeconds: null };
      }

      let text: string | null;
      try {
        text = await readCapped(response, MAX_EXTRACT_RESPONSE_BYTES);
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        return { status: "unavailable", code: name === "TimeoutError" || name === "AbortError" ? "extract_timeout" : "extract_network", retryAfterSeconds: null };
      }
      // An oversized page is this page's problem, not the provider's.
      if (text === null) return { status: "page_failed", code: "extract_response_too_large" };

      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      if (!response.ok) {
        // Nimble's 555 is "request exceeded maximum execution time" for this page.
        if (response.status === 555) return { status: "page_failed", code: "extract_page_timeout" };
        const outcome = statusOutcome(response.status, parseRetryAfter(response.headers.get("retry-after"), json));
        if (outcome.ok) return { status: "page_failed", code: "extract_unexpected" };
        const code = outcome.code.replace(/^nimble_/, "extract_");
        if (outcome.kind === "transient") return { status: "unavailable", code, retryAfterSeconds: outcome.retryAfterSeconds };
        // A 400/422 rejects this URL (e.g. a blocked domain); auth and payment problems stop extraction.
        if (outcome.code === "nimble_bad_request") return { status: "page_failed", code };
        return { status: "permanent_error", code };
      }
      if (json === null) return { status: "unavailable", code: "extract_malformed_json", retryAfterSeconds: null };
      const parsed = pageSchema.safeParse(json);
      if (!parsed.success) return { status: "page_failed", code: "extract_malformed_response" };
      const page = parsed.data;

      if (page.status !== "success") return { status: "page_failed", code: `extract_${page.status.replace(/[^a-z_]/gi, "").slice(0, 30) || "failed"}` };
      if (page.status_code != null && (page.status_code < 200 || page.status_code > 299)) return { status: "page_failed", code: `extract_http_${page.status_code}` };

      // Every hop and the final URL must pass the same public-URL screen as the request.
      const hops = (page.data.redirects ?? []).map((r) => r.url).filter((u): u is string => typeof u === "string");
      if (hops.some((hop) => !canonicalizeUrl(hop).ok)) return { status: "page_failed", code: "extract_unsafe_redirect" };
      const final = canonicalizeUrl(page.url);
      if (!final.ok) return { status: "page_failed", code: "extract_unsafe_final_url" };

      const html = page.data.html ?? "";
      const pageText = markdownToText(page.data.markdown ?? "");
      if (!pageText && !html) return { status: "page_failed", code: "extract_no_content" };
      const now = options.now();
      const publication = extractPublication(html, now, policy.dayPrecision, policy.timeConflictToleranceMinutes);

      return {
        status: "ok",
        page: {
          requestedUrl: requested.url,
          finalUrl: final.url,
          title: extractTitle(html),
          text: pageText,
          published: publication.time,
          publishedConflict: publication.conflict,
          ref: page.task_id?.slice(0, 128) ?? null,
        },
      };
    },
  };
}
