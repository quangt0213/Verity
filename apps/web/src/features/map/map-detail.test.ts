import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { EventSummary } from "@verity/contracts";
import type { StyleSpecification } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";
import {
  DETAIL_PREFIX,
  LAYER_BUILDINGS,
  LAYER_BUILDINGS_3D,
  LAYER_GREEN,
  LAYER_LANDMARKS,
  LAYER_POIS,
  POI_KINDS,
  POI_RULES,
  findOpenMapTilesSource,
  withBasemapDetail,
} from "./basemap-detail";
import { moveCamera } from "./camera";
import { eventLayers, eventsSignature, LAYER_HALO, LAYER_OVERLAY_ANCHOR } from "./map-layers";
import { parseImageId } from "./marker-images";

/** A compact OpenMapTiles-schema style shaped like OpenFreeMap Positron. */
function omtStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: "https://tiles.example.com/fonts/{fontstack}/{range}.pbf",
    sources: { openmaptiles: { type: "vector", url: "https://tiles.example.com/planet" } },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "rgb(242,243,240)" } },
      { id: "park", type: "fill", source: "openmaptiles", "source-layer": "park", paint: { "fill-color": "rgb(230,233,229)" } },
      { id: "water", type: "fill", source: "openmaptiles", "source-layer": "water", paint: { "fill-color": "rgb(194,200,202)" } },
      { id: "building", type: "fill", source: "openmaptiles", "source-layer": "building", paint: { "fill-color": "rgb(234,234,229)" } },
      { id: "waterway", type: "line", source: "openmaptiles", "source-layer": "waterway", paint: { "line-color": "#ccc" } },
      { id: "highway_major_casing", type: "line", source: "openmaptiles", "source-layer": "transportation", paint: { "line-color": "#d5d5d5" } },
      { id: "highway_major_inner", type: "line", source: "openmaptiles", "source-layer": "transportation", paint: { "line-color": "#fff" } },
      {
        id: "highway_motorway_inner",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        paint: { "line-color": ["interpolate", ["linear"], ["zoom"], 5.8, "hsla(0,0%,85%,0.53)", 6, "#fff"] },
      },
      { id: "railway", type: "line", source: "openmaptiles", "source-layer": "transportation", paint: { "line-color": "#ddd" } },
      {
        id: "highway-name-major",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "transportation_name",
        layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"] },
        paint: { "text-color": "#666" },
      },
      {
        id: "poi_r1",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "poi",
        layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Italic"] },
      },
      {
        id: "label_city",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "place",
        layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"] },
        paint: { "text-color": "#000" },
      },
    ],
  };
}

const ids = (style: StyleSpecification) => style.layers.map((l) => l.id);
const layer = (style: StyleSpecification, id: string) => style.layers.find((l) => l.id === id) as unknown as Record<string, Record<string, unknown>>;

describe("withBasemapDetail", () => {
  it.each(["light", "dark"] as const)("produces a valid %s style", (theme) => {
    const out = withBasemapDetail(omtStyle(), theme);
    expect(validateStyleMin(out)).toEqual([]);
  });

  it("replaces the provider's building and POI layers instead of drawing them twice", () => {
    const out = withBasemapDetail(omtStyle(), "light");
    expect(ids(out)).not.toContain("building");
    expect(ids(out)).not.toContain("poi_r1");
    expect(ids(out)).toEqual(expect.arrayContaining([LAYER_GREEN, LAYER_BUILDINGS, LAYER_BUILDINGS_3D, LAYER_LANDMARKS, LAYER_POIS]));
  });

  it("puts fills under roads and POIs under road names and place labels", () => {
    const order = ids(withBasemapDetail(omtStyle(), "light"));
    expect(order.indexOf(LAYER_BUILDINGS)).toBeLessThan(order.indexOf("waterway"));
    expect(order.indexOf(LAYER_BUILDINGS)).toBeGreaterThan(order.indexOf("water"));
    expect(order.indexOf(LAYER_POIS)).toBeLessThan(order.indexOf("highway-name-major"));
    expect(order.indexOf(LAYER_POIS)).toBeLessThan(order.indexOf("label_city"));
  });

  it("uses a font the provider's glyph server has", () => {
    const out = withBasemapDetail(omtStyle(), "light");
    expect(layer(out, LAYER_POIS)!.layout!["text-font"]).toEqual(["Noto Sans Regular"]);
  });

  it("keeps 3D buildings hidden unless asked", () => {
    expect(layer(withBasemapDetail(omtStyle(), "light"), LAYER_BUILDINGS_3D)!.layout!.visibility).toBe("none");
    expect(layer(withBasemapDetail(omtStyle(), "light", { buildings3d: true }), LAYER_BUILDINGS_3D)!.layout!.visibility).toBe("visible");
  });

  it("tints major roads in light mode, including zoom-interpolated colors, but not casings or rail", () => {
    const out = withBasemapDetail(omtStyle(), "light");
    expect(layer(out, "highway_major_inner")!.paint!["line-color"]).toEqual(expect.arrayContaining(["match"]));
    const motorway = layer(out, "highway_motorway_inner")!.paint!["line-color"] as unknown[];
    expect(motorway[0]).toBe("interpolate");
    expect((motorway[6] as unknown[])[0]).toBe("match");
    expect(layer(out, "highway_major_casing")!.paint!["line-color"]).toBe("#d5d5d5");
    expect(layer(out, "railway")!.paint!["line-color"]).toBe("#ddd");
  });

  it("brightens the dark theme's background, roads and labels", () => {
    const out = withBasemapDetail(omtStyle(), "dark");
    expect(layer(out, "background")!.paint!["background-color"]).not.toBe("rgb(242,243,240)");
    expect(layer(out, "label_city")!.paint!["text-color"]).not.toBe("#000");
  });

  it("is idempotent and leaves other schemas alone", () => {
    const once = withBasemapDetail(omtStyle(), "light");
    expect(ids(withBasemapDetail(once, "light"))).toEqual(ids(once));
    const other: StyleSpecification = {
      version: 8,
      sources: { s: { type: "vector", url: "https://x.example/tiles" } },
      layers: [{ id: "streets", type: "line", source: "s", "source-layer": "streets" }],
    };
    expect(findOpenMapTilesSource(other)).toBeNull();
    expect(withBasemapDetail(other, "dark")).toBe(other);
  });
});

describe("POI definitions", () => {
  it("map each OpenMapTiles class to exactly one icon kind", () => {
    const classes = Object.values(POI_KINDS).flatMap((k) => k.classes);
    expect(new Set(classes).size).toBe(classes.length);
  });

  it("only show classes that have an icon", () => {
    const known = new Set(Object.values(POI_KINDS).flatMap((k) => k.classes));
    for (const rule of POI_RULES) for (const c of rule.classes) expect(known.has(c)).toBe(true);
  });

  it("parse POI image ids and reject unknown kinds", () => {
    expect(parseImageId("vp:cafe:dark")).toEqual({ kind: "poi", poi: "cafe", theme: "dark" });
    expect(parseImageId("vp:toString:light")).toBeNull();
    expect(parseImageId("vp:cafe:sepia")).toBeNull();
  });

  it("use the shared layer prefix", () => {
    expect([LAYER_GREEN, LAYER_BUILDINGS, LAYER_POIS].every((id) => id.startsWith(DETAIL_PREFIX))).toBe(true);
  });
});

describe("event layers", () => {
  it("keep an overlay anchor directly below the event markers", () => {
    const order = eventLayers("light", null).map((l) => l.id);
    expect(order.indexOf(LAYER_OVERLAY_ANCHOR)).toBe(order.indexOf(LAYER_HALO) - 1);
  });

  it("signature changes only when something drawn changes", () => {
    const base = { id: "a", status: "VERIFIED", category: "crash", coordinates: { latitude: 1, longitude: 2 }, title: "x" } as EventSummary;
    expect(eventsSignature([base])).toBe(eventsSignature([{ ...base, title: "renamed" }]));
    expect(eventsSignature([base])).not.toBe(eventsSignature([{ ...base, status: "RESOLVED" }]));
    expect(eventsSignature([base])).not.toBe(eventsSignature([{ ...base, coordinates: { latitude: 1.001, longitude: 2 } }]));
  });
});

describe("moveCamera", () => {
  function fakeMap(targetPx: { x: number; y: number }, zoom = 12) {
    return {
      getCanvas: () => ({ clientWidth: 1000, clientHeight: 800 }) as HTMLCanvasElement,
      project: () => targetPx,
      getZoom: () => zoom,
      jumpTo: vi.fn(),
      easeTo: vi.fn(),
    };
  }
  const padding = { top: 0, bottom: 0, left: 0, right: 0 };

  it("eases to nearby targets", () => {
    const map = fakeMap({ x: 700, y: 400 });
    moveCamera(map as never, [0, 0], 12, padding);
    expect(map.easeTo).toHaveBeenCalledOnce();
    expect(map.jumpTo).not.toHaveBeenCalled();
  });

  it("jumps to targets more than 1.5 viewports away at the destination zoom", () => {
    // 400 px away at z12 is 1600 px at z14.
    const map = fakeMap({ x: 900, y: 400 });
    moveCamera(map as never, [0, 0], 14, padding);
    expect(map.jumpTo).toHaveBeenCalledOnce();
    expect(map.easeTo).not.toHaveBeenCalled();
  });
});
