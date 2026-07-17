import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildBudgetedSymbolMap, clearSymbolMapCache, symbolMapLastWasCacheHit } from "./repo-symbols.js";

const dirs: string[] = [];

afterEach(async () => {
  clearSymbolMapCache();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("budgeted symbol map", () => {
  it("extracts exported symbols from source files", async () => {
    const dir = join(tmpdir(), `kyrei-sym-${Date.now()}`);
    dirs.push(dir);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "src", "auth.ts"),
      "export function AuthService() {}\nexport const TOKEN_TTL = 60;\nfunction hidden() {}\n",
      "utf8",
    );
    const map = await buildBudgetedSymbolMap(dir, { maxChars: 2_000, maxFiles: 10 });
    expect(map).toContain("src/auth.ts");
    expect(map).toMatch(/AuthService|TOKEN_TTL/);
  });

  it("serves a warm cache within TTL", async () => {
    const dir = join(tmpdir(), `kyrei-sym-cache-${Date.now()}`);
    dirs.push(dir);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "package.json"), "{}\n", "utf8");
    await writeFile(join(dir, "src", "a.ts"), "export function Alpha() {}\n", "utf8");
    await buildBudgetedSymbolMap(dir, { maxChars: 2_000 });
    expect(symbolMapLastWasCacheHit(dir)).toBe(false);
    const second = await buildBudgetedSymbolMap(dir, { maxChars: 2_000 });
    expect(second).toContain("Alpha");
    expect(symbolMapLastWasCacheHit(dir)).toBe(true);
  });
});
