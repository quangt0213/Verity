import { z } from "zod";

/**
 * Minimal client for Nimble's Search API, per the official docs checked
 * 2026-10-03 (https://docs.nimbleway.com/api-reference/search/search):
 *   POST {base}/v2/search, Authorization: Bearer <key>, JSON body.
 *
 * Used only by the verification worker. It never logs request or response
 * bodies or the key, caps the response size, validates exactly the fields
 * Verity consumes, and maps every failure to a short code. Nothing
 * Nimble-specific leaves the provider folder: the normalizer turns results into
 * NormalizedEvidence.
 */

export const SEARCH_PATH = "/v2/search";
/** Cap on the response body we are willing to read. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Cap on results we request and accept per search. */
export const MAX_RESULTS = 10;

export interface SearchRequest {
  query: string;
  /** "standard" returns ~2K chars of content per result; "lite" only title/URL/description. */
  searchDepth: "standard" | "lite";
  maxResults: number;
  country?: string;
  timeRange?: "hour" | "day" | "week" | "month" | "year";
  startDate?: string;
  includeDomains?: string[];
}

// Fields Verity consumes, validated per result; anything else is ignored.
// Missing or null text fields mean "absent" (the live API returns some nulls).
const text = (max: number) => z.string().max(max).nullish().transform((v) => v ?? "");
const resultSchema = z.object({
  title: text(2000),
  description: text(10_000),
  url: z.string().min(1).max(4096),
  content: text(200_000),
  additional_data: z.record(z.string(), z.unknown()).nullish(),
});

/** Field paths (names only, never values) that made an item invalid, for safe diagnostics. */
export function invalidFieldPaths(item: unknown): string[] {
  const r = resultSchema.safeParse(item);
  return r.success ? [] : [...new Set(r.error.issues.map((i) => `${i.path.join(".") || "(item)"}:${i.code}`))];
}
const responseSchema = z.object({
  request_id: z.string().max(200).optional(),
  total_results: z.number().int().nonnegative().optional(),
  results: z.array(z.unknown()).max(100),
});
export type SearchResultItem = z.infer<typeof resultSchema>;

export type SearchOutcome =
  | { ok: true; requestId: string | null; results: SearchResultItem[]; droppedInvalid: number; invalidFieldPaths: string[] }
  | { ok: false; kind: "transient" | "permanent"; code: string; retryAfterSeconds: number | null };

const transient = (code: string, retryAfterSeconds: number | null = null): SearchOutcome => ({ ok: false, kind: "transient", code, retryAfterSeconds });
const permanent = (code: string): SearchOutcome => ({ ok: false, kind: "permanent", code, retryAfterSeconds: null });

/** Retry-After as seconds or an HTTP date; Nimble's docs also mention a retry_after value in the body. */
export function parseRetryAfter(header: string | null, body: unknown, now = Date.now()): number | null {
  const fromBody = body && typeof body === "object" && "retry_after" in body ? Number((body as { retry_after: unknown }).retry_after) : NaN;
  if (Number.isFinite(fromBody) && fromBody > 0) return Math.min(Math.ceil(fromBody), 3600);
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds), 3600);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.min(Math.max(0, Math.ceil((date - now) / 1000)), 3600) : null;
}

async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function statusOutcome(status: number, retryAfterSeconds: number | null): SearchOutcome {
  if (status === 429) return transient("nimble_rate_limited", retryAfterSeconds);
  if (status === 401 || status === 403) return permanent("nimble_auth");
  if (status === 402) return permanent("nimble_payment_required");
  if (status === 400 || status === 422) return permanent("nimble_bad_request");
  if (status === 408) return transient("nimble_timeout", retryAfterSeconds);
  if (status >= 500) return transient("nimble_5xx", retryAfterSeconds);
  return permanent(`nimble_http_${status}`);
}

export interface NimbleSearchClient {
  search(request: SearchRequest, signal: AbortSignal): Promise<SearchOutcome>;
}

export function createNimbleSearchClient(options: { apiKey: string; baseUrl: string; fetch?: typeof fetch }): NimbleSearchClient {
  const doFetch = options.fetch ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}${SEARCH_PATH}`;

  return {
    async search(request, signal) {
      const body: Record<string, unknown> = {
        query: request.query,
        search_depth: request.searchDepth,
        max_results: Math.min(Math.max(1, request.maxResults), MAX_RESULTS),
        output_format: "plain_text",
        locale: "en",
        country: request.country ?? "US",
      };
      if (request.timeRange) body.time_range = request.timeRange;
      else if (request.startDate) body.start_date = request.startDate;
      if (request.includeDomains?.length) body.include_domains = request.includeDomains.slice(0, 50);

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
        return transient(name === "TimeoutError" || name === "AbortError" ? "nimble_timeout" : "nimble_network");
      }

      let text: string | null;
      try {
        text = await readCapped(response, MAX_RESPONSE_BYTES);
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        return transient(name === "TimeoutError" || name === "AbortError" ? "nimble_timeout" : "nimble_network");
      }
      if (text === null) return transient("nimble_response_too_large");

      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      if (!response.ok) return statusOutcome(response.status, parseRetryAfter(response.headers.get("retry-after"), json));
      if (json === null) return transient("nimble_malformed_json");
      const parsed = responseSchema.safeParse(json);
      if (!parsed.success) return transient("nimble_malformed_response");

      const results: SearchResultItem[] = [];
      let droppedInvalid = 0;
      const invalidPaths = new Set<string>();
      for (const item of parsed.data.results.slice(0, MAX_RESULTS)) {
        const r = resultSchema.safeParse(item);
        if (r.success) results.push(r.data);
        else {
          droppedInvalid += 1;
          for (const path of invalidFieldPaths(item)) invalidPaths.add(path);
        }
      }
      return { ok: true, requestId: parsed.data.request_id ?? null, results, droppedInvalid, invalidFieldPaths: [...invalidPaths].sort() };
    },
  };
}
