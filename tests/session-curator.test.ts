import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  heuristicCurateProposals,
  transcriptFromMessages,
  curateSession,
  listCuratorProposals,
  applyStoredCuratorProposal,
} from "../core/engine/memory/session-curator.js";

describe("session curator", () => {
  let ws: string;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "kyrei-cur-"));
  });

  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("builds transcript and heuristic proposals", () => {
    const transcript = transcriptFromMessages([
      { role: "user", content: "We need dark mode" },
      { role: "assistant", content: "Decided: use CSS variables for theme tokens.\nNext: implement Settings toggle." },
    ], 10_000);
    expect(transcript).toContain("USER:");
    const proposals = heuristicCurateProposals(transcript, "sess-1", "Theme work");
    expect(proposals.some((p) => p.target === "notes")).toBe(true);
    expect(proposals.some((p) => p.target === "ltm_checkpoint")).toBe(true);
  });

  it("apply_safe writes notes and LTM without MEMORY unless apply_all", async () => {
    const messages = [
      { role: "user", content: "Prefer sqlite for local FTS" },
      {
        role: "assistant",
        content: "Decided: hybrid memory uses sqlite FTS projection.\nNext: wire archive curator.\nProject uses local durable memory only.",
      },
    ];
    const safe = await curateSession({
      sessionId: "sess-safe",
      workspace: ws,
      title: "Memory",
      messages,
      config: { useLlm: false, applyMode: "apply_safe", enabled: true },
    });
    expect(safe.ok).toBe(true);
    expect(safe.applied).toContain("notes");
    expect(safe.applied).toContain("ltm_checkpoint");
    expect(safe.applied).not.toContain("memory");
    const notes = await readFile(join(ws, ".kyrei", "memory", "notes.md"), "utf8");
    expect(notes).toMatch(/Session archive|Decided|sqlite/i);

    const all = await curateSession({
      sessionId: "sess-all",
      workspace: ws,
      title: "Memory 2",
      messages,
      config: { useLlm: false, applyMode: "apply_all", enabled: true },
    });
    expect(all.applied).toContain("memory");
    const mem = await readFile(join(ws, ".kyrei", "memory", "MEMORY.md"), "utf8");
    expect(mem.length).toBeGreaterThan(20);
  });

  it("propose mode writes proposal file only", async () => {
    const result = await curateSession({
      sessionId: "sess-prop",
      workspace: ws,
      messages: [
        { role: "user", content: "Hello world project fact" },
        { role: "assistant", content: "Decided: keep heuristics for offline." },
      ],
      config: { useLlm: false, applyMode: "propose", enabled: true },
    });
    expect(result.applied).toEqual([]);
    expect(result.proposalPath).toBeTruthy();
    const raw = await readFile(result.proposalPath!, "utf8");
    expect(raw).toContain("proposals");
  });

  it("lists proposals and applies stored proposal safely", async () => {
    const proposed = await curateSession({
      sessionId: "sess-review",
      workspace: ws,
      title: "Review me",
      messages: [
        { role: "user", content: "Prefer safe curator defaults" },
        { role: "assistant", content: "Decided: apply_safe for notes and LTM.\nNext: review proposals UI." },
      ],
      config: { useLlm: false, applyMode: "propose", enabled: true },
    });
    expect(proposed.proposalPath).toBeTruthy();
    const listed = await listCuratorProposals(ws, { limit: 10 });
    expect(listed.some((p) => p.sessionId === "sess-review")).toBe(true);
    const fileName = listed.find((p) => p.sessionId === "sess-review")!.fileName;
    const applied = await applyStoredCuratorProposal(ws, fileName, "apply_safe");
    expect(applied.ok).toBe(true);
    expect(applied.applied.length).toBeGreaterThan(0);
    expect(applied.applied).not.toContain("memory");
  });
});
