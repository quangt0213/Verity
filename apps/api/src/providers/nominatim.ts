import { z } from "zod";
import { GEOCODE_KEY_DECIMALS, type Coordinates, type ReverseGeocoder, type SearchPlace } from "../verification/geocoding";

/**
 * Reverse geocoding through a Nominatim server, behind the provider-neutral
 * ReverseGeocoder interface (wrap it with the durable geocode cache). OFF by
 * default.
 *
 * Public Nominatim usage policy (https://operations.osmfoundation.org/policies/nominatim/):
 * at most 1 request per second, a valid identifying User-Agent, results must be
 * cached, ODbL attribution, no periodic/systematic queries, and the provider
 * must be switchable without a software update. This adapter enforces the
 * first two (one in-flight request at a time, ≥1.1 s apart, per process) and
 * relies on the durable cache for the third. Data © OpenStreetMap contributors (ODbL).
 *
 * Coordinates are rounded to the same ~110 m cell as the cache key before
 * sending, so the provider never receives a reporter's exact pin.
 */

const MIN_INTERVAL_MS = 1100;
const MAX_BYTES = 256 * 1024;

const reverseSchema = z.object({
  error: z.string().optional(),
  address: z
    .object({
      road: z.string().optional(),
      pedestrian: z.string().optional(),
      neighbourhood: z.string().optional(),
      suburb: z.string().optional(),
      quarter: z.string().optional(),
      city: z.string().optional(),
      town: z.string().optional(),
      village: z.string().optional(),
      hamlet: z.string().optional(),
      state: z.string().optional(),
      country_code: z.string().optional(),
    })
    .optional(),
});

export function createNominatimGeocoder(options: {
  url: string;
  userAgent: string;
  now?: () => Date;
  fetch?: typeof fetch;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}): ReverseGeocoder {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = options.clock ?? (() => Date.now());
  const now = options.now ?? (() => new Date());
  let queue: Promise<unknown> = Promise.resolve();
  let lastRequestAt = Number.NEGATIVE_INFINITY;

  async function request(point: Coordinates, signal?: AbortSignal): Promise<SearchPlace | null> {
    const wait = lastRequestAt + MIN_INTERVAL_MS - clock();
    if (wait > 0) await sleep(wait);
    lastRequestAt = clock();
    const url = new URL("/reverse", options.url);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", point.latitude.toFixed(GEOCODE_KEY_DECIMALS));
    url.searchParams.set("lon", point.longitude.toFixed(GEOCODE_KEY_DECIMALS));
    url.searchParams.set("zoom", "17");
    url.searchParams.set("addressdetails", "1");
    const response = await doFetch(url, {
      headers: { "user-agent": options.userAgent, accept: "application/json", "accept-language": "en" },
      signal,
      redirect: "error",
    });
    // Failures throw: the cache never stores them.
    if (!response.ok) throw new Error(`nominatim_http_${response.status}`);
    const text = await response.text();
    if (text.length > MAX_BYTES) throw new Error("nominatim_response_too_large");
    const parsed = reverseSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error("nominatim_malformed_response");
    if (parsed.data.error || !parsed.data.address) return null;
    const a = parsed.data.address;
    const code = a.country_code?.toUpperCase() ?? null;
    return {
      street: a.road ?? a.pedestrian ?? null,
      neighborhood: a.neighbourhood ?? a.suburb ?? a.quarter ?? null,
      city: a.city ?? a.town ?? a.village ?? a.hamlet ?? null,
      region: a.state ?? null,
      countryCode: code && /^[A-Z]{2}$/.test(code) ? code : null,
      provider: "nominatim",
      retrievedAt: now(),
    };
  }

  return {
    provider: "nominatim",
    reverse(point, signal) {
      // Single flight: one request at a time, in order, spaced by the rate limit.
      const result = queue.then(() => request(point, signal));
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
