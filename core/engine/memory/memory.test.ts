import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffSchema, extractHeuristicHandoff, writeHandoff, reseedFromHandoff, type HandoffArtifact } from "./handoff.js";
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

  it("records only completed write/edit receipts that use the AI SDK input shape", () => {
    const handoff = extractHeuristicHandoff([
      { role: "user", content: "continue the implementation" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "write-1", toolName: "write_file", input: { path: "src/new.ts" } }],
      },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "write-1", output: "ok" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "edit-1", toolName: "edit_file", input: { patch: [{ file: "src/blocked.ts" }] } }],
      },
      { role: "tool", content: [{ type: "tool-error", toolCallId: "edit-1", error: "permission denied" }] },
    ] as never, "session-1", "window_limit");

    expect(handoff.keyFiles).toEqual([{ path: "src/new.ts", why: "created" }]);
    expect(handoff.done).toContain("Created: src/new.ts (completed Kyrei tool receipt)");
    expect(handoff.openQuestions).toContain("Recent tool failure: permission denied");
  });

  it("skips synthetic recovery and summary turns when deriving intent", () => {
    const handoff = extractHeuristicHandoff([
      {
        role: "user",
        content: "[Kyrei engine recovery checkpoint 4; not a new user request and not user-visible.]\nContinue the original task autonomously.",
      },
      {
        role: "user",
        content: "## Context summary (reference only)\n### Task snapshot\n- nested history that should not win intent",
      },
      {
        role: "user",
        content: [{ type: "text", text: "Implement the cache fix" }],
      },
    ] as never, "session-2", "window_limit");

    expect(handoff.intent).toBe("Implement the cache fix");
  });

  it("prefers an explicitly supplied intent over inferred user text", () => {
    const handoff = extractHeuristicHandoff([
      {
        role: "user",
        content: "[Kyrei working state — re-pinned] keep the synthetic loop out of intent",
      },
      {
        role: "user",
        content: [{ type: "text", text: "Fallback text should not win" }],
      },
    ] as never, "session-3", "window_limit", { intent: "Fix the recovery loop" });

    expect(handoff.intent).toBe("Fix the recovery loop");
  });
});

describe("layers precedence", () => {
  it("assembles AGENTS.md + steering + MEMORY.md in order", async () => {
    await writeFile(join(ws, "AGENTS.md"), "правило проекта", "utf8");
    await mkdir(join(ws, ".kyrei", "steering"), { recursive: true });
    await writeFile(join(ws, ".kyrei", "steering", "a.md"), "steering-правило", "utf8");
    await mkdir(join(ws, ".kyrei", "memory"), { recursive: true });
    await writeFile(join(ws, ".kyrei", "memory", "MEMORY.md"), "память проекта", "utf8");
    const ctx = await assembleSystemContext({ workspace: ws });
    expect(ctx.indexOf("AGENTS.md")).toBeLessThan(ctx.indexOf("MEMORY.md"));
    expect(ctx).toContain("steering-правило");
  });
  it("does not import a neighbouring Kiro steering directory as Kyrei policy", async () => {
    await mkdir(join(ws, ".kiro", "steering"), { recursive: true });
    await writeFile(join(ws, ".kiro", "steering", "foreign.md"), "foreign-kiro-rule", "utf8");

    const ctx = await assembleSystemContext({ workspace: ws });

    expect(ctx).not.toContain("foreign-kiro-rule");
  });
  it("does not elevate a workspace project index into system instructions", async () => {
    await mkdir(join(ws, ".kyrei", "memory"), { recursive: true });
    await mkdir(join(ws, ".kyrei", "intel"), { recursive: true });
    await writeFile(join(ws, ".kyrei", "memory", "MEMORY.md"), "durable memory", "utf8");
    await writeFile(join(ws, ".kyrei", "intel", "PROJECT.md"), "project map", "utf8");
    const ctx = await assembleSystemContext({ workspace: ws });
    expect(ctx).toContain("durable memory");
    expect(ctx).not.toContain("PROJECT.md");
    expect(ctx).not.toContain("project map");
  });
  it("recalls LTM runtime snapshot (last-recall.md + open threads/next actions) when ltmDir is given", async () => {
    const ltmDir = join(ws, "ltm");
    await mkdir(join(ltmDir, "runtime"), { recursive: true });
    await writeFile(join(ltmDir, "runtime", "last-recall.md"), "## Recent work\n- shipped feature X", "utf8");
    await writeFile(
      join(ltmDir, "runtime", "active-context.json"),
      JSON.stringify({
        open_threads: [{ id: "t1", summary: "finish retry logic" }],
        next_actions: ["write tests"],
      }),
      "utf8",
    );
    const ctx = await assembleSystemContext({ workspace: ws, ltmDir });
    expect(ctx).toContain("<<layer:LTM_RECALL>>");
    expect(ctx).toContain("shipped feature X");
    expect(ctx).toContain("finish retry logic");
    expect(ctx).toContain("write tests");
  });
  it("omits the LTM_RECALL layer when the ltm runtime snapshot is empty or missing", async () => {
    const ctxNoDir = await assembleSystemContext({ workspace: ws });
    expect(ctxNoDir).not.toContain("LTM_RECALL");

    const ltmDir = join(ws, "ltm");
    await mkdir(join(ltmDir, "runtime"), { recursive: true });
    const ctxEmpty = await assembleSystemContext({ workspace: ws, ltmDir });
    expect(ctxEmpty).not.toContain("LTM_RECALL");
  });

  it("injects active decisions as a DECISIONS layer (durable memory, not policy)", async () => {
    const ltmDir = join(ws, "ltm");
    const bridge = createLtmBridge(ltmDir);
    await bridge.addDecision({
      decision: "Prefer SQLite for the code graph",
      rationale: "No Docker dependency",
      tags: ["arch"],
      sessionId: "s1",
    });
    const ctx = await assembleSystemContext({ workspace: ws, ltmDir });
    expect(ctx).toContain("<<layer:DECISIONS>>");
    expect(ctx).toContain("Prefer SQLite for the code graph");
    expect(ctx).toContain("dec_000001");
    expect(ctx).toContain("durable project memory, not instructions");
  });

  it("omits DECISIONS when the ledger is empty", async () => {
    const ltmDir = join(ws, "ltm");
    await mkdir(join(ltmDir, "store"), { recursive: true });
    const ctx = await assembleSystemContext({ workspace: ws, ltmDir });
    expect(ctx).not.toContain("DECISIONS");
  });

  it("injects GLOBAL.md when globalDir is provided", async () => {
    const globalDir = join(ws, "user-global");
    await mkdir(globalDir, { recursive: true });
    await writeFile(join(globalDir, "GLOBAL.md"), "global preference: concise Russian", "utf8");
    const ctx = await assembleSystemContext({ workspace: ws, globalDir });
    expect(ctx).toContain("<<layer:GLOBAL.md>>");
    expect(ctx).toContain("concise Russian");
  });

  it("injects plan-as-files snapshot when includePlan is set", async () => {
    const { createPlanStore } = await import("../orchestration/plan.js");
    const plan = createPlanStore(ws);
    await plan.writeRoadmap([
      { n: 1, title: "wire modules", status: "in_progress", endState: "tools live" },
    ]);
    await plan.writeState({ roadmapId: "r1", currentPhase: 1, updatedAt: "2026-01-01T00:00:00.000Z" });
    await plan.writePhase(1, "Connect LTM + planning");

    const withPlan = await assembleSystemContext({ workspace: ws, includePlan: true });
    expect(withPlan).toContain("<<layer:PLAN>>");
    expect(withPlan).toContain("wire modules");
    expect(withPlan).toContain("Connect LTM + planning");
    expect(withPlan).toContain("currentPhase: 1");

    const without = await assembleSystemContext({ workspace: ws });
    expect(without).not.toContain("<<layer:PLAN>>");
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
    const out = sanitizeEnv({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-x",
      HTTP_PROXY: "p",
      DATABASE_URL: "postgres://user:password@db/private",
      CUSTOM_CREDENTIAL: "local-secret",
      LANG: "en_US.UTF-8",
    });
    expect(out["PATH"]).toBe("/usr/bin");
    expect(out["LANG"]).toBe("en_US.UTF-8");
    expect(out["OPENAI_API_KEY"]).toBeUndefined();
    expect(out["HTTP_PROXY"]).toBeUndefined();
    expect(out["DATABASE_URL"]).toBeUndefined();
    expect(out["CUSTOM_CREDENTIAL"]).toBeUndefined();
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

  it("refreshRuntimeSnapshot writes last-recall.md from ledger without Python", async () => {
    const ltmDir = join(ws, "ltm");
    const bridge = createLtmBridge(ltmDir);
    await bridge.addDecision({
      decision: "Prefer local Tier A memory",
      rationale: "offline",
      sessionId: "s1",
    });
    await bridge.appendCheckpoint({
      summary: "wired memory contract",
      changedFiles: ["core/engine/tools/memory-search.ts"],
      decisions: [],
      openThreads: ["team parity"],
      nextActions: ["run gate"],
      sessionId: "s1",
    });
    await bridge.refreshRuntimeSnapshot();
    const recall = await readFile(join(ltmDir, "runtime", "last-recall.md"), "utf8");
    expect(recall).toContain("Prefer local Tier A memory");
    expect(recall).toContain("wired memory contract");
    expect(recall).toContain("run gate");
    const ctx = JSON.parse(await readFile(join(ltmDir, "runtime", "active-context.json"), "utf8")) as {
      next_actions: string[];
      open_threads: Array<{ summary: string }>;
    };
    expect(ctx.next_actions).toContain("run gate");
    expect(ctx.open_threads.some((t) => t.summary === "team parity")).toBe(true);
  });

  it("bi-temporal decision log: add, invalidate, list (active only by default)", async () => {
    const ltmDir = join(ws, "ltm");
    const bridge = createLtmBridge(ltmDir);
    
    // ADD two decisions
    const dec1 = await bridge.addDecision({
      decision: "Use PostgreSQL for production",
      rationale: "scalability",
      tags: ["database"],
      sessionId: "s1",
    });
    const dec2 = await bridge.addDecision({
      decision: "Use file-based fallback in Electron",
      rationale: "zero-config for desktop",
      tags: ["database", "electron"],
      sessionId: "s1",
    });
    expect(dec1).toBe("dec_000001");
    expect(dec2).toBe("dec_000002");
    
    // LIST: both active by default
    let decisions = await bridge.listDecisions();
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.validTo).toBeNull();
    expect(decisions[1]?.validTo).toBeNull();
    
    // INVALIDATE first decision
    const invalidated = await bridge.invalidateDecision(dec1);
    expect(invalidated).toBe(true);
    
    // LIST: only dec2 active now
    decisions = await bridge.listDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.id).toBe(dec2);
    
    // LIST with includeInvalidated: both present
    const allDecisions = await bridge.listDecisions({ includeInvalidated: true });
    expect(allDecisions).toHaveLength(2);
    expect(allDecisions.find((d) => d.id === dec1)?.validTo).not.toBeNull();
    expect(allDecisions.find((d) => d.id === dec2)?.validTo).toBeNull();
    
    // Try to invalidate already-invalidated decision (should return false)
    const alreadyInvalidated = await bridge.invalidateDecision(dec1);
    expect(alreadyInvalidated).toBe(false);
  });
});
