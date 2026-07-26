#!/usr/bin/env node
/**
 * Typecheck ratchet for the untyped JS half of the product.
 *
 * `core/*.js` (~34.6k LOC, including the gateway that owns auth, secret storage
 * and every HTTP route) and `electron/**` had no static checking at all beyond
 * `node --check`, which is a syntax parse. Annotating all of it is a project;
 * this is the increment that stops the pile growing in the meantime.
 *
 * The gate fails when the error count rises above the recorded baseline, and
 * tells you to lower the baseline when it falls. Ratchet down, never up.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "scripts", "js-types-baseline.json");

// Run the local compiler directly rather than through npx + a shell: shell:true
// with arguments is both slower and a documented injection footgun (DEP0190).
const result = spawnSync(
  process.execPath,
  [join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", "tsconfig.core-js.json"],
  { cwd: root, encoding: "utf8" },
);

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const errors = output
  .split("\n")
  .filter((line) => line.includes("error TS"))
  // The esbuild bundle is a generated artifact pulled in by a dynamic import;
  // its errors say nothing about the source we actually maintain.
  .filter((line) => !line.includes(".dist/index.mjs") && !line.includes(".dist\\index.mjs"));

const count = errors.length;
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const limit = Number(baseline.maxErrors);

if (process.argv.includes("--update-baseline")) {
  writeFileSync(baselinePath, `${JSON.stringify({ ...baseline, maxErrors: count }, null, 2)}\n`);
  console.log(`[check-js-types] baseline updated to ${count}`);
  process.exit(0);
}

if (count > limit) {
  const byFile = new Map();
  for (const line of errors) {
    const file = line.split("(")[0];
    byFile.set(file, (byFile.get(file) ?? 0) + 1);
  }
  console.error(`[check-js-types] ${count} errors, baseline is ${limit} — ${count - limit} new.`);
  console.error("Worst files:");
  for (const [file, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.error(`  ${n.toString().padStart(4)}  ${file}`);
  }
  console.error("\nFix the new errors, or run `node scripts/check-js-types.mjs --update-baseline`");
  console.error("if you genuinely intend to raise the ceiling (you almost never do).");
  process.exit(1);
}

if (count < limit) {
  console.log(`[check-js-types] ${count} errors, below the ${limit} baseline — ratchet it down:`);
  console.log("  node scripts/check-js-types.mjs --update-baseline");
  process.exit(1);
}

console.log(`[check-js-types] ${count} errors, at the ${limit} baseline.`);
