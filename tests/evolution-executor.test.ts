import { describe, expect, it } from "vitest";

import { buildPromotionReceipt, classifyExecution, slugifySkillName } from "../core/evolution-executor.js";

const VALID_SKILL_ID = "skill_0123456789abcdef01234567";

const candidate = (target: Record<string, unknown>, proposal: Record<string, unknown> = {}) => ({
  id: "evo_test1234",
  target,
  proposal,
});

describe("classifyExecution", () => {
  it("plans a skill_update for a real skill id carrying content", () => {
    const plan = classifyExecution(candidate({ kind: "skill", id: VALID_SKILL_ID }, { content: "---\nname: x\n---\nbody" }));
    expect(plan).toMatchObject({ action: "skill_update", skillId: VALID_SKILL_ID });
  });

  it("rejects a skill_update with no content as stale", () => {
    const plan = classifyExecution(candidate({ kind: "skill", id: VALID_SKILL_ID }, {}));
    expect(plan.action).toBe("reject_stale");
    expect(plan.reason).toBe("executor_no_content");
  });

  it("rejects a harvested synthetic skill draft (playbook:<tool>, no content) as stale", () => {
    const plan = classifyExecution(candidate({ kind: "skill", id: "playbook:web_search" }, { kind: "trajectory-playbook" }));
    expect(plan.action).toBe("reject_stale");
    expect(plan.reason).toBe("executor_target_stale");
  });

  it("plans a skill_create when a new skill has a usable name + content", () => {
    const plan = classifyExecution(candidate({ kind: "skill", id: "playbook:web_search" }, { name: "web search helper", content: "body" }));
    expect(plan).toMatchObject({ action: "skill_create", name: "web-search-helper", content: "body" });
  });

  it("refuses to overwrite a reserved built-in profile (kyrei-main)", () => {
    const plan = classifyExecution(candidate({ kind: "prompt-profile", id: "kyrei-main" }, { systemPrompt: "evil" }));
    expect(plan.action).toBe("reject_stale");
    expect(plan.reason).toBe("executor_reserved_profile");
  });

  it("plans profile_update for an existing non-reserved profile", () => {
    const plan = classifyExecution(
      candidate({ kind: "prompt-profile", id: "custom-a" }, { systemPrompt: "new prompt" }),
      { existingProfileIds: ["custom-a"] },
    );
    expect(plan).toMatchObject({ action: "profile_update", profileId: "custom-a", systemPrompt: "new prompt" });
  });

  it("plans profile_create for a new non-reserved profile", () => {
    const plan = classifyExecution(
      candidate({ kind: "prompt-profile", id: "custom-b" }, { systemPrompt: "prompt" }),
      { existingProfileIds: ["custom-a"] },
    );
    expect(plan).toMatchObject({ action: "profile_create", profileId: "custom-b" });
  });

  it("marks memory-ranking and reliability-hint unsupported", () => {
    expect(classifyExecution(candidate({ kind: "memory-ranking", id: "recall" }, {})).action).toBe("unsupported");
    expect(classifyExecution(candidate({ kind: "reliability-hint", id: "tool:x" }, {})).action).toBe("unsupported");
  });
});

describe("slugifySkillName", () => {
  it("strips colons and unsafe chars into a valid name", () => {
    expect(slugifySkillName("playbook:web_search")).toBe("playbook-web_search");
    expect(slugifySkillName("  spaces & symbols!! ")).toBe("spaces-symbols");
  });
  it("returns empty for hopeless input", () => {
    expect(slugifySkillName("")).toBe("");
    expect(slugifySkillName("---")).toBe("");
  });
});

describe("buildPromotionReceipt", () => {
  it("produces a compact ≤200-char receipt string", () => {
    const receipt = buildPromotionReceipt({ action: "skill_update", targetRef: VALID_SKILL_ID, execReceiptId: "exec:evo_x:abc" });
    expect(receipt).toContain("promoted:skill_update:");
    expect(receipt.length).toBeLessThanOrEqual(200);
  });
});
