import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@azaadawaaz/media-strip": fileURLToPath(new URL("../../packages/media-strip/src/index.ts", import.meta.url)),
    },
  },
  test: { testTimeout: 180_000, hookTimeout: 300_000 },
});
