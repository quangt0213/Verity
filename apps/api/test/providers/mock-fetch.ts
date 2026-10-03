/** A recording fetch stub: never touches the network. */
export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  signal: AbortSignal | null;
}

export function mockFetch(handler: (call: RecordedCall, index: number) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => (headers[key] = value));
    const call: RecordedCall = {
      url: String(input),
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      signal: init.signal ?? null,
    };
    calls.push(call);
    if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function nimbleResult(over: Record<string, unknown> = {}) {
  return {
    title: "Mission St closed after water main break",
    description: "Lanes of Mission St are closed.",
    url: "https://news.example/story-1",
    content: "SAN FRANCISCO — Northbound lanes of Mission St are closed between 22nd St and 24th St after a water main break. Crews expect repairs into the evening.",
    metadata: { position: 1, entity_type: "OrganicResult", country: "US", locale: "en", driver: null },
    additional_data: { publish_date: "2026-10-03T10:00:00Z" },
    ...over,
  };
}
