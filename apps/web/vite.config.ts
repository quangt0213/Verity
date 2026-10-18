import { maypop } from "@basilica-digital/maypop-sdk/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type PluginOption } from "vite";
import { cspMetaPlugin, publicEnvGuard } from "./build/plugins.ts";
import { DEFAULT_MAP_STYLE_DARK, DEFAULT_MAP_STYLE_LIGHT } from "./src/config/defaults.ts";

export default defineConfig(({ mode }) => {
  // Only VITE_* values are loaded here; they are public by definition.
  const env = loadEnv(mode, process.cwd(), "VITE_");

  const plugins: PluginOption[] = [
    publicEnvGuard(env),
    react(),
    tailwindcss(),
    cspMetaPlugin(
      {
        apiUrl: env.VITE_VERITY_API_URL,
        mapStyleUrls: [
          env.VITE_MAP_STYLE_URL_LIGHT || DEFAULT_MAP_STYLE_LIGHT,
          env.VITE_MAP_STYLE_URL_DARK || DEFAULT_MAP_STYLE_DARK,
        ],
        extraMapOrigins: (env.VITE_MAP_EXTRA_ORIGINS ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      },
      env.VITE_META_CSP !== "off",
    ),
  ];

  // Local Maypop host for `vite dev`: serves the app inside a sandbox host with
  // a local identity, KV and a notification inspector. Set MAYPOP_DEV_HOST=off
  // to run the app standalone instead.
  if (process.env.MAYPOP_DEV_HOST !== "off") plugins.unshift(maypop());

  return {
    // Relative asset URLs so the bundle works from any Maypop app origin/path.
    base: "./",
    envPrefix: "VITE_",
    plugins,
    worker: {
      format: "es",
      rolldownOptions: {
        // The only worker is MapLibre's. Its package.json marks dist/*.mjs as
        // side-effect free, which would tree-shake our entry's bare import of
        // the worker module down to nothing, so keep everything.
        treeshake: false,
      },
    },
    build: {
      target: "es2022",
      sourcemap: false,
      chunkSizeWarningLimit: 1200,
      rolldownOptions: {
        output: {
          // Keep the large map library in its own long-cacheable chunk.
          codeSplitting: {
            groups: [{ name: "maplibre", test: /node_modules[\\/]maplibre-gl/ }],
          },
        },
      },
    },
    server: { port: 5173 },
  };
});
