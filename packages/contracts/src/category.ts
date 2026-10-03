import { z } from "zod";

export const EVENT_CATEGORIES = [
  "road_closure",
  "crash",
  "flooding",
  "fire",
  "police_activity",
  "transit_disruption",
  "construction",
  "power_outage",
  "protest",
  "parade",
  "concert",
  "sporting_event",
  "festival",
  "campus_event",
  "parking_traffic",
  "other",
] as const;

export type EventCategory = (typeof EVENT_CATEGORIES)[number];
export const eventCategorySchema = z.enum(EVENT_CATEGORIES);

/**
 * "disruption": unplanned situations whose freshness decays quickly.
 * "planned": scheduled activity with known or expected start/end times.
 */
export type CategoryKind = "disruption" | "planned";

export const CATEGORY_KIND: Record<EventCategory, CategoryKind> = {
  road_closure: "disruption",
  crash: "disruption",
  flooding: "disruption",
  fire: "disruption",
  police_activity: "disruption",
  transit_disruption: "disruption",
  construction: "planned",
  power_outage: "disruption",
  protest: "disruption",
  parade: "planned",
  concert: "planned",
  sporting_event: "planned",
  festival: "planned",
  campus_event: "planned",
  parking_traffic: "disruption",
  other: "disruption",
};
