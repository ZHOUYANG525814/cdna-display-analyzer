import { defineConfig } from "vitest/config";

// Vitest uses the same Vite plugins as the dev/build pipeline. The wasm
// plugins are needed because runPipeline pulls in @cdna/core-wasm via
// @cdna/core's transitive deps.
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
