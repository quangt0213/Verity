import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Each file boots its own in-memory Postgres (PGlite); keep files in parallel, tests within a file serial.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
