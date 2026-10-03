import {
  apiErrorSchema,
  authSessionSchema,
  eventDetailSchema,
  evidenceListResponseSchema,
  followingResponseSchema,
  followStateSchema,
  listEventsQuerySchema,
  listEventsResponseSchema,
  meResponseSchema,
  mySignalsResponseSchema,
  reportEventResultSchema,
  signalResultSchema,
  type ListEventsQuery,
} from "@verity/contracts";
import { z } from "zod";
import { assertSafeId, VerityApiError, type ReadErrorCode } from "./errors";
import { createSessionStore, type SessionStore } from "./session-store";
import { SIGN_IN_PROMPT, signalTypeFor, type VerityApi, type WriteError, type WriteResult } from "./types";

export interface HttpApiOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  sessionStore?: SessionStore;
}

export const UNAVAILABLE_MESSAGE = "Verity is temporarily unavailable.";

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
  if (parsed.limit) params.set("limit", String(parsed.limit));
  if (parsed.cursor) params.set("cursor", parsed.cursor);
  if (parsed.updated_since) params.set("updated_since", parsed.updated_since);
  return params;
}

type Outcome = { ok: true; status: number; body: unknown } | { ok: false; error: WriteError; status: number | null };

/**
 * Client for the external Verity service.
 *
 *  - Every response is validated against the shared contract before any UI
 *    sees it; malformed payloads become errors, never rendered data.
 *  - Credentials are never ambient: requests use `credentials: "omit"` and,
 *    for writes, an explicit `Authorization: Bearer` Verity session token.
 *  - Maypop identity is never sent. The service can't verify it.
 *  - Failures surface as "Verity is temporarily unavailable." There is no
 *    fallback to demo data.
 */
export function createHttpApi(baseUrl: string, options: HttpApiOptions = {}): VerityApi {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 12_000;
  const sessions = options.sessionStore ?? createSessionStore();

  async function send(
    path: string,
    init: { method: "GET" | "POST" | "DELETE"; body?: unknown; auth?: boolean; signal?: AbortSignal },
  ): Promise<Outcome> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const session = init.auth ? sessions.get() : null;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (session) headers.Authorization = `Bearer ${session.token}`;

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        credentials: "omit",
        mode: "cors",
        cache: "no-store",
        referrerPolicy: "strict-origin-when-cross-origin",
        signal,
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      return {
        ok: false,
        status: null,
        error: { code: timeout.aborted ? "unavailable" : "network", message: UNAVAILABLE_MESSAGE },
      };
    }

    let body: unknown = null;
    if (response.status !== 204) {
      try {
        body = await response.json();
      } catch {
        body = null;
      }
    }
    if (response.ok) return { ok: true, status: response.status, body };

    const parsed = apiErrorSchema.safeParse(body);
    if (response.status === 401 && session) sessions.set(null); // expired or revoked
    if (response.status >= 500 || !parsed.success) {
      // Unexpected bodies (stack traces, proxy pages) are discarded, never shown.
      const fallback: WriteError =
        response.status >= 500
          ? { code: "unavailable", message: UNAVAILABLE_MESSAGE }
          : { code: response.status === 429 ? "rate_limited" : "validation_failed", message: `Request failed (${response.status})` };
      return { ok: false, status: response.status, error: fallback };
    }
    // The service's error messages are designed to be shown to users.
    return {
      ok: false,
      status: response.status,
      error: { code: parsed.data.error.code, message: parsed.data.error.message, fields: parsed.data.error.fields },
    };
  }

  async function read<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal, auth = false): Promise<T> {
    const result = await send(path, { method: "GET", signal, auth });
    if (!result.ok) {
      if (result.error.code === "auth_required") throw new VerityApiError("auth_required", result.error.message, 401);
      const code: ReadErrorCode =
        result.status === null ? "network" : result.error.code === "unavailable" ? "unavailable" : statusToCode(result.status);
      throw new VerityApiError(code, result.status && result.status < 500 ? result.error.message : UNAVAILABLE_MESSAGE, result.status);
    }
    const parsed = schema.safeParse(result.body);
    if (!parsed.success) throw new VerityApiError("invalid_response", "The service returned an unexpected response", result.status);
    return parsed.data;
  }

  async function write<T>(path: string, method: "POST" | "DELETE", body: unknown, schema: z.ZodType<T>): Promise<WriteResult<T>> {
    // Don't send a protected write that can't succeed; the UI offers sign-in instead.
    if (!sessions.get()) return { ok: false, error: { code: "auth_required", message: SIGN_IN_PROMPT } };
    const result = await send(path, { method, body, auth: true });
    if (!result.ok) return { ok: false, error: result.error };
    const parsed = schema.safeParse(result.body);
    if (!parsed.success) return { ok: false, error: { code: "unavailable", message: UNAVAILABLE_MESSAGE } };
    return { ok: true, data: parsed.data, simulated: false };
  }

  const eventPath = (id: string) => `/api/v1/events/${encodeURIComponent(assertSafeId(id))}`;

  return {
    mode: "api",
    writePolicy: { enabled: true, simulated: false, requiresSignIn: true },
    sourceLabel: `Verity service at ${new URL(baseUrl).host}`,
    supportsUpdates: false,

    async listEvents(query, signal) {
      const search = buildListEventsSearch(query).toString();
      return read(`/api/v1/events${search ? `?${search}` : ""}`, listEventsResponseSchema, signal);
    },

    async getEvent(id, signal) {
      return read(eventPath(id), eventDetailSchema, signal);
    },

    async getEvidence(id, signal) {
      return (await read(`${eventPath(id)}/evidence`, evidenceListResponseSchema, signal)).evidence;
    },

    async reportEvent(input) {
      return write("/api/v1/reports", "POST", input, reportEventResultSchema);
    },

    async respond(eventId, input) {
      const type = signalTypeFor(input);
      if (!type) return { ok: false, error: { code: "unavailable", message: "Written updates aren't available yet." } };
      const result = await write(`${eventPath(eventId)}/signals`, "POST", { type }, signalResultSchema);
      return result.ok ? { ok: true, simulated: false, data: { accepted: true, changed: result.data.changed } } : result;
    },

    async getMySignals(eventId, signal) {
      if (!sessions.get()) return [];
      try {
        return (await read(`${eventPath(eventId)}/signals/mine`, mySignalsResponseSchema, signal, true)).signals.map((s) => s.type);
      } catch (error) {
        if (error instanceof VerityApiError && error.code === "auth_required") return [];
        throw error;
      }
    },

    async setFollowing(eventId, following) {
      return write(`${eventPath(eventId)}/follow`, following ? "POST" : "DELETE", undefined, followStateSchema);
    },

    async listFollowing(signal) {
      if (!sessions.get()) throw new VerityApiError("auth_required", SIGN_IN_PROMPT, 401);
      return (await read("/api/v1/me/following", followingResponseSchema, signal, true)).events;
    },

    auth: {
      getSession: () => sessions.get(),
      subscribe: (listener) => sessions.subscribe(listener),

      async startEmailSignIn(email) {
        const result = await send("/api/v1/auth/email/start", { method: "POST", body: { email } });
        return result.ok ? { ok: true, simulated: false, data: { sent: true } } : { ok: false, error: result.error };
      },

      async verifyEmailSignIn(email, code) {
        const result = await send("/api/v1/auth/email/verify", { method: "POST", body: { email, code } });
        if (!result.ok) return { ok: false, error: result.error };
        const parsed = authSessionSchema.safeParse(result.body);
        if (!parsed.success) return { ok: false, error: { code: "unavailable", message: UNAVAILABLE_MESSAGE } };
        sessions.set(parsed.data);
        return { ok: true, simulated: false, data: parsed.data };
      },

      async signOut() {
        if (sessions.get()) await send("/api/v1/auth/sign-out", { method: "POST", auth: true }).catch(() => undefined);
        sessions.set(null);
      },

      async me() {
        if (!sessions.get()) return null;
        try {
          return (await read("/api/v1/me", meResponseSchema, undefined, true)).user;
        } catch (error) {
          if (error instanceof VerityApiError && error.code === "auth_required") return null;
          throw error;
        }
      },
    },
  };
}
