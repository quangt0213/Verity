import { and, eq, gt } from "drizzle-orm";
import type { Database } from "../db/client";
import { geocodeCache } from "../db/schema";
import { geocodeCacheKey, type ReverseGeocoder, type SearchPlace } from "../verification/geocoding";
import { DEFAULT_POLICY, geocodeExpiresAt, type VerificationPolicy } from "../verification/policy";

/**
 * A durable, shared reverse-geocode cache (table geocode_cache), keyed by
 * provider and ~110 m cell. Behavior:
 *   unexpired "ok"         → cached place, provider not called
 *   unexpired "no_result"  → null, provider not called
 *   missing or expired     → provider called; result cached (ok: 90 days,
 *                            no_result: 7 days, both from policy.ts)
 *   provider failure       → error propagates; nothing is cached
 * Only derived place names are stored: no user, reporter or event data, and no
 * raw provider response.
 */
export function durableGeocoder(
  provider: ReverseGeocoder,
  db: Database,
  options: { now: () => Date; policy?: VerificationPolicy },
): ReverseGeocoder {
  const policy = options.policy ?? DEFAULT_POLICY;
  return {
    provider: provider.provider,
    async reverse(point, signal) {
      const cellKey = geocodeCacheKey(point);
      const now = options.now();
      const [hit] = await db
        .select()
        .from(geocodeCache)
        .where(and(eq(geocodeCache.provider, provider.provider), eq(geocodeCache.cellKey, cellKey), gt(geocodeCache.expiresAt, now)))
        .limit(1);
      if (hit) {
        if (hit.status === "no_result") return null;
        return {
          street: hit.street,
          neighborhood: hit.neighborhood,
          city: hit.city,
          region: hit.region,
          countryCode: hit.countryCode,
          provider: hit.provider,
          retrievedAt: hit.retrievedAt,
        } satisfies SearchPlace;
      }

      // A failure throws here and is deliberately not cached.
      const place = await provider.reverse(point, signal);
      const clip = (v: string | null) => (v ? v.slice(0, 120) : null);
      const status = place ? "ok" : "no_result";
      const row = {
        provider: provider.provider,
        cellKey,
        status,
        street: clip(place?.street ?? null),
        neighborhood: clip(place?.neighborhood ?? null),
        city: clip(place?.city ?? null),
        region: clip(place?.region ?? null),
        countryCode: place?.countryCode && /^[A-Z]{2}$/.test(place.countryCode) ? place.countryCode : null,
        retrievedAt: now,
        expiresAt: geocodeExpiresAt(status, now, policy),
      };
      await db
        .insert(geocodeCache)
        .values(row)
        .onConflictDoUpdate({ target: [geocodeCache.provider, geocodeCache.cellKey], set: row });
      return place ? { ...place, retrievedAt: now } : null;
    },
  };
}
