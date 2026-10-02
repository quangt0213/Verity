import { LIMITS, type BBox, type Coordinates } from "@verity/contracts";

const EARTH_RADIUS_M = 6_371_000;

export function haversineMeters(a: Coordinates, b: Coordinates): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const round = (v: number, digits: number) => Number(v.toFixed(digits));

/**
 * Normalize a map viewport for querying: clamp to valid ranges and round so
 * tiny pans reuse the cached result. Returns null when the viewport is too
 * large to query (the UI asks the user to zoom in instead).
 */
export function viewportToBBox(west: number, south: number, east: number, north: number): BBox | null {
  const w = round(clamp(west, -180, 180), 3);
  const e = round(clamp(east, -180, 180), 3);
  const s = round(clamp(south, -85, 85), 3);
  const n = round(clamp(north, -85, 85), 3);
  if (!(w < e && s < n)) return null;
  if (e - w > LIMITS.maxBboxSpanDegrees || n - s > LIMITS.maxBboxSpanDegrees) return null;
  return [w, s, e, n];
}

/**
 * Reduce coordinate precision before anything leaves the device. Four decimal
 * places is roughly 11 m: enough to place a report, too coarse to be a GPS fix.
 */
export function approximateCoordinates(c: Coordinates, digits = 4): Coordinates {
  return { latitude: round(c.latitude, digits), longitude: round(c.longitude, digits) };
}
