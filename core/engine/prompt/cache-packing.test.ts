import { describe, it, expect } from "vitest";
import { packSystemForCache, joinSystemParts, ROLE_ROUTING_DEFAULTS } from "./cache-packing.js";
import { buildSystemPrompt, buildSystemPromptParts } from "./system.js";

describe("cache-packing (Wave B2)", () => {
  it("joins parts like buildSystemPrompt", () => {
    const parts = buildSystemPromptParts({
      hasTools: true,
      workspace: "/w",
      projectContext: "Use pnpm.",
    })!;
    expect(joinSystemParts(parts)).toBe(buildSystemPrompt({
      hasTools: true,
      workspace: "/w",
      projectContext: "Use pnpm.",
    }));
    expect(parts.stable).toContain("Portable agent loop");
    expect(parts.volatile).toContain("Use pnpm.");
    expect(parts.stable).not.toContain("Use pnpm.");
  });

  it("attaches Anthropic cacheControl on stable system messages", () => {
    const packed = packSystemForCache(
      { stable: "STABLE_POLICY", volatile: "PROJECT_CTX" },
      "anthropic-messages",
    );
    expect(packed.cacheBreakpoints).toBe(true);
    expect(packed.instructions).toBeUndefined();
    expect(packed.systemMessages).toHaveLength(2);
    const stable = packed.systemMessages![0] as {
      role: string;
      content: string;
      providerOptions?: { anthropic?: { cacheControl?: { type: string } } };
    };
    expect(stable.role).toBe("system");
    expect(stable.content).toBe("STABLE_POLICY");
    expect(stable.providerOptions?.anthropic?.cacheControl?.type).toBe("ephemeral");
    expect(packed.systemMessages![1]).toMatchObject({ role: "system", content: "PROJECT_CTX" });
  });

  it("uses instructions string for non-Anthropic protocols", () => {
    const packed = packSystemForCache(
      { stable: "STABLE", volatile: "VOL" },
      "openai-responses",
    );
    expect(packed.cacheBreakpoints).toBe(false);
    expect(packed.instructions).toBe("STABLE\n\nVOL");
    expect(packed.systemMessages).toBeUndefined();
  });

  it("documents cheap/strong role routing", () => {
    expect(ROLE_ROUTING_DEFAULTS).toContain("worker: cheap");
    expect(ROLE_ROUTING_DEFAULTS).toContain("plan + build: strong");
    expect(ROLE_ROUTING_DEFAULTS).toContain("polish: strongest");
  });
});
