import type { BBox, Coordinates, EventSummary } from "@verity/contracts";
import { Map as MapIcon, RefreshCw } from "lucide";
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  type GeoJSONSource,
  type MapLayerMouseEvent,
  type MapOptions,
} from "maplibre-gl";
import { memo, useEffect, useEffectEvent, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { appConfig } from "../../config/env";
import { Icon } from "../../components/ui/Icon";
import { debounce } from "../../lib/debounce";
import { viewportToBBox } from "../../lib/geo";
import { setBasemap } from "./basemap-detail";
import { moveCamera } from "./camera";
import {
  EVENTS_SOURCE,
  eventLayers,
  eventsSource,
  eventsSignature,
  eventsToGeoJSON,
  haloFilter,
  LAYER_CLUSTERS,
  LAYER_HALO,
  LAYER_POINTS,
  LAYER_USER,
  USER_SOURCE,
  userLocationLayer,
  type MapTheme,
} from "./map-layers";
import { OSM_ATTRIBUTION, webglSupported } from "./maplibre-setup";
import { resolveVerityImage } from "./marker-images";

export type MapStatus = "loading" | "ready" | "failed";

export interface Viewport {
  bbox: BBox | null;
  zoom: number;
  center: Coordinates;
}

export interface FlyTarget {
  coordinates: Coordinates;
  zoom?: number;
  /** Change to re-trigger a fly to the same place. */
  key: number;
}

interface MapViewProps {
  events: EventSummary[];
  selectedId: string | null;
  onSelectEvent: (id: string | null) => void;
  onViewportChange?: (viewport: Viewport) => void;
  flyTarget?: FlyTarget | null;
  userLocation?: Coordinates | null;
  theme: MapTheme;
  styleUrl: string;
  initialView: { center: Coordinates; zoom: number };
  /** Pixels hidden behind overlays at the bottom (e.g. the mobile sheet). */
  bottomInset?: number;
  ariaLabel?: string;
  onStatusChange?: (status: MapStatus) => void;
}

function userGeoJSON(location: Coordinates | null | undefined): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: location
      ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [location.longitude, location.latitude] } }]
      : [],
  };
}

/** Measurement builds only: settings the e2e/perf harness may override. */
type PerfOverrides = Partial<MapOptions> & { style?: string; detail?: boolean };
const perfOverrides = (): PerfOverrides | undefined =>
  import.meta.env.MODE === "perf" ? (window as { __verityMapOptions?: PerfOverrides }).__verityMapOptions : undefined;

function MapViewImpl({
  events,
  selectedId,
  onSelectEvent,
  onViewportChange,
  flyTarget,
  userLocation,
  theme,
  styleUrl,
  initialView,
  bottomInset = 0,
  ariaLabel = "Map of events",
  onStatusChange,
}: MapViewProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const appliedStyle = useRef<string | null>(null);
  const appliedEvents = useRef<string | null>(null);
  const [webgl] = useState(webglSupported);
  const [status, setStatus] = useState<MapStatus>(webgl ? "loading" : "failed");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  // Effect events read the latest props from long-lived MapLibre handlers
  // without re-creating the map.
  const selectEvent = useEffectEvent((id: string | null) => onSelectEvent(id));
  const reportViewport = useEffectEvent((viewport: Viewport) => onViewportChange?.(viewport));
  const initialStyle = useEffectEvent(() => ({ styleUrl, theme, initialView, ariaLabel }));
  const installLayers = useEffectEvent((map: MapLibreMap) => {
    if (!map.getSource(EVENTS_SOURCE)) {
      map.addSource(EVENTS_SOURCE, eventsSource(eventsToGeoJSON(events)));
      appliedEvents.current = eventsSignature(events);
    }
    if (!map.getSource(USER_SOURCE)) map.addSource(USER_SOURCE, { type: "geojson", data: userGeoJSON(userLocation) });
    for (const layer of eventLayers(theme, selectedId)) {
      if (!map.getLayer(layer.id)) map.addLayer(layer);
    }
    if (!map.getLayer(LAYER_USER)) map.addLayer(userLocationLayer(theme));
  });
  const flyTo = useEffectEvent((map: MapLibreMap, target: FlyTarget) => {
    moveCamera(map, [target.coordinates.longitude, target.coordinates.latitude], Math.max(map.getZoom(), target.zoom ?? 14), {
      top: 40,
      bottom: bottomInset + 40,
      left: 40,
      right: 40,
    });
  });

  // Create the map once per attempt.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !webgl) return;
    const start = initialStyle();
    const { style: perfStyle, detail = appConfig.map.detail, ...perfOptions } = perfOverrides() ?? {};
    const camera = appConfig.map.camera;

    let map: MapLibreMap;
    try {
      // The style is set right after construction so it can be transformed.
      map = new MapLibreMap({
        container,
        center: [start.initialView.center.longitude, start.initialView.center.latitude],
        zoom: start.initialView.zoom,
        pitch: camera.pitch,
        bearing: camera.bearing,
        minZoom: 3,
        maxZoom: 18,
        // Flat 2D until a 3D mode enables it (config/defaults.ts DEFAULT_CAMERA).
        maxPitch: camera.allowRotateAndPitch ? 60 : 0,
        attributionControl: false,
        dragRotate: camera.allowRotateAndPitch,
        pitchWithRotate: camera.allowRotateAndPitch,
        touchPitch: camera.allowRotateAndPitch,
        ...perfOptions,
      });
    } catch {
      // MapLibre throws synchronously only when it can't create a WebGL context.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reporting an external-system failure
      setStatus("failed");
      return;
    }
    mapRef.current = map;
    // Measurement builds (`vite build --mode perf`, e2e/perf) expose the map to
    // the harness. MODE is a build-time constant, so other builds drop this.
    if (import.meta.env.MODE === "perf") Object.assign(window, { __verityMap: map });
    setBasemap(map, perfStyle ?? start.styleUrl, start.theme, detail);
    appliedStyle.current = `${start.styleUrl}|${start.theme}`;
    if (!camera.allowRotateAndPitch) {
      map.touchZoomRotate.disableRotation();
      map.keyboard.disableRotation();
    }
    map.addControl(new AttributionControl({ compact: true, customAttribution: OSM_ATTRIBUTION }), "bottom-right");
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.getCanvas().setAttribute("aria-label", start.ariaLabel);

    // Marker, cluster and place-of-interest images are drawn on demand, so
    // the map never depends on the tile provider's sprites.
    map.setMissingStyleImageResolver((id) => resolveVerityImage(map, id));

    const emitViewport = () => {
      const b = map.getBounds();
      const c = map.getCenter();
      reportViewport({
        bbox: viewportToBBox(b.getWest(), b.getSouth(), b.getEast(), b.getNorth()),
        zoom: map.getZoom(),
        center: { latitude: c.lat, longitude: c.lng },
      });
    };
    const debouncedViewport = debounce(emitViewport, 200);

    let loaded = false;
    const loadTimeout = setTimeout(() => {
      if (!loaded) setStatus("failed");
    }, 15_000);

    map.on("style.load", () => installLayers(map));
    map.on("load", () => {
      loaded = true;
      clearTimeout(loadTimeout);
      setStatus("ready");
      emitViewport();
    });
    map.on("moveend", debouncedViewport);
    // Diagnostic only: how many markers/clusters are on screen (used by e2e checks).
    map.on("idle", () => {
      if (!wrapperRef.current || !map.getLayer(LAYER_POINTS)) return;
      const visible = map.queryRenderedFeatures({ layers: [LAYER_POINTS, LAYER_CLUSTERS] }).length;
      wrapperRef.current.dataset.visibleMarkers = String(visible);
    });
    map.on("error", (event) => {
      // Before the first load, an error almost always means the style or its
      // resources are unreachable: fall back to the list-only experience.
      // After load, individual tile errors just leave gaps; the list still works.
      if (!loaded) {
        console.warn("Map failed to load", event.error?.message);
        clearTimeout(loadTimeout);
        setStatus("failed");
      }
    });

    map.on("click", LAYER_POINTS, (e: MapLayerMouseEvent) => {
      const id = e.features?.[0]?.properties?.id;
      if (typeof id === "string") selectEvent(id);
    });
    map.on("click", LAYER_CLUSTERS, (e: MapLayerMouseEvent) => {
      const feature = e.features?.[0];
      const clusterId = feature?.properties?.cluster_id;
      const source = map.getSource<GeoJSONSource>(EVENTS_SOURCE);
      if (typeof clusterId !== "number" || !source || feature?.geometry.type !== "Point") return;
      const [lng, lat] = feature.geometry.coordinates as [number, number];
      source
        .getClusterExpansionZoom(clusterId)
        .then((zoom) => map.easeTo({ center: [lng, lat], zoom: Math.min(zoom + 0.5, 18) }))
        .catch(() => undefined);
    });
    map.on("click", (e) => {
      const hits = map.queryRenderedFeatures(e.point, { layers: [LAYER_POINTS, LAYER_CLUSTERS] });
      if (hits.length === 0) selectEvent(null);
    });
    for (const layer of [LAYER_POINTS, LAYER_CLUSTERS]) {
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
    }

    return () => {
      clearTimeout(loadTimeout);
      debouncedViewport.cancel();
      map.remove();
      mapRef.current = null;
    };
  }, [attempt, webgl]);

  // Event data. Pans often return the same events as a new array; skipping
  // those avoids re-clustering in the worker and a marker fade-in.
  useEffect(() => {
    const source = mapRef.current?.getSource<GeoJSONSource>(EVENTS_SOURCE);
    if (!source) return;
    const signature = eventsSignature(events);
    if (signature === appliedEvents.current) return;
    appliedEvents.current = signature;
    source.setData(eventsToGeoJSON(events));
  }, [events]);

  // Selection halo.
  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer(LAYER_HALO)) map.setFilter(LAYER_HALO, haloFilter(selectedId));
  }, [selectedId]);

  // User location dot (kept in memory only).
  useEffect(() => {
    mapRef.current?.getSource<GeoJSONSource>(USER_SOURCE)?.setData(userGeoJSON(userLocation));
  }, [userLocation]);

  // Theme / basemap changes: reload the style; style.load reinstalls our
  // layers with theme-specific marker images.
  useEffect(() => {
    const map = mapRef.current;
    const key = `${styleUrl}|${theme}`;
    if (!map || appliedStyle.current === key) return;
    appliedStyle.current = key;
    setBasemap(map, styleUrl, theme);
  }, [styleUrl, theme]);

  // Programmatic camera moves (list selection, "near me").
  useEffect(() => {
    const map = mapRef.current;
    if (map && flyTarget) flyTo(map, flyTarget);
  }, [flyTarget]);

  return (
    <div ref={wrapperRef} className="relative h-full w-full bg-surface-2" data-map-status={status}>
      {/* Sized with h-full/w-full, not absolute positioning: MapLibre's unlayered
          CSS sets .maplibregl-map { position: relative }, which beats Tailwind's layered utilities. */}
      <div ref={containerRef} className="h-full w-full" role="region" aria-label={ariaLabel} />
      {status === "loading" && <div className="skeleton pointer-events-none absolute inset-0 opacity-60" aria-hidden />}
      {status === "failed" && (
        <div role="status" className="absolute inset-0 grid place-items-center bg-surface-2 p-6 text-center">
          <div className="max-w-xs">
            <Icon icon={MapIcon} size={28} className="mx-auto text-muted" />
            <p className="mt-3 font-semibold">Map unavailable</p>
            <p className="mt-1 text-sm text-muted">The map couldn't load here. The event list still works.</p>
            {webgl && (
              <Button
                variant="secondary"
                size="sm"
                className="mt-4"
                onClick={() => {
                  setStatus("loading");
                  setAttempt((a) => a + 1);
                }}
              >
                <Icon icon={RefreshCw} size={16} />
                Try again
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * MapShell re-renders often (clock ticks, sheet drags, list hover). The map
 * only needs to re-render when one of its inputs changes; `initialView` is
 * read once at creation, so a fresh object for it doesn't count.
 */
export const MapView = memo(MapViewImpl, (prev, next) => {
  for (const key of Object.keys({ ...prev, ...next }) as Array<keyof MapViewProps>) {
    if (key !== "initialView" && !Object.is(prev[key], next[key])) return false;
  }
  return true;
});
