import { defineConfig } from "vitest/config";
import path from "path";

// The smoke eval: recorded SSE replayed through the real client stream code.
// No network, no spend. Kept out of the app's coverage ratchet on purpose: it
// measures product behaviour, not line coverage.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../src"),
    },
  },
  test: {
    environment: "node",
    root: path.resolve(__dirname, ".."),
    include: ["evals/**/*.test.ts"],
  },
});
