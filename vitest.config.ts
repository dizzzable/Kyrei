import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // core/*.test.js was never matched by the .test.ts-only globs, so two suites
    // sat in the repo having never run once.
    // `.test.tsx` is included so renderer COMPONENTS can be tested at all. The
    // suite previously had no DOM anywhere, which is why several
    // renderer-behaviour tests degraded into asserting on source text with
    // regexes — those break on a rename and pass on dead code.
    include: [
      "core/**/*.test.ts",
      "core/**/*.test.js",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "tests/**/*.test.ts",
    ],
    // node stays the DEFAULT: it is faster, and every engine/gateway test wants
    // real Node APIs. A component test opts into a DOM with an explicit
    // `// @vitest-environment jsdom` docblock — vitest 4 dropped
    // `environmentMatchGlobs`, and the per-file directive is visible where it
    // applies rather than hidden in this config.
    environment: "node",
    pool: "threads",
    testTimeout: 15_000,
    globals: false,
    // A gate that reports success on zero tests is not a gate: if an include
    // glob ever breaks, CI must go red rather than silently pass.
    passWithNoTests: false,
    // Deterministic env for cross-platform tests.
    env: { TZ: "UTC", LANG: "C" },
  },
});
