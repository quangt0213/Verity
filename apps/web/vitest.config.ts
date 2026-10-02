import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Tests deliberately omit the Maypop dev-host plugin: no sandbox server, no
// .maypop/local state, no network.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "build/**/*.test.ts", "scripts/**/*.test.mjs"],
    restoreMocks: true,
  },
});
