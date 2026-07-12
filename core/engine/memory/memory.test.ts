import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffSchema, writeHandoff, reseedFromHandoff, type HandoffArtifact } from "./handoff.js";
import { assembleSystemContext } from "./layers.js";
import { assertWritable, writeMemory } from "./writer.js";
import { withFileLock } from "./lock.js";
import { createLtmBridge } from "./ltm-bridge.js";
import { redact, sanitizeEnv } from "../security/secrets.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "kyrei-mem-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("handoff", () => {
  it("writes and reseeds", async () => {
    const a: HandoffArtifact = HandoffSchema.parse({
      id: "handoff-1",
      createdAt: new Date().toISOString(),
      sessionId: "s1",
      trigger: "phase_complete",
      intent: "добавить фичу X",
      nextActions: ["написать тесты"],
      keyFiles: [{ path: "src/x.ts", why: "основной модуль" }],
    });
    const p = await writeHandoff(ws, a);
    expect(await readFile(p, "utf8")).toContain("добавить фичу X");
    const seed = reseedFromHandoff(a);
    expect(seed).toContain("написать тесты");
    expect(seed).toContain("src/x.ts");
  });
});

describe("layers precedence", () => {
  it("assembles AGENTS.md + steering + MEMORY.md in order", async () => {
    await writeFile(join(ws, "AGENTS.md"), "правило проекта", "utf8");
    await mkdir(join(ws, ".kiro", "steering"), { recursive: true });
    await writeFile(join(ws, ".kiro", "steering", "a.md"), "steering-правило", "utf8");
    await mkdir(join(ws, ".kyrei", "memory"), { recursive: true });
    await writeFile(join(ws, ".kyrei", "memory", "MEMORY.md"), "память проекта", "utf8");
    const ctx = await assembleSystemContext({ workspace: ws });
    expect(ctx.indexOf("AGENTS.md")).toBeLessThan(ctx.indexOf("MEMORY.md"));
    expect(ctx).toContain("steering-правило");
  });
});

describe("writer enforced paths", () => {
  it("main may write notes.md but not MEMORY.md", () => {
    const notes = join(ws, ".kyrei", "memory", "notes.md");
    const memory = join(ws, ".kyrei", "memory", "MEMORY.md");
    expect(() => assertWritable("main", notes)).not.toThrow();
    expect(() => assertWritable("main", memory)).toThrow();
    expect(() => assertWritable("writer", memory)).not.toThrow();
  });
  it("writeMemory writes under lock", async () => {
    const notes = join(ws, ".kyrei", "memory", "notes.md");
    await writeMemory("main", notes, "scratch");
    expect(await readFile(notes, "utf8")).toBe("scratch");
  });
});

describe("file lock", () => {
  it("serializes and releases", async () => {
    const target = join(ws, "res.txt");
    await writeFile(target, "", "utf8");
    let order = "";
    await Promise.all([
      withFileLock(target, async () => {
        await new Promise((r) => setTimeout(r, 30));
        order += "A";
      }),
      withFileLock(target, async () => {
        order += "B";
      }),
    ]);
    expect(order.length).toBe(2); // both ran, serialized
  });
});

describe("secrets", () => {
  it("redacts common secret patterns across channels", () => {
    expect(redact("key sk-ABCDEFGHIJKLMNOPQRSTUVWX token")).toContain("[REDACTED]");
    expect(redact("AKIA1234567890ABCDEF")).toBe("[REDACTED]");
  });
  it("sanitizeEnv strips secret-ish vars", () => {
    const out = sanitizeEnv({ PATH: "/usr/bin", OPENAI_API_KEY: "sk-x", HTTP_PROXY: "p" });
    expect(out["PATH"]).toBe("/usr/bin");
    expect(out["OPENAI_API_KEY"]).toBeUndefined();
    expect(out["HTTP_PROXY"]).toBeUndefined();
  });
});

describe("ltm-bridge (single ledger + redaction)", () => {
  it("appends redacted events/checkpoints and recalls", async () => {
    const ltmDir = join(ws, "ltm");
    const bridge = createLtmBridge(ltmDir);
    const evId = await bridge.appendEvent({
      filesChanged: ["src/a.ts"],
      sessionId: "s1",
      source: "kyrei:apply",
      summary: "token sk-ABCDEFGHIJKLMNOPQRSTUVWX used",
    });
    expect(evId).toBe("evt_000001");
    const chkId = await bridge.appendCheckpoint({
      summary: "done phase",
      changedFiles: ["src/a.ts"],
      decisions: [{ decision: "use sqlite", rationale: "fast" }],
      openThreads: [],
      nextActions: ["ship"],
      sessionId: "s1",
    });
    expect(chkId).toBe("chk_000001");
    const events = await readFile(join(ltmDir, "store", "events.jsonl"), "utf8");
    expect(events).toContain("[REDACTED]");
    expect(events).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
  });
});
