import type { EventCategory } from "@verity/contracts";
import { publisherDomain } from "./url";

/**
 * The reviewed registry of official and first-party sources. PUBLIC by design
 * (it is not a secret): change it by pull request, with review.
 *
 * Membership answers only "WHO is this?". It never answers "is it about this
 * event?":
 *   OFFICIAL ≠ RELEVANT, OFFICIAL ≠ SUPPORTING, OFFICIAL ≠ PRIMARY FOR EVERY EVENT.
 * An official page still needs event, location and time relevance and an
 * actual stance before it affects verification, and it counts as a PRIMARY
 * source only for the categories it is authoritative on (`primaryFor`).
 *
 * Scope: a small Bay Area set for the MVP plus conservative government rules.
 * Last reviewed: 2026-10-03.
 */

export type OfficialKind =
  | "state_transportation"
  | "regional_transportation"
  | "transit"
  | "public_safety"
  | "emergency_management"
  | "municipality"
  | "utility"
  | "state_agency"
  | "federal_agency"
  | "government";

export interface OfficialSource {
  /** Registrable domain or host; subdomains match too (e.g. "cad.chp.ca.gov" for "chp.ca.gov"). */
  domain: string;
  organization: string;
  sourceClass: "OFFICIAL" | "FIRST_PARTY";
  kind: OfficialKind;
  /** Where its information applies. */
  scope: { country: "US"; region?: string; localities?: string[] };
  /** Categories on which it originates information (a primary source). Empty: never primary. */
  primaryFor: EventCategory[];
}

const DISRUPTIONS: EventCategory[] = ["road_closure", "crash", "flooding", "fire", "police_activity", "construction", "parking_traffic"];
const CA = { country: "US", region: "California" } as const;
const BAY_AREA = { ...CA, localities: ["San Francisco", "Oakland", "San Jose", "Berkeley", "Daly City", "San Mateo", "Fremont"] };
const SF = { ...CA, localities: ["San Francisco"] };

export const OFFICIAL_SOURCES: readonly OfficialSource[] = [
  { domain: "dot.ca.gov", organization: "Caltrans", sourceClass: "OFFICIAL", kind: "state_transportation", scope: CA, primaryFor: ["road_closure", "construction", "crash", "parking_traffic"] },
  { domain: "chp.ca.gov", organization: "California Highway Patrol", sourceClass: "OFFICIAL", kind: "public_safety", scope: CA, primaryFor: ["crash", "road_closure", "police_activity", "parking_traffic"] },
  { domain: "511.org", organization: "511 SF Bay", sourceClass: "OFFICIAL", kind: "regional_transportation", scope: BAY_AREA, primaryFor: ["road_closure", "crash", "transit_disruption", "parking_traffic", "construction"] },
  { domain: "caloes.ca.gov", organization: "Cal OES", sourceClass: "OFFICIAL", kind: "emergency_management", scope: CA, primaryFor: ["flooding", "fire"] },
  { domain: "fire.ca.gov", organization: "CAL FIRE", sourceClass: "OFFICIAL", kind: "public_safety", scope: CA, primaryFor: ["fire"] },
  { domain: "weather.gov", organization: "National Weather Service", sourceClass: "OFFICIAL", kind: "federal_agency", scope: { country: "US" }, primaryFor: ["flooding"] },
  { domain: "sf.gov", organization: "City and County of San Francisco", sourceClass: "OFFICIAL", kind: "municipality", scope: SF, primaryFor: DISRUPTIONS },
  { domain: "sfdem.org", organization: "San Francisco Department of Emergency Management", sourceClass: "OFFICIAL", kind: "emergency_management", scope: SF, primaryFor: DISRUPTIONS },
  { domain: "sf-fire.org", organization: "San Francisco Fire Department", sourceClass: "OFFICIAL", kind: "public_safety", scope: SF, primaryFor: ["fire", "crash", "flooding"] },
  { domain: "sanfranciscopolice.org", organization: "San Francisco Police Department", sourceClass: "OFFICIAL", kind: "public_safety", scope: SF, primaryFor: ["police_activity", "crash", "road_closure", "protest"] },
  { domain: "sfmta.com", organization: "SFMTA", sourceClass: "OFFICIAL", kind: "transit", scope: SF, primaryFor: ["transit_disruption", "road_closure", "construction", "parking_traffic"] },
  { domain: "bart.gov", organization: "BART", sourceClass: "OFFICIAL", kind: "transit", scope: BAY_AREA, primaryFor: ["transit_disruption"] },
  { domain: "caltrain.com", organization: "Caltrain", sourceClass: "OFFICIAL", kind: "transit", scope: BAY_AREA, primaryFor: ["transit_disruption"] },
  { domain: "actransit.org", organization: "AC Transit", sourceClass: "OFFICIAL", kind: "transit", scope: BAY_AREA, primaryFor: ["transit_disruption"] },
  { domain: "vta.org", organization: "VTA", sourceClass: "OFFICIAL", kind: "transit", scope: BAY_AREA, primaryFor: ["transit_disruption"] },
  { domain: "oaklandca.gov", organization: "City of Oakland", sourceClass: "OFFICIAL", kind: "municipality", scope: { ...CA, localities: ["Oakland"] }, primaryFor: DISRUPTIONS },
  { domain: "sanjoseca.gov", organization: "City of San José", sourceClass: "OFFICIAL", kind: "municipality", scope: { ...CA, localities: ["San Jose"] }, primaryFor: DISRUPTIONS },
  // A utility is the first-party source for its own outages, and nothing else.
  { domain: "pge.com", organization: "PG&E", sourceClass: "FIRST_PARTY", kind: "utility", scope: CA, primaryFor: ["power_outage"] },
];

/**
 * Government rule: a .gov registrable domain is OFFICIAL (US government use
 * of .gov is restricted). It is never automatically primary for anything:
 * only registry entries say what an organization is authoritative on.
 */
const GOVERNMENT_SUFFIXES = [".gov"];

export interface OfficialMatch {
  organization: string | null;
  sourceClass: "OFFICIAL" | "FIRST_PARTY";
  kind: OfficialKind;
  /** True only when the registry says this organization originates information on this category. */
  primaryForCategory: boolean;
  entry: OfficialSource | null;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
};

export function classifyOfficial(url: string, category: EventCategory, registry: readonly OfficialSource[] = OFFICIAL_SOURCES): OfficialMatch | null {
  const host = hostOf(url);
  if (!host) return null;
  const entry = registry.find((e) => host === e.domain || host.endsWith(`.${e.domain}`)) ?? null;
  if (entry) {
    return { organization: entry.organization, sourceClass: entry.sourceClass, kind: entry.kind, primaryForCategory: entry.primaryFor.includes(category), entry };
  }
  const domain = publisherDomain(url);
  if (domain && GOVERNMENT_SUFFIXES.some((s) => domain.endsWith(s))) {
    return { organization: null, sourceClass: "OFFICIAL", kind: "government", primaryForCategory: false, entry: null };
  }
  return null;
}

/** Registry domains relevant to a place and category, for an official-source search (at most `max`). */
export function officialDomainsFor(
  place: { region: string | null; city: string | null },
  category: EventCategory,
  max = 10,
  registry: readonly OfficialSource[] = OFFICIAL_SOURCES,
): string[] {
  const inScope = (e: OfficialSource) => {
    if (e.scope.region && place.region && e.scope.region.toLowerCase() !== place.region.toLowerCase()) return false;
    if (e.scope.region && !place.region) return false;
    if (e.scope.localities && place.city && !e.scope.localities.some((l) => l.toLowerCase() === place.city!.toLowerCase())) return false;
    if (e.scope.localities && !place.city) return false;
    return true;
  };
  return registry.filter((e) => e.primaryFor.includes(category) && inScope(e)).map((e) => e.domain).slice(0, max);
}
