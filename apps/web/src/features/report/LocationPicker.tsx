import type { Coordinates } from "@verity/contracts";
import { LocateFixed, MapPin } from "lucide";
import { AttributionControl, Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { useToast } from "../../components/ui/Toast";
import { approximateCoordinates } from "../../lib/geo";
import { locateOnce } from "../../lib/hooks";
import { OSM_ATTRIBUTION, webglSupported } from "../map/maplibre-setup";

interface LocationPickerProps {
  value: Coordinates;
  onChange: (value: Coordinates) => void;
  styleUrl: string;
  error?: string;
}

/**
 * Move the map so the pin sits on the approximate location. Coordinates are
 * rounded to ~11 m before they're stored in the form. A manual-entry fallback
 * keeps this usable without the map (keyboard users, map failures).
 */
export function LocationPicker({ value, onChange, styleUrl, error }: LocationPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const emitChange = useEffectEvent((c: Coordinates) => onChange(c));
  const initialCenter = useEffectEvent(() => value);
  const [webgl] = useState(webglSupported);
  const [failed, setFailed] = useState(!webgl);
  const [manual, setManual] = useState(false);
  const [locating, setLocating] = useState(false);
  const toast = useToast();
  const id = useId();
  const appliedStyle = useRef(styleUrl);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !webgl) return;
    const center = initialCenter();
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container,
        style: appliedStyle.current,
        center: [center.longitude, center.latitude],
        zoom: 15,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
      });
    } catch {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reporting an external-system failure
      setFailed(true);
      return;
    }
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.addControl(new AttributionControl({ compact: true, customAttribution: OSM_ATTRIBUTION }), "bottom-right");
    map.getCanvas().setAttribute("aria-label", "Map for choosing the report location");
    let loaded = false;
    const timeout = setTimeout(() => !loaded && setFailed(true), 15_000);
    map.on("load", () => {
      loaded = true;
      clearTimeout(timeout);
    });
    map.on("error", () => {
      if (!loaded) setFailed(true);
    });
    map.on("moveend", () => {
      const c = map.getCenter();
      emitChange(approximateCoordinates({ latitude: c.lat, longitude: c.lng }));
    });
    return () => {
      clearTimeout(timeout);
      map.remove();
      mapRef.current = null;
    };
  }, [webgl]);

  // Later style changes (theme switches) reload the basemap.
  useEffect(() => {
    if (!mapRef.current || appliedStyle.current === styleUrl) return;
    appliedStyle.current = styleUrl;
    mapRef.current.setStyle(styleUrl, { diff: false });
  }, [styleUrl]);

  const moveTo = (c: Coordinates) => {
    if (!Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return;
    onChange(c);
    if (Math.abs(c.latitude) <= 85 && Math.abs(c.longitude) <= 180) {
      mapRef.current?.jumpTo({ center: [c.longitude, c.latitude] });
    }
  };

  const useMyLocation = async () => {
    setLocating(true);
    const result = await locateOnce();
    setLocating(false);
    if (result.ok) moveTo(result.coordinates);
    else toast.show(result.message, "warning");
  };

  const showManual = manual || failed;

  return (
    <div>
      {!failed && (
        <div className="relative h-56 overflow-hidden rounded-2xl ring-1 ring-line sm:h-64">
          <div ref={containerRef} className="h-full w-full" />
          <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-full text-accent drop-shadow" aria-hidden>
            <Icon icon={MapPin} size={34} strokeWidth={2.25} />
          </div>
        </div>
      )}
      {failed && (
        <p className="rounded-xl bg-surface-2 px-3 py-2 text-sm text-muted">The map couldn't load. Enter the approximate coordinates instead.</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <p className="mr-auto text-xs text-muted">
          Pin at {value.latitude.toFixed(4)}, {value.longitude.toFixed(4)} (approximate)
        </p>
        <Button variant="secondary" size="sm" onClick={useMyLocation} disabled={locating}>
          <Icon icon={LocateFixed} size={15} />
          {locating ? "Locating…" : "Use my location"}
        </Button>
        {!failed && (
          <Button variant="ghost" size="sm" onClick={() => setManual((v) => !v)} aria-expanded={manual}>
            {manual ? "Hide coordinates" : "Enter coordinates"}
          </Button>
        )}
      </div>
      {showManual && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="text-xs font-medium" htmlFor={`${id}-lat`}>
            Latitude
            <input
              id={`${id}-lat`}
              type="number"
              step="0.0001"
              min={-90}
              max={90}
              value={value.latitude}
              onChange={(e) => e.target.value !== "" && moveTo({ ...value, latitude: Number(e.target.value) })}
              className="mt-1 h-11 w-full rounded-xl bg-surface px-3 text-sm ring-1 ring-line focus:ring-2 focus:ring-accent focus:outline-none"
            />
          </label>
          <label className="text-xs font-medium" htmlFor={`${id}-lng`}>
            Longitude
            <input
              id={`${id}-lng`}
              type="number"
              step="0.0001"
              min={-180}
              max={180}
              value={value.longitude}
              onChange={(e) => e.target.value !== "" && moveTo({ ...value, longitude: Number(e.target.value) })}
              className="mt-1 h-11 w-full rounded-xl bg-surface px-3 text-sm ring-1 ring-line focus:ring-2 focus:ring-accent focus:outline-none"
            />
          </label>
        </div>
      )}
      {error && (
        <p className="mt-1 text-xs font-medium text-red-700 dark:text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
