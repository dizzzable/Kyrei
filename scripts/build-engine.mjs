/**
 * Builds the Kyrei v2 engine (core/engine/**.ts) into a single ESM bundle that
 * gateway.js can import: core/engine/.dist/index.mjs.
 *
 * Runtime deps (ai, @ai-sdk/*, zod, better-sqlite3, sqlite-vec, @vscode/ripgrep,
 * fast-glob, gpt-tokenizer) stay EXTERNAL — they're resolved from node_modules
 * at runtime and included in the electron-builder package. This keeps the bundle
 * small and avoids bundling native addons.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const engineDir = join(root, "core", "engine");

const external = [
  "ai",
  "@ai-sdk/*",
  "zod",
  "better-sqlite3",
  "sqlite-vec",
  "@vscode/ripgrep",
  "fast-glob",
  "gpt-tokenizer",
  "gpt-tokenizer/*",
  "electron",
  "node:*",
];

await build({
  entryPoints: [join(engineDir, "index.ts")],
  outfile: join(engineDir, ".dist", "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  external,
  logLevel: "info",
});

console.log("[build-engine] core/engine → core/engine/.dist/index.mjs");
