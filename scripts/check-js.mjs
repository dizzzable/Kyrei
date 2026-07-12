/**
 * Recursively runs `node --check` over JS/MJS files in core/ and electron/ and
 * scripts/. Works around Windows cmd not expanding globs (blueprint verification
 * gate). Skips node_modules, dist and the engine build output.
 */
import { readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const roots = ["core", "electron", "scripts"];
const SKIP = new Set(["node_modules", "dist", ".dist", ".git", ".kiro"]);

async function walk(dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if ([".js", ".mjs", ".cjs"].includes(extname(e.name))) out.push(full);
  }
}

const files = [];
for (const r of roots) await walk(join(root, r), files);

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch (err) {
    failed++;
    console.error(`✗ ${f}\n${err.stderr?.toString() ?? err.message}`);
  }
}

console.log(`[check-js] checked ${files.length} files, ${failed} failed`);
process.exit(failed ? 1 : 0);
