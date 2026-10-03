import { normalizeSingleLine, type EventCategory } from "@verity/contracts";
import { PINNED_LOCATION_PLACEHOLDER } from "../domain/labels";

/**
 * Derived search location. An event's coordinates are its canonical location;
 * a reverse geocoder turns them into place names that help Verity SEARCH for
 * evidence. Those names are derived metadata about the event, never data about
 * a person, and they never replace what a reporter wrote.
 *
 * The verification system depends only on the ReverseGeocoder interface, so the
 * provider (public Nominatim for low-volume development, self-hosted
 * Nominatim/Photon, or a commercial service) is a configuration choice.
 * A provider failure means "no derived context", never a verdict.
 */

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/** What a provider returns for a point. Every field is optional: providers differ. */
export interface SearchPlace {
  /** Road or street name at the point ("Mission Street"). */
  street: string | null;
  neighborhood: string | null;
  city: string | null;
  /** State or province ("California"). */
  region: string | null;
  /** ISO 3166-1 alpha-2, uppercase ("US"). */
  countryCode: string | null;
  /** Which provider produced this (for provenance and cache records). */
  provider: string;
  retrievedAt: Date;
}

export interface ReverseGeocoder {
  readonly provider: string;
  /** Resolves to null when the provider has no result; rejects on provider failure. */
  reverse(point: Coordinates, signal?: AbortSignal): Promise<SearchPlace | null>;
}

export type PlaceLookup =
  | { status: "ok"; place: SearchPlace }
  | { status: "no_result"; place: null }
  | { status: "unavailable"; place: null };

/** Cache key precision: 3 decimals ≈ 110 m, enough to share one lookup per block-sized cell. */
export const GEOCODE_KEY_DECIMALS = 3;

/**
 * A provider-independent cache key for a point, rounded so nearby events share
 * one lookup (and so the key itself never pinpoints a reporter's exact pin).
 */
export function geocodeCacheKey(point: Coordinates, decimals = GEOCODE_KEY_DECIMALS): string {
  const round = (n: number) => {
    const fixed = n.toFixed(decimals);
    return fixed === `-${(0).toFixed(decimals)}` ? (0).toFixed(decimals) : fixed;
  };
  return `${round(point.latitude)},${round(point.longitude)}`;
}

/** Look up a place without ever throwing: failures become "unavailable". */
export async function lookupPlace(geocoder: ReverseGeocoder, point: Coordinates, signal?: AbortSignal): Promise<PlaceLookup> {
  try {
    const place = await geocoder.reverse(point, signal);
    return place ? { status: "ok", place } : { status: "no_result", place: null };
  } catch {
    return { status: "unavailable", place: null };
  }
}

export interface GeocodeCache {
  get(key: string): Promise<PlaceLookup | undefined> | PlaceLookup | undefined;
  set(key: string, value: PlaceLookup): Promise<void> | void;
}

/** A bounded in-process cache; the durable, shared cache comes later (it must be provider-agnostic too). */
export function memoryGeocodeCache(maxEntries = 1000): GeocodeCache {
  const entries = new Map<string, PlaceLookup>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => {
      entries.delete(key);
      entries.set(key, value);
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
    },
  };
}

/**
 * Wrap a geocoder with a cache. Results and "no result" are cached; provider
 * failures are not, so a transient outage doesn't stick.
 */
export function cachedGeocoder(geocoder: ReverseGeocoder, cache: GeocodeCache): ReverseGeocoder {
  return {
    provider: geocoder.provider,
    async reverse(point, signal) {
      const key = `${geocoder.provider}:${geocodeCacheKey(point)}`;
      const hit = await cache.get(key);
      if (hit && hit.status !== "unavailable") return hit.place;
      const place = await geocoder.reverse(point, signal);
      await cache.set(key, place ? { status: "ok", place } : { status: "no_result", place: null });
      return place;
    },
  };
}

// ---------------------------------------------------------------------------
// Search context
// ---------------------------------------------------------------------------

export interface SearchContextInput {
  category: EventCategory;
  title: string;
  /** The event's location text (user-entered, or the map-pin placeholder). */
  approximateLocation: string;
  /** Location labels from attached reports, as reporters typed them. */
  reportLocationLabels: string[];
}

export interface SearchContext {
  /** Most specific first: reporters' own words, then the derived street and neighborhood. */
  locationTerms: string[];
  /** Where each term came from, aligned with locationTerms. */
  termSources: Array<"reporter" | "derived">;
  /** The derived street and neighborhood, when known (for location matching). */
  street: string | null;
  neighborhood: string | null;
  city: string | null;
  region: string | null;
  countryCode: string | null;
  /** False when there is nothing location-specific to search for. */
  searchable: boolean;
  /** Provenance of the derived part. */
  derivedFrom: { provider: string; retrievedAt: Date } | null;
}

const MAX_TERMS = 4;
const MAX_TERM_LENGTH = 120;

function isPlaceholder(text: string): boolean {
  return text.trim().toLowerCase() === PINNED_LOCATION_PLACEHOLDER.toLowerCase();
}

function cleanTerm(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = normalizeSingleLine(value).slice(0, MAX_TERM_LENGTH).trim();
  return text.length >= 2 && !isPlaceholder(text) ? text : null;
}

/**
 * Build what the query builder may use to describe WHERE the event is.
 * Reporter-entered text always comes first and is never overwritten; the
 * placeholder "Location pinned on the map" is never search context; derived
 * place names only supplement. Contains no coordinates and no reporter data.
 */
export function buildSearchContext(input: SearchContextInput, place: SearchPlace | null): SearchContext {
  const terms: string[] = [];
  const sources: SearchContext["termSources"] = [];
  const add = (value: string | null | undefined, source: "reporter" | "derived") => {
    const term = cleanTerm(value);
    if (!term || terms.length >= MAX_TERMS) return;
    if (terms.some((t) => t.toLowerCase() === term.toLowerCase())) return;
    terms.push(term);
    sources.push(source);
  };

  add(input.approximateLocation, "reporter");
  for (const label of input.reportLocationLabels) add(label, "reporter");
  add(place?.street, "derived");
  add(place?.neighborhood, "derived");

  const city = cleanTerm(place?.city);
  return {
    locationTerms: terms,
    termSources: sources,
    street: cleanTerm(place?.street),
    neighborhood: cleanTerm(place?.neighborhood),
    city,
    region: cleanTerm(place?.region),
    countryCode: place?.countryCode && /^[A-Z]{2}$/.test(place.countryCode) ? place.countryCode : null,
    searchable: terms.length > 0 || city !== null,
    derivedFrom: place ? { provider: place.provider, retrievedAt: place.retrievedAt } : null,
  };
}
