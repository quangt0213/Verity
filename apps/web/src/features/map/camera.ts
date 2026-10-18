import type { Map as MapLibreMap } from "maplibre-gl";

/**
 * Programmatic moves ease to nearby targets. Far targets (more than 1.5
 * viewports away at the destination zoom) jump instead: an animation there
 * shows nothing useful, and it requests and cancels tiles along the way. In
 * e2e/perf measurements that made far moves 0.5-1.5 s slower to finish loading
 * and issued up to 40x more tile requests.
 */
export function moveCamera(
  map: Pick<MapLibreMap, "getCanvas" | "project" | "getZoom" | "jumpTo" | "easeTo">,
  center: [number, number],
  zoom: number,
  padding: { top: number; bottom: number; left: number; right: number },
) {
  const canvas = map.getCanvas();
  const size = Math.max(canvas.clientWidth, canvas.clientHeight, 1);
  const p = map.project(center);
  const distance = Math.hypot(p.x - canvas.clientWidth / 2, p.y - canvas.clientHeight / 2) * 2 ** (zoom - map.getZoom());
  if (distance > 1.5 * size) map.jumpTo({ center, zoom, padding });
  else map.easeTo({ center, zoom, padding, duration: 700 });
}
