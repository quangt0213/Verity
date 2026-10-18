import type { BBox, Coordinates, EventSummary } from "@verity/contracts";
import { Map as MapIcon, RefreshCw } from "lucide";
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  type GeoJSONSource,
  type MapLayerMouseEvent,
} from "maplibre-gl";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { debounce } from "../../lib/debounce";
import { viewportToBBox } from "../../lib/geo";
import {
  EVENTS_SOURCE,
  eventLayers,
  eventsSource,
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
import { createClusterImage, createMarkerImage, parseImageId } from "./marker-images";

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

const pixelRatio = () => Math.min(3, Math.max(1, window.devicePixelRatio || 1));

export function MapView({
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
    if (!map.getSource(EVENTS_SOURCE)) map.addSource(EVENTS_SOURCE, eventsSource(eventsToGeoJSON(events)));
    if (!map.getSource(USER_SOURCE)) map.addSource(USER_SOURCE, { type: "geojson", data: userGeoJSON(userLocation) });
    for (const layer of eventLayers(theme, selectedId)) {
      if (!map.getLayer(layer.id)) map.addLayer(layer);
    }
    if (!map.getLayer(LAYER_USER)) map.addLayer(userLocationLayer(theme));
  });
  const flyTo = useEffectEvent((map: MapLibreMap, target: FlyTarget) => {
    map.easeTo({
      center: [target.coordinates.longitude, target.coordinates.latitude],
      zoom: Math.max(map.getZoom(), target.zoom ?? 14),
      padding: { top: 40, bottom: bottomInset + 40, left: 40, right: 40 },
      duration: 700,
    });
  });

  // Create the map once per attempt.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !webgl) return;
    const start = initialStyle();

    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container,
        style: start.styleUrl,
        center: [start.initialView.center.longitude, start.initialView.center.latitude],
        zoom: start.initialView.zoom,
        minZoom: 3,
        maxZoom: 18,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
      });
    } catch {
      // MapLibre throws synchronously only when it can't create a WebGL context.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reporting an external-system failure
      setStatus("failed");
      return;
    }
    mapRef.current = map;
    appliedStyle.current = `${start.styleUrl}|${start.theme}`;
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new AttributionControl({ compact: true, customAttribution: OSM_ATTRIBUTION }), "bottom-right");
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.getCanvas().setAttribute("aria-label", start.ariaLabel);

    // Marker and cluster images are drawn on demand, so the map never depends
    // on the tile provider's sprites or fonts.
    map.setMissingStyleImageResolver((id) => {
      if (map.hasImage(id)) return;
      const parsed = parseImageId(id);
      if (!parsed) return;
      const pr = pixelRatio();
      const image =
        parsed.kind === "marker"
          ? createMarkerImage(parsed.group, parsed.category, parsed.theme, pr)
          : createClusterImage(parsed.urgent, parsed.label, parsed.theme, pr);
      if (image) map.addImage(id, image, { pixelRatio: pr });
    });

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

  // Event data.
  useEffect(() => {
    mapRef.current?.getSource<GeoJSONSource>(EVENTS_SOURCE)?.setData(eventsToGeoJSON(events));
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
    map.setStyle(styleUrl, { diff: false });
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
