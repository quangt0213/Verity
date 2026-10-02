import {
  apiErrorSchema,
  eventDetailSchema,
  evidenceSchema,
  listEventsQuerySchema,
  listEventsResponseSchema,
  type ListEventsQuery,
} from "@verity/contracts";
import { z } from "zod";
import { assertSafeId, VerityApiError, type ReadErrorCode } from "./errors";
import { AUTH_UNAVAILABLE_MESSAGE, type VerityApi, type WriteResult } from "./types";

const evidenceListSchema = z.object({ evidence: z.array(evidenceSchema).max(200) });

export interface HttpApiOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function statusToCode(status: number): ReadErrorCode {
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 422) return "validation_failed";
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  return "internal";
}

/** Bounding boxes are rounded so nearby viewports share cache entries and requests. */
function formatCoord(value: number): string {
  return value.toFixed(4).replace(/\.?0+$/, "");
}

export function buildListEventsSearch(query: ListEventsQuery): URLSearchParams {
  const parsed = listEventsQuerySchema.parse(query);
  const params = new URLSearchParams();
  if (parsed.bbox) params.set("bbox", parsed.bbox.map(formatCoord).join(","));
  if (parsed.categories?.length) params.set("categories", [...parsed.categories].sort().join(","));
  if (parsed.statuses?.length) params.set("statuses", [...parsed.statuses].sort().join(","));
  if (parsed.q) params.set("q", parsed.q);
  return params;
}

/**
 * Client for the external Verity service.
 *
 * Responses are validated against the shared contract before any UI sees them:
 * the service is trusted for data, but a malformed or unexpected payload is
 * treated as an error rather than rendered.
 *
 * Requests omit credentials. Until the service can verify a viewer's identity
 * (Maypop exposes no verifiable assertion; see docs/MAYPOP.md), write methods
 * return "auth_unavailable" without contacting the network.
 */
export function createHttpApi(baseUrl: string, options: HttpApiOptions = {}): VerityApi {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 12_000;

  async function getJson<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "omit",
        mode: "cors",
        cache: "no-store",
        referrerPolicy: "strict-origin-when-cross-origin",
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted) throw new VerityApiError("timeout", "The request timed out");
      throw new VerityApiError("network", "Network request failed");
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      const parsedError = apiErrorSchema.safeParse(body);
      const code = statusToCode(response.status);
      // The service's error message is designed to be user-safe; anything else is discarded.
      const message = parsedError.success ? parsedError.data.error.message : `Request failed (${response.status})`;
      throw new VerityApiError(code, message, response.status);
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new VerityApiError("invalid_response", "The service returned an unexpected response", response.status);
    }
    return parsed.data;
  }

  const notRecorded = async <T>(): Promise<WriteResult<T>> => ({
    ok: false,
    error: { code: "auth_unavailable", message: AUTH_UNAVAILABLE_MESSAGE },
  });

  return {
    mode: "api",
    writePolicy: { enabled: false, reason: "auth_unavailable" },
    sourceLabel: `Verity service at ${new URL(baseUrl).host}`,

    async listEvents(query, signal) {
      const search = buildListEventsSearch(query).toString();
      return getJson(`/api/events${search ? `?${search}` : ""}`, listEventsResponseSchema, signal);
    },

    async getEvent(id, signal) {
      return getJson(`/api/events/${encodeURIComponent(assertSafeId(id))}`, eventDetailSchema, signal);
    },

    async getEvidence(id, signal) {
      const result = await getJson(
        `/api/events/${encodeURIComponent(assertSafeId(id))}/evidence`,
        evidenceListSchema,
        signal,
      );
      return result.evidence;
    },

    reportEvent: () => notRecorded(),
    respond: () => notRecorded(),
  };
}
