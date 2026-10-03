import { defineConfig } from "tsup";

// Production bundle: the shared contract package (TypeScript source in the
// workspace) is compiled in; npm dependencies stay external and are installed
// normally. Migrations ship alongside in ./drizzle.
export default defineConfig({
  // server (API) and worker (verification) are separate processes from one codebase.
  entry: { server: "src/server.ts", worker: "src/worker/main.ts", migrate: "src/scripts/migrate.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: ["@verity/contracts"],
});
