import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const pkg = createRequire(import.meta.url)("./package.json") as { version: string };

function commitSha(): string {
  if (process.env.KYREI_COMMIT_SHA?.trim()) return process.env.KYREI_COMMIT_SHA.trim().slice(0, 12);
  try {
    return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export default defineConfig({
  root: ".",
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __COMMIT_SHA__: JSON.stringify(commitSha()),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});
