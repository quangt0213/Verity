import type { EventSummary } from "@verity/contracts";
import type { AddLayerObject, ExpressionSpecification, GeoJSONSourceSpecification } from "maplibre-gl";
import { markerGroup, type MarkerGroup } from "../../lib/display";

export const EVENTS_SOURCE = "verity-events";
export const USER_SOURCE = "verity-user";
export const LAYER_HALO = "verity-selected-halo";
export const LAYER_CLUSTERS = "verity-clusters";
export const LAYER_POINTS = "verity-points";
export const LAYER_USER = "verity-user-location";

export type MapTheme = "light" | "dark";

const SORT_ORDER: Record<MarkerGroup, number> = { inactive: 0, planned: 1, unverified: 2, developing: 3, urgent: 4 };

export interface EventFeatureProperties {
  id: string;
  group: MarkerGroup;
  category: EventSummary["category"];
  urgent: 0 | 1;
  sort: number;
}

export function eventsToGeoJSON(events: EventSummary[]): GeoJSON.FeatureCollection<GeoJSON.Point, EventFeatureProperties> {
  return {
    type: "FeatureCollection",
    features: events.map((e) => {
      const group = markerGroup(e);
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [e.coordinates.longitude, e.coordinates.latitude] },
        properties: { id: e.id, group, category: e.category, urgent: group === "urgent" ? 1 : 0, sort: SORT_ORDER[group] },
      };
    }),
  };
}

export function eventsSource(data: GeoJSON.FeatureCollection): GeoJSONSourceSpecification {
  return {
    type: "geojson",
    data,
    cluster: true,
    clusterRadius: 46,
    clusterMaxZoom: 14,
    // Clusters remember whether they contain a confirmed urgent disruption.
    clusterProperties: { urgent: ["+", ["get", "urgent"]] },
  };
}

/** Marker image ids are generated on demand by the missing-image resolver. */
export const markerImageId = (group: string, category: string, theme: MapTheme) => `vm:${group}:${category}:${theme}`;
export const clusterImageId = (urgent: boolean, label: string, theme: MapTheme) => `vc:${urgent ? 1 : 0}:${label}:${theme}`;

export function eventLayers(theme: MapTheme, selectedId: string | null): AddLayerObject[] {
  const clusterImage: ExpressionSpecification = [
    "concat",
    "vc:",
    ["case", [">", ["get", "urgent"], 0], "1", "0"],
    ":",
    ["case", [">", ["get", "point_count"], 99], "99+", ["to-string", ["get", "point_count"]]],
    `:${theme}`,
  ];
  const pointImage: ExpressionSpecification = ["concat", "vm:", ["get", "group"], ":", ["get", "category"], `:${theme}`];

  return [
    {
      id: LAYER_HALO,
      type: "circle",
      source: EVENTS_SOURCE,
      filter: haloFilter(selectedId),
      paint: {
        "circle-radius": 24,
        "circle-color": theme === "dark" ? "#6d9eff" : "#2563eb",
        "circle-opacity": 0.2,
        "circle-stroke-width": 2,
        "circle-stroke-color": theme === "dark" ? "#6d9eff" : "#2563eb",
      },
    },
    {
      id: LAYER_CLUSTERS,
      type: "symbol",
      source: EVENTS_SOURCE,
      filter: ["has", "point_count"],
      layout: { "icon-image": clusterImage, "icon-allow-overlap": true, "icon-ignore-placement": true },
    },
    {
      id: LAYER_POINTS,
      type: "symbol",
      source: EVENTS_SOURCE,
      filter: ["!", ["has", "point_count"]],
      layout: {
        "icon-image": pointImage,
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "symbol-sort-key": ["get", "sort"],
      },
    },
  ];
}

export function haloFilter(selectedId: string | null): ExpressionSpecification {
  return ["all", ["!", ["has", "point_count"]], ["==", ["get", "id"], selectedId ?? "__none__"]];
}

export function userLocationLayer(theme: MapTheme): AddLayerObject {
  return {
    id: LAYER_USER,
    type: "circle",
    source: USER_SOURCE,
    paint: {
      "circle-radius": 7,
      "circle-color": "#2563eb",
      "circle-stroke-width": 3,
      "circle-stroke-color": theme === "dark" ? "#15171b" : "#ffffff",
    },
  };
}
