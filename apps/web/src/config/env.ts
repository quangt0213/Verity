import { DEFAULT_CENTER, DEFAULT_MAP_STYLE_DARK, DEFAULT_MAP_STYLE_LIGHT, DEFAULT_ZOOM } from "./defaults";

/**
 * Public runtime configuration. Every value here is compiled into the bundle
 * and visible to anyone, so none of them may be a credential. The build fails
 * if a VITE_* variable has a secret-like name (see build/plugins.ts).
 */
export type DataSourceConfig =
  | { kind: "mock"; writes: "off" | "simulate" }
  | { kind: "api"; baseUrl: string }
  | { kind: "unconfigured"; reason: string };

export interface AppConfig {
  dataSource: DataSourceConfig;
  map: { styleLight: string; styleDark: string };
  defaultView: { center: { latitude: number; longitude: number }; zoom: number };
}

export interface RawPublicEnv {
  VITE_VERITY_DATA_SOURCE?: string;
  VITE_VERITY_API_URL?: string;
  VITE_MOCK_WRITES?: string;
  VITE_MAP_STYLE_URL_LIGHT?: string;
  VITE_MAP_STYLE_URL_DARK?: string;
  VITE_DEFAULT_CENTER?: string;
  VITE_DEFAULT_ZOOM?: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Validate the Verity service URL: absolute, no credentials, https outside local development. */
export function parseApiBaseUrl(raw: string, allowInsecureLocal: boolean): string | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "VITE_VERITY_API_URL is not a valid absolute URL" };
  }
  if (url.username || url.password) return { error: "VITE_VERITY_API_URL must not contain credentials" };
  if (url.search || url.hash) return { error: "VITE_VERITY_API_URL must not contain a query or fragment" };
  const isLocal = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(allowInsecureLocal && isLocal && url.protocol === "http:")) {
    return { error: "VITE_VERITY_API_URL must use https" };
  }
  return url.toString().replace(/\/+$/, "");
}

function parseStyleUrl(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function parseCenter(raw: string | undefined) {
  if (!raw) return DEFAULT_CENTER;
  const [lat, lng] = raw.split(",").map((s) => Number(s.trim()));
  if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) return DEFAULT_CENTER;
  if (Math.abs(lat) > 85 || Math.abs(lng) > 180) return DEFAULT_CENTER;
  return { latitude: lat, longitude: lng };
}

function parseZoom(raw: string | undefined): number {
  const zoom = Number(raw);
  return Number.isFinite(zoom) && zoom >= 2 && zoom <= 18 ? zoom : DEFAULT_ZOOM;
}

/**
 * Data source selection:
 *  - VITE_VERITY_DATA_SOURCE=mock          → labeled demo data (allowed in any build)
 *  - VITE_VERITY_API_URL set               → the external Verity service
 *  - neither, development server           → demo data for convenience
 *  - neither, production build             → "unconfigured"; never silently shows demo data
 */
export function resolveConfig(env: RawPublicEnv, isDev: boolean): AppConfig {
  let dataSource: DataSourceConfig;
  const explicit = env.VITE_VERITY_DATA_SOURCE?.trim().toLowerCase();
  const mockWrites = env.VITE_MOCK_WRITES?.trim().toLowerCase();
  const writes: "off" | "simulate" =
    mockWrites === "simulate" || (mockWrites === undefined && isDev) ? "simulate" : "off";

  if (explicit === "mock") {
    dataSource = { kind: "mock", writes };
  } else if (env.VITE_VERITY_API_URL?.trim()) {
    const parsed = parseApiBaseUrl(env.VITE_VERITY_API_URL.trim(), isDev);
    dataSource = typeof parsed === "string" ? { kind: "api", baseUrl: parsed } : { kind: "unconfigured", reason: parsed.error };
  } else if (isDev) {
    dataSource = { kind: "mock", writes };
  } else {
    dataSource = { kind: "unconfigured", reason: "No Verity service URL was configured for this build." };
  }

  return {
    dataSource,
    map: {
      styleLight: parseStyleUrl(env.VITE_MAP_STYLE_URL_LIGHT, DEFAULT_MAP_STYLE_LIGHT),
      styleDark: parseStyleUrl(env.VITE_MAP_STYLE_URL_DARK, DEFAULT_MAP_STYLE_DARK),
    },
    defaultView: { center: parseCenter(env.VITE_DEFAULT_CENTER), zoom: parseZoom(env.VITE_DEFAULT_ZOOM) },
  };
}

export const appConfig: AppConfig = resolveConfig(import.meta.env as RawPublicEnv, import.meta.env.DEV);
