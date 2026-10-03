/// <reference types="vite/client" />

declare module "maplibre-gl/dist/maplibre-gl-worker.mjs";

interface ImportMetaEnv {
  readonly VITE_VERITY_DATA_SOURCE?: string;
  readonly VITE_VERITY_API_URL?: string;
  readonly VITE_MOCK_WRITES?: string;
  readonly VITE_MAP_STYLE_URL_LIGHT?: string;
  readonly VITE_MAP_STYLE_URL_DARK?: string;
  readonly VITE_MAP_EXTRA_ORIGINS?: string;
  readonly VITE_DEFAULT_CENTER?: string;
  readonly VITE_DEFAULT_ZOOM?: string;
  readonly VITE_META_CSP?: string;
}
