import "maplibre-gl/dist/maplibre-gl.css";
import { setWorkerCount, setWorkerUrl } from "maplibre-gl";
import workerUrl from "./maplibre-worker?worker&url";

// Imported for its side effect by every component that creates a map.
setWorkerUrl(workerUrl);

// Measurement builds only (see e2e/perf): let the harness try other settings.
if (import.meta.env.MODE === "perf") {
  const count = (window as { __verityWorkerCount?: number }).__verityWorkerCount;
  if (count) setWorkerCount(count);
}

export const OSM_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>';

export function webglSupported(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}
