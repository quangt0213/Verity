import { Beer, BedDouble, Bus, Camera, Coffee, Cross, Drama, GraduationCap, Landmark, Palette, Pill, ShoppingBag, ShoppingCart, TrainFront, Trees, Trophy, Utensils, type IconNode } from "lucide";
import type { ExpressionSpecification, FilterSpecification, LayerSpecification, Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import { appConfig } from "../../config/env";
import type { MapTheme } from "./map-layers";

/**
 * Verity's detail layer for OpenMapTiles-schema basemaps (OpenFreeMap and most
 * hosted OSM vector tiles): readable parks and building footprints, named
 * places of interest with locally drawn icons, house numbers at street level,
 * and a tuned dark theme. It's applied to the provider's style JSON with
 * MapLibre's transformStyle, so it costs no extra requests: same tiles, same
 * glyphs. Styles without an OpenMapTiles source are returned unchanged.
 *
 * Event markers stay on top and visually dominant: POI icons are small, muted
 * and never use the event status colors.
 */

export const DETAIL_PREFIX = "verity-detail-";
export const LAYER_GREEN = `${DETAIL_PREFIX}green`;
export const LAYER_BUILDINGS = `${DETAIL_PREFIX}buildings`;
/** Hidden fill-extrusion buildings for a future 3D mode (see setBuildings3d). */
export const LAYER_BUILDINGS_3D = `${DETAIL_PREFIX}buildings-3d`;
export const LAYER_LANDMARKS = `${DETAIL_PREFIX}landmarks`;
export const LAYER_POIS = `${DETAIL_PREFIX}pois`;
export const LAYER_HOUSENUMBERS = `${DETAIL_PREFIX}housenumbers`;

// ---------------------------------------------------------------------------
// Places of interest
// ---------------------------------------------------------------------------

type PoiGroup = "food" | "shopping" | "culture" | "outdoors" | "health" | "transit" | "lodging" | "education" | "civic";

const GROUP_COLORS: Record<PoiGroup, { icon: string; text: Record<MapTheme, string> }> = {
  food: { icon: "#c0703a", text: { light: "#94501f", dark: "#f0a46e" } },
  shopping: { icon: "#3d7bb8", text: { light: "#2d5f91", dark: "#8ab9ea" } },
  culture: { icon: "#16857f", text: { light: "#0f6a65", dark: "#6fd0c8" } },
  outdoors: { icon: "#3e8a4a", text: { light: "#2f6e39", dark: "#8fd19b" } },
  health: { icon: "#c24d6a", text: { light: "#a03a55", dark: "#f08aa5" } },
  transit: { icon: "#3866b0", text: { light: "#2b5191", dark: "#93b2ec" } },
  lodging: { icon: "#7d6f63", text: { light: "#5f544a", dark: "#c9bba9" } },
  education: { icon: "#8a6b2f", text: { light: "#6b5223", dark: "#d9bd7f" } },
  civic: { icon: "#68768a", text: { light: "#4d596a", dark: "#aab6c6" } },
};

/** Icon kinds, the OpenMapTiles `poi` classes they cover, and their color group. */
export const POI_KINDS = {
  restaurant: { icon: Utensils, group: "food", classes: ["restaurant", "fast_food", "food_court", "ice_cream", "bakery"] },
  cafe: { icon: Coffee, group: "food", classes: ["cafe"] },
  bar: { icon: Beer, group: "food", classes: ["bar", "beer"] },
  shop: { icon: ShoppingBag, group: "shopping", classes: ["shop", "clothing_store", "gift", "florist", "furniture", "jewelry", "alcohol_shop", "hairdresser"] },
  grocery: { icon: ShoppingCart, group: "shopping", classes: ["grocery", "supermarket"] },
  museum: { icon: Palette, group: "culture", classes: ["museum", "art_gallery"] },
  entertainment: { icon: Drama, group: "culture", classes: ["theatre", "cinema"] },
  attraction: { icon: Camera, group: "culture", classes: ["attraction", "monument", "castle", "zoo", "aquarium", "theme_park", "lighthouse"] },
  stadium: { icon: Trophy, group: "outdoors", classes: ["stadium", "sports_centre", "swimming_pool", "golf"] },
  park: { icon: Trees, group: "outdoors", classes: ["park", "garden", "dog_park", "playground", "picnic_site", "campsite"] },
  hospital: { icon: Cross, group: "health", classes: ["hospital", "doctors", "dentist", "veterinary"] },
  pharmacy: { icon: Pill, group: "health", classes: ["pharmacy"] },
  rail: { icon: TrainFront, group: "transit", classes: ["railway", "aerialway", "ferry_terminal"] },
  bus: { icon: Bus, group: "transit", classes: ["bus"] },
  lodging: { icon: BedDouble, group: "lodging", classes: ["lodging"] },
  school: { icon: GraduationCap, group: "education", classes: ["school", "college"] },
  civic: { icon: Landmark, group: "civic", classes: ["town_hall", "library", "place_of_worship", "post", "police", "fire_station"] },
} satisfies Record<string, { icon: IconNode; group: PoiGroup; classes: string[] }>;

export type PoiKind = keyof typeof POI_KINDS;

export function poiColors(kind: PoiKind) {
  return GROUP_COLORS[POI_KINDS[kind].group];
}

/**
 * When each class appears. OpenMapTiles' `rank` orders POIs within a grid cell
 * and favours bus stops and clinics over restaurants, so visibility is decided
 * here by class and zoom instead, and `priority` (lower wins) settles
 * collisions. Landmarks appear from z13 (the best-ranked first).
 */
interface PoiRule {
  classes: string[];
  subclasses?: string[];
  zoom: number;
  priority: number;
  landmark?: boolean;
}

export const POI_RULES: PoiRule[] = [
  { classes: ["attraction"], subclasses: ["attraction"], zoom: 13, priority: 1, landmark: true },
  { classes: ["museum", "theatre", "stadium", "zoo", "aquarium", "castle", "monument", "theme_park"], zoom: 13, priority: 1, landmark: true },
  { classes: ["railway"], subclasses: ["station", "subway", "halt"], zoom: 13, priority: 1, landmark: true },
  { classes: ["college"], subclasses: ["university"], zoom: 13, priority: 2, landmark: true },
  { classes: ["hospital"], subclasses: ["hospital"], zoom: 13, priority: 2, landmark: true },
  { classes: ["park"], zoom: 13, priority: 2, landmark: true },
  { classes: ["town_hall"], subclasses: ["townhall", "courthouse"], zoom: 14, priority: 3, landmark: true },
  { classes: ["ferry_terminal"], zoom: 13, priority: 2, landmark: true },
  { classes: ["restaurant", "fast_food", "food_court"], zoom: 15, priority: 4 },
  { classes: ["cafe", "bar", "beer", "ice_cream", "bakery"], zoom: 15, priority: 5 },
  { classes: ["cinema", "lodging", "grocery", "supermarket", "sports_centre", "golf"], zoom: 15, priority: 5 },
  { classes: ["bus"], subclasses: ["bus_station"], zoom: 15, priority: 4 },
  { classes: ["art_gallery"], subclasses: ["gallery", "arts_centre"], zoom: 16, priority: 6 },
  { classes: ["shop", "clothing_store", "gift", "florist", "furniture", "jewelry", "alcohol_shop", "pharmacy"], zoom: 16, priority: 7 },
  { classes: ["school", "college", "library", "place_of_worship", "police", "fire_station", "town_hall", "hospital"], zoom: 16, priority: 6 },
  { classes: ["garden", "dog_park", "playground", "picnic_site", "campsite", "swimming_pool"], zoom: 16, priority: 7 },
  { classes: ["post"], subclasses: ["post_office"], zoom: 16, priority: 8 },
  { classes: ["bus", "railway", "aerialway"], zoom: 17, priority: 8 },
  { classes: ["doctors", "dentist", "veterinary", "hairdresser"], zoom: 17, priority: 9 },
];

const ruleMatch = (rule: PoiRule): ExpressionSpecification => {
  const parts: unknown[] = [["match", ["get", "class"], rule.classes, true, false]];
  if (rule.subclasses) parts.push(["match", ["get", "subclass"], rule.subclasses, true, false]);
  return (parts.length === 1 ? parts[0] : ["all", ...parts]) as ExpressionSpecification;
};

const LANDMARK_RULES = POI_RULES.filter((r) => r.landmark);
const isLandmark: ExpressionSpecification = ["any", ...LANDMARK_RULES.map(ruleMatch)];

/** Sort key: rule priority, then OpenMapTiles rank within it. */
const poiSortKey = (rules: PoiRule[]): ExpressionSpecification => {
  const cases: unknown[] = [];
  for (const rule of rules) cases.push(ruleMatch(rule), rule.priority * 1000);
  return ["+", ["case", ...cases, 9000], ["min", ["coalesce", ["get", "rank"], 999], 999]] as unknown as ExpressionSpecification;
};

export const poiImageId = (kind: string, theme: MapTheme) => `vp:${kind}:${theme}`;

const kindMatch = (): ExpressionSpecification => {
  const args: unknown[] = [];
  for (const [kind, def] of Object.entries(POI_KINDS)) args.push(def.classes, kind);
  return ["match", ["get", "class"], ...args, ""] as unknown as ExpressionSpecification;
};

const textColorByKind = (theme: MapTheme): ExpressionSpecification => {
  const args: unknown[] = [];
  for (const def of Object.values(POI_KINDS)) args.push(def.classes, GROUP_COLORS[def.group].text[theme]);
  return ["match", ["get", "class"], ...args, theme === "dark" ? "#aab6c6" : "#4d596a"] as unknown as ExpressionSpecification;
};

const NAME: ExpressionSpecification = ["coalesce", ["get", "name:en"], ["get", "name_en"], ["get", "name"]];

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const PALETTE = {
  light: {
    green: "#d6ebcf",
    building: "#e3e1dc",
    buildingOutline: "#d2cfc8",
    halo: "#ffffff",
    housenumber: "#8a8f96",
  },
  dark: {
    green: "#1d3324",
    building: "#262a30",
    buildingOutline: "#30353d",
    halo: "#111317",
    housenumber: "#7d848e",
  },
} as const;

/** Dark-theme overrides for the base style, by source layer. */
const DARK = {
  background: "#14161a",
  water: "#16202c",
  roads: { major: "#4a4f58", medium: "#3a3e46", minor: "#2b2e34", path: "#24272c" },
  casing: "#0e0f12",
  text: { place: "#cfd4db", transportation_name: "#a6adb6", water_name: "#7f9cc2", aerodrome_label: "#a6adb6" } as Record<string, string>,
};

/** Light-theme road tint so the hierarchy reads at a glance (inner lines only). */
const LIGHT_ROADS = { major: "#f8d98c", medium: "#fcefc4" };

// ---------------------------------------------------------------------------
// Style transform
// ---------------------------------------------------------------------------

export interface DetailOptions {
  /** Add the 3D buildings layer visible (camera pitch must be enabled separately). */
  buildings3d?: boolean;
}

type AnyLayer = LayerSpecification & { "source-layer"?: string; source?: string };

/** The vector source carrying the OpenMapTiles schema, if any. */
export function findOpenMapTilesSource(style: StyleSpecification): string | null {
  for (const layer of style.layers as AnyLayer[]) {
    if (layer.source && (layer["source-layer"] === "transportation" || layer["source-layer"] === "poi")) {
      const source = style.sources[layer.source];
      if (source?.type === "vector") return layer.source;
    }
  }
  return null;
}

function pickFont(style: StyleSpecification): string[] {
  for (const layer of style.layers as AnyLayer[]) {
    if (layer.type !== "symbol") continue;
    const font = layer.layout?.["text-font"];
    if (Array.isArray(font) && font.every((f) => typeof f === "string") && /regular/i.test(String(font[0]))) return font as string[];
  }
  for (const layer of style.layers as AnyLayer[]) {
    const font = layer.type === "symbol" ? layer.layout?.["text-font"] : undefined;
    if (Array.isArray(font) && font.every((f) => typeof f === "string")) return font as string[];
  }
  return ["Noto Sans Regular"];
}

const isColor = (v: unknown): v is string => typeof v === "string";

/** Color roads by OpenMapTiles class, keeping `fallback` for everything else. */
function byRoadClass(fallback: unknown, colors: { major: string; medium: string; minor?: string; path?: string }): unknown {
  const args: unknown[] = [["motorway", "trunk"], colors.major, ["primary", "secondary"], colors.medium];
  if (colors.minor) args.push(["tertiary", "minor", "service", "track"], colors.minor);
  if (colors.path) args.push(["path"], colors.path);
  return ["match", ["get", "class"], ...args, fallback];
}

/**
 * Apply byRoadClass to a paint value: a plain color, or a top-level zoom
 * interpolate/step whose outputs are colors (zoom can't be nested inside match,
 * so the match goes inside each stop). Anything else is left alone.
 */
function tintRoads(value: unknown, colors: Parameters<typeof byRoadClass>[1]): unknown {
  if (value === undefined || isColor(value)) return byRoadClass(value ?? colors.minor ?? "#ffffff", colors);
  if (Array.isArray(value) && (value[0] === "interpolate" || value[0] === "step") && JSON.stringify(value).includes('["zoom"]')) {
    // Outputs: interpolate → indexes 4, 6, …; step → 2, 4, ….
    const isOutput = (i: number) => (value[0] === "interpolate" ? i >= 4 : i >= 2) && i % 2 === 0;
    return value.map((v, i) => (isOutput(i) && isColor(v) ? byRoadClass(v, colors) : v));
  }
  return value;
}

function tuneBaseLayer(layer: AnyLayer, theme: MapTheme): AnyLayer {
  const sl = layer["source-layer"];
  const paint = layer.paint as Record<string, unknown> | undefined;
  const isRoad = layer.type === "line" && sl === "transportation" && !/rail|transit/i.test(layer.id);
  const isCasing = /casing/i.test(layer.id);
  if (theme === "dark") {
    if (layer.type === "background") return { ...layer, paint: { ...paint, "background-color": DARK.background } } as AnyLayer;
    if (layer.type === "fill" && sl === "water") return { ...layer, paint: { ...paint, "fill-color": DARK.water } } as AnyLayer;
    if (layer.type === "line" && sl === "waterway") return { ...layer, paint: { ...paint, "line-color": DARK.water } } as AnyLayer;
    if (isRoad) {
      return { ...layer, paint: { ...paint, "line-color": isCasing ? DARK.casing : byRoadClass(DARK.roads.minor, DARK.roads) } } as AnyLayer;
    }
    if (layer.type === "symbol" && sl && DARK.text[sl] && layer.layout?.["text-field"] !== undefined) {
      return { ...layer, paint: { ...paint, "text-color": DARK.text[sl], "text-halo-color": PALETTE.dark.halo, "text-halo-width": 1.2 } } as AnyLayer;
    }
    return layer;
  }
  if (isRoad && !isCasing && !/tunnel/i.test(layer.id)) {
    return { ...layer, paint: { ...paint, "line-color": tintRoads(paint?.["line-color"], LIGHT_ROADS) } } as AnyLayer;
  }
  return layer;
}

function detailLayers(source: string, theme: MapTheme, font: string[], options: DetailOptions) {
  const p = PALETTE[theme];
  const sprite = (kindExpr: ExpressionSpecification): ExpressionSpecification => ["concat", "vp:", kindExpr, `:${theme}`];
  const symbolPaint = {
    "text-color": textColorByKind(theme),
    "text-halo-color": p.halo,
    "text-halo-width": 1.3,
    "icon-opacity": theme === "dark" ? 0.9 : 1,
  };
  const symbolLayout = (size: [number, number]) => ({
    "icon-image": sprite(kindMatch()),
    "icon-size": 1,
    "text-field": NAME,
    "text-font": font,
    "text-size": ["interpolate", ["linear"], ["zoom"], 14, size[0], 18, size[1]] as ExpressionSpecification,
    "text-variable-anchor": ["left", "right", "top", "bottom"] as Array<"left" | "right" | "top" | "bottom">,
    "text-radial-offset": 0.95,
    "text-justify": "auto" as const,
    "text-max-width": 8,
    "icon-padding": 3,
  });
  const point: FilterSpecification = ["==", ["geometry-type"], "Point"];

  const green: LayerSpecification = {
    id: LAYER_GREEN,
    type: "fill",
    source,
    "source-layer": "landcover",
    filter: ["match", ["get", "class"], ["grass", "wood"], true, false],
    paint: { "fill-color": p.green, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 9, 0.5, 12, 1] },
  };
  const parks: LayerSpecification = {
    id: `${LAYER_GREEN}-parks`,
    type: "fill",
    source,
    "source-layer": "park",
    paint: { "fill-color": p.green, "fill-opacity": 0.75 },
  };
  const landuseGreen: LayerSpecification = {
    id: `${LAYER_GREEN}-landuse`,
    type: "fill",
    source,
    "source-layer": "landuse",
    filter: ["match", ["get", "class"], ["park", "cemetery", "pitch", "stadium", "playground", "garden"], true, false],
    paint: { "fill-color": p.green, "fill-opacity": 0.8 },
  };
  const buildings: LayerSpecification = {
    id: LAYER_BUILDINGS,
    type: "fill",
    source,
    "source-layer": "building",
    minzoom: 13,
    paint: {
      "fill-color": p.building,
      "fill-outline-color": p.buildingOutline,
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0.4, 15, 1],
    },
  };
  const buildings3d: LayerSpecification = {
    id: LAYER_BUILDINGS_3D,
    type: "fill-extrusion",
    source,
    "source-layer": "building",
    minzoom: 15,
    filter: ["!=", ["get", "hide_3d"], true],
    layout: { visibility: options.buildings3d ? "visible" : "none" },
    paint: {
      "fill-extrusion-color": p.building,
      "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
      "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
      "fill-extrusion-opacity": 0.85,
    },
  };
  const landmarks: LayerSpecification = {
    id: LAYER_LANDMARKS,
    type: "symbol",
    source,
    "source-layer": "poi",
    minzoom: 13,
    filter: [
      "all",
      point,
      ["has", "name"],
      ["any", ...LANDMARK_RULES.map((r) => ["all", ruleMatch(r), [">=", ["zoom"], r.zoom]])],
      // Only the best-ranked landmarks per grid cell until street level.
      ["<=", ["get", "rank"], ["step", ["zoom"], 4, 14, 8, 15, 1000]],
    ] as unknown as FilterSpecification,
    layout: { ...symbolLayout([11.5, 13]), "symbol-sort-key": poiSortKey(LANDMARK_RULES) },
    paint: symbolPaint,
  };
  const pois: LayerSpecification = {
    id: LAYER_POIS,
    type: "symbol",
    source,
    "source-layer": "poi",
    minzoom: 15,
    filter: [
      "all",
      point,
      ["has", "name"],
      ["!", isLandmark],
      ["any", ...POI_RULES.filter((r) => !r.landmark).map((r) => ["all", ruleMatch(r), [">=", ["zoom"], r.zoom]])],
      // Thin out dense downtowns until street level; collisions do the rest.
      ["<=", ["coalesce", ["get", "rank"], 0], ["step", ["zoom"], 40, 16, 80, 17, 100000]],
    ] as unknown as FilterSpecification,
    layout: { ...symbolLayout([11, 12.5]), "symbol-sort-key": poiSortKey(POI_RULES.filter((r) => !r.landmark)) },
    paint: symbolPaint,
  };
  const housenumbers: LayerSpecification = {
    id: LAYER_HOUSENUMBERS,
    type: "symbol",
    source,
    "source-layer": "housenumber",
    minzoom: 17.5,
    layout: { "text-field": ["get", "housenumber"], "text-font": font, "text-size": 10, "text-padding": 2 },
    paint: { "text-color": p.housenumber, "text-halo-color": p.halo, "text-halo-width": 1 },
  };
  return { fills: [green, landuseGreen, parks], buildings: [buildings, buildings3d], symbols: [landmarks, pois], housenumbers };
}

/**
 * Apply Verity's detail layer to a fetched basemap style. Pure: returns a new
 * style. Base POI and building layers are replaced so they aren't drawn twice.
 */
export function withBasemapDetail(style: StyleSpecification, theme: MapTheme, options: DetailOptions = {}): StyleSpecification {
  const source = findOpenMapTilesSource(style);
  if (!source) return style;
  const font = pickFont(style);
  const detail = detailLayers(source, theme, font, options);

  const base = (style.layers as AnyLayer[])
    .filter((l) => !l.id.startsWith(DETAIL_PREFIX))
    // Replaced by the detail layer (avoids drawing the same features twice).
    .filter((l) => !(l["source-layer"] === "building" && (l.type === "fill" || l.type === "fill-extrusion")))
    .filter((l) => !(l["source-layer"] === "poi" && l.type === "symbol"))
    .filter((l) => !(l["source-layer"] === "housenumber"))
    .map((l) => tuneBaseLayer(l, theme));

  const layers: AnyLayer[] = [];
  let fillsPlaced = false;
  let symbolsPlaced = false;
  for (const layer of base) {
    const sl = layer["source-layer"];
    // Green areas and buildings go above land/landuse fills, below water labels, roads and everything else.
    if (!fillsPlaced && layer.type !== "background" && layer.type !== "fill" && layer.type !== "raster") {
      layers.push(...detail.fills, ...detail.buildings);
      fillsPlaced = true;
    }
    // POIs go below road names and place labels, so streets and
    // neighbourhoods win label collisions (MapLibre places top layers first).
    if (!symbolsPlaced && layer.type === "symbol" && (sl === "transportation_name" || sl === "place")) {
      layers.push(detail.housenumbers, ...detail.symbols);
      symbolsPlaced = true;
    }
    layers.push(layer);
  }
  if (!fillsPlaced) layers.push(...detail.fills, ...detail.buildings);
  if (!symbolsPlaced) layers.push(detail.housenumbers, ...detail.symbols);
  return { ...style, layers };
}

/**
 * Load a basemap style with the detail layer applied once it's fetched. A full
 * reload (diff: false) is deliberate: switching themes changes most paint
 * properties, and Verity's own sources and layers are re-added on style.load.
 */
export function setBasemap(map: MapLibreMap, styleUrl: string, theme: MapTheme, detail = appConfig.map.detail) {
  const options: DetailOptions = { buildings3d: appConfig.map.camera.buildings3d };
  map.setStyle(styleUrl, { diff: false, transformStyle: detail ? (_previous, next) => withBasemapDetail(next, theme, options) : undefined });
}

/** Future 3D mode: show or hide the extruded buildings layer. */
export function setBuildings3d(map: { getLayer(id: string): unknown; setLayoutProperty(id: string, name: string, value: unknown): unknown }, visible: boolean) {
  if (map.getLayer(LAYER_BUILDINGS_3D)) map.setLayoutProperty(LAYER_BUILDINGS_3D, "visibility", visible ? "visible" : "none");
}
