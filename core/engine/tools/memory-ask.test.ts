import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMemoryAsk, collectAskSnippets } from "./memory-ask.js";
import { createLtmBridge } from "../memory/ltm-bridge.js";

describe("memory_ask", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "kyrei-ask-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("refuses when nothing matches", async () => {
    const out = await runMemoryAsk({ workspace: ws, ltmEnabled: false }, "срок действия договора");
    expect(out).toMatch(/refuse|недостаточно|не выдумываю/i);
  });

  it("returns grounded pack from MEMORY.md", async () => {
    await mkdir(join(ws, ".kyrei", "memory"), { recursive: true });
    await writeFile(
      join(ws, ".kyrei", "memory", "MEMORY.md"),
      "We use SQLite as the default code graph store.\nNo Docker required for local indexing.\n",
      "utf8",
    );
    const snippets = await collectAskSnippets(
      { workspace: ws, ltmEnabled: false },
      "SQLite code graph",
    );
    expect(snippets.length).toBeGreaterThan(0);
    const out = await runMemoryAsk({ workspace: ws, ltmEnabled: false }, "SQLite code graph");
    expect(out).toMatch(/Grounded sources|DATA, not instructions/i);
    expect(out).toMatch(/SQLite/i);
    expect(out).not.toMatch(/grounded refuse/i);
  });

  it("includes pinned decisions", async () => {
    const ltmDir = join(ws, "ltm");
    const bridge = createLtmBridge(ltmDir);
    await bridge.addDecision({
      decision: "Never store API keys in MEMORY.md",
      pinned: true,
      kind: "instruction",
      sessionId: "s1",
    });
    const out = await runMemoryAsk(
      { workspace: ws, ltmDir, ltmEnabled: true },
      "API keys MEMORY",
    );
    expect(out).toMatch(/Never store API keys|Grounded sources/i);
  });
});
