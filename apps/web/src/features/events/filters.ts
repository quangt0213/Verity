import {
  ACTIVE_STATUSES,
  CATEGORY_KIND,
  EVENT_CATEGORIES,
  LIMITS,
  type BBox,
  type EventStatus,
  type ListEventsQuery,
} from "@verity/contracts";

export type KindFilter = "all" | "disruption" | "planned";

export interface EventFilters {
  kind: KindFilter;
  /** Include resolved events and reports sources did not support. */
  showEnded: boolean;
  q: string;
}

export const DEFAULT_FILTERS: EventFilters = { kind: "all", showEnded: false, q: "" };

export function filtersToQuery(filters: EventFilters, bbox: BBox): ListEventsQuery {
  const statuses: EventStatus[] = filters.showEnded ? [...ACTIVE_STATUSES, "RESOLVED", "REJECTED"] : [...ACTIVE_STATUSES];
  const q = filters.q.trim().slice(0, LIMITS.searchQueryMax);
  return {
    bbox,
    statuses,
    ...(filters.kind === "all" ? {} : { categories: EVENT_CATEGORIES.filter((c) => CATEGORY_KIND[c] === filters.kind) }),
    ...(q ? { q } : {}),
  };
}

/** Small box around a point, used for the list when the map itself can't load. */
export function fallbackBBox(center: { latitude: number; longitude: number }): BBox {
  const dLat = 0.12;
  const dLng = 0.16;
  return [
    Number((center.longitude - dLng).toFixed(3)),
    Number((center.latitude - dLat).toFixed(3)),
    Number((center.longitude + dLng).toFixed(3)),
    Number((center.latitude + dLat).toFixed(3)),
  ];
}
