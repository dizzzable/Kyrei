import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemoryWriteTools } from "./memory-write.js";

async function exec(tools: ReturnType<typeof buildMemoryWriteTools>, name: string, input: unknown): Promise<string> {
  const t = tools[name] as { execute: (input: unknown, opts: unknown) => Promise<string> };
  return t.execute(input, { toolCallId: "t1", messages: [] });
}

describe("memory write tools", () => {
  let ws: string;
  let globalDir: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "kyrei-memwrite-"));
    // writer gate requires …/memory/GLOBAL.md path shape (gateway: userData/memory).
    const globalRoot = await mkdtemp(join(tmpdir(), "kyrei-global-"));
    globalDir = join(globalRoot, "memory");
    await mkdir(globalDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
    await rm(join(globalDir, ".."), { recursive: true, force: true });
  });

  it("writes notes and MEMORY.md and notifies mutation", async () => {
    let mutated = 0;
    const tools = buildMemoryWriteTools({
      workspace: ws,
      globalDir,
      onMemoryMutated: () => {
        mutated += 1;
      },
    });
    expect(tools["memory_write_global"]).toBeDefined();

    await exec(tools, "memory_write_notes", { content: "scratch idea", mode: "replace" });
    expect(await readFile(join(ws, ".kyrei", "memory", "notes.md"), "utf8")).toContain("scratch idea");

    await exec(tools, "memory_write_project", { content: "Use local FTS index", mode: "replace" });
    expect(await readFile(join(ws, ".kyrei", "memory", "MEMORY.md"), "utf8")).toContain("FTS");

    await exec(tools, "memory_write_global", { content: "Prefer Russian replies", mode: "replace" });
    expect(await readFile(join(globalDir, "GLOBAL.md"), "utf8")).toContain("Russian");

    expect(mutated).toBe(3);
  });

  it("appends notes", async () => {
    const tools = buildMemoryWriteTools({ workspace: ws });
    await exec(tools, "memory_write_notes", { content: "a", mode: "replace" });
    await exec(tools, "memory_write_notes", { content: "b", mode: "append" });
    const body = await readFile(join(ws, ".kyrei", "memory", "notes.md"), "utf8");
    expect(body).toContain("a");
    expect(body).toContain("b");
  });

  it("omits global tool without globalDir", () => {
    const tools = buildMemoryWriteTools({ workspace: ws });
    expect(tools["memory_write_global"]).toBeUndefined();
  });
});
