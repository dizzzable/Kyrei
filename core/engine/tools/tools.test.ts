import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSet } from "ai";
import { buildTools, type ToolMeta } from "./index.js";
import { DEFAULT_ENGINE_CONFIG } from "../types.js";

let ws: string;
let tools: ToolSet;

async function exec(name: string, args: unknown): Promise<string> {
  const t = tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> };
  const out = await t.execute(args, { toolCallId: "t", messages: [] });
  return String(out);
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "kyrei-tools-"));
  await mkdir(join(ws, "src"), { recursive: true });
  await writeFile(join(ws, "src", "a.ts"), "export const foo = 1;\nexport const bar = 2;\n", "utf8");
  await writeFile(join(ws, "src", "b.ts"), "console.log('hello');\n", "utf8");
  tools = buildTools(ws, DEFAULT_ENGINE_CONFIG, new Map<string, ToolMeta>());
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("tools — read-only search", () => {
  it("list_dir lists the root", async () => {
    expect(await exec("list_dir", { path: "." })).toContain("src/");
  });
  it("read_file reads content", async () => {
    expect(await exec("read_file", { path: "src/a.ts" })).toContain("foo");
  });
  it("find_path globs TS files", async () => {
    const out = await exec("find_path", { pattern: "src/**/*.ts" });
    expect(out).toContain("a.ts");
    expect(out).toContain("b.ts");
  });
  it("grep_search finds matches via ripgrep", async () => {
    const out = await exec("grep_search", { query: "foo" });
    expect(out).toContain("a.ts");
  });
});

describe("tools — batch (partial success, read-only only)", () => {
  it("runs read-only tools in parallel", async () => {
    const out = await exec("batch", {
      calls: [
        { tool: "read_file", args: { path: "src/a.ts" } },
        { tool: "find_path", args: { pattern: "src/**/*.ts" } },
      ],
    });
    expect(out).toContain("read_file ✓");
    expect(out).toContain("find_path ✓");
  });
  it("rejects non-read-only tools", async () => {
    const out = await exec("batch", { calls: [{ tool: "write_file", args: { path: "x", content: "y" } }] });
    expect(out).toContain("write_file ✗");
    expect(out).toContain("не read-only");
  });
});
