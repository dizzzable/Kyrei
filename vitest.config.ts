import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["core/engine/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    pool: "threads",
    testTimeout: 15_000,
    globals: false,
    passWithNoTests: true,
    // Deterministic env for cross-platform tests.
    env: { TZ: "UTC", LANG: "C" },
  },
});
