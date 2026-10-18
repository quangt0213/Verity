/**
 * Public defaults. None of these are credentials.
 *
 * Basemap: OpenFreeMap serves OpenStreetMap-derived vector tiles without an API
 * key. The style URLs are configurable so Verity can move to any hosted
 * OSM-compatible provider (MapTiler, Stadia, Protomaps, self-hosted) by setting
 * VITE_MAP_STYLE_URL_LIGHT / VITE_MAP_STYLE_URL_DARK. Verity never prefetches or
 * bulk-downloads tiles; MapLibre requests only what the viewport needs.
 */
export const DEFAULT_MAP_STYLE_LIGHT = "https://tiles.openfreemap.org/styles/positron";
export const DEFAULT_MAP_STYLE_DARK = "https://tiles.openfreemap.org/styles/dark";

/**
 * Camera defaults. Pitch and rotation stay off until a 3D/navigation mode
 * ships; the seam exists so that mode can turn them on in one place.
 */
export interface MapCameraConfig {
  pitch: number;
  bearing: number;
  /** Allow rotate/pitch gestures (drag-rotate, two-finger pitch, keyboard). */
  allowRotateAndPitch: boolean;
  /** Show the extruded buildings layer (only meaningful with pitch). */
  buildings3d: boolean;
}

export const DEFAULT_CAMERA: MapCameraConfig = { pitch: 0, bearing: 0, allowRotateAndPitch: false, buildings3d: false };

/** Default map view (San Francisco) used when no location is known. */
export const DEFAULT_CENTER = { latitude: 37.7749, longitude: -122.4194 } as const;
export const DEFAULT_ZOOM = 12;
