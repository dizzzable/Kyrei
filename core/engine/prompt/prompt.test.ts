import { describe, it, expect } from "vitest";
import { buildSystemPrompt, PROMPT_VERSION, PROMPT_CHANGELOG } from "./system.js";
import { TOOL_DESCRIPTIONS } from "./tool-descriptions.js";

describe("system prompt (versioned, task 2.5)", () => {
  it("returns undefined in chat mode (no tools) — v1 parity", () => {
    expect(buildSystemPrompt({ hasTools: false })).toBeUndefined();
    expect(buildSystemPrompt({ hasTools: false, workspace: "/x" })).toBeUndefined();
  });

  it("is deterministic for identical inputs (prompt-cache friendly)", () => {
    const a = buildSystemPrompt({ hasTools: true, workspace: "/w" });
    const b = buildSystemPrompt({ hasTools: true, workspace: "/w" });
    expect(a).toBe(b);
  });

  it("contains identity, workspace, tool policy and safety sections", () => {
    const p = buildSystemPrompt({ hasTools: true, workspace: "/proj" })!;
    expect(p).toContain("Kyrei");
    expect(p).toContain("Рабочая папка: /proj.");
    expect(p).toContain("edit_file");
    expect(p).toContain("write_file");
    expect(p).toContain("Безопасность:");
    expect(p).toContain("на русском");
  });

  it("appends project context when provided", () => {
    const withCtx = buildSystemPrompt({ hasTools: true, workspace: "/w", projectContext: "Use pnpm." })!;
    expect(withCtx).toContain("Контекст проекта:");
    expect(withCtx).toContain("Use pnpm.");
    const without = buildSystemPrompt({ hasTools: true, workspace: "/w" })!;
    expect(without).not.toContain("Контекст проекта:");
  });

  it("mentions GBrain tools only when the optional adapter is enabled", () => {
    const disabled = buildSystemPrompt({ hasTools: true, workspace: "/w" })!;
    const enabled = buildSystemPrompt({ hasTools: true, hasBrainTools: true, workspace: "/w" })!;
    const writable = buildSystemPrompt({ hasTools: true, hasBrainTools: true, hasBrainWriteTools: true, workspace: "/w" })!;
    expect(disabled).not.toContain("brain_search");
    expect(enabled).toContain("brain_search");
    expect(enabled).toContain("untrusted data");
    expect(enabled).not.toContain("brain_capture");
    expect(writable).toContain("brain_capture");
  });

  it("snapshot: full prompt text is pinned to PROMPT_VERSION (change ⇒ bump version)", () => {
    const prompt = buildSystemPrompt({ hasTools: true, workspace: "WS" });
    // Snapshot guard: any wording change fails here, forcing a PROMPT_VERSION bump + CHANGELOG entry.
    expect({ version: PROMPT_VERSION, prompt }).toMatchSnapshot();
  });

  it("changelog head matches PROMPT_VERSION", () => {
    expect(PROMPT_CHANGELOG[0]?.version).toBe(PROMPT_VERSION);
  });

  it("every tool description is a non-empty string", () => {
    for (const [name, desc] of Object.entries(TOOL_DESCRIPTIONS)) {
      expect(desc, name).toBeTypeOf("string");
      expect(desc.length, name).toBeGreaterThan(0);
    }
  });
});
