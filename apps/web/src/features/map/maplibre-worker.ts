// Entry for MapLibre's web worker. MapLibre 6 derives its worker URL from
// import.meta.url, which no longer points at node_modules after bundling, so
// Vite bundles this entry (with its shared chunk) and MapView passes the
// resulting same-origin URL to setWorkerUrl().
import "maplibre-gl/dist/maplibre-gl-worker.mjs";
