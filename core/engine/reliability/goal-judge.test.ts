import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";

const generateTextMock = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: generateTextMock,
  };
});

import { createModelGoalJudge } from "./runtime.js";

describe("createModelGoalJudge", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it("keeps a semantic negative verdict fail-closed", async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ satisfied: false, gap: "tests are still failing" }),
    });

    const judge = createModelGoalJudge({} as LanguageModel);
    await expect(judge("tests pass", "assistant: done")).resolves.toEqual({
      satisfied: false,
      gap: "tests are still failing",
    });
  });

  it("marks provider failures unavailable without exposing raw provider text", async () => {
    generateTextMock.mockRejectedValue(new Error("API Key 已过期"));

    const judge = createModelGoalJudge({} as LanguageModel);
    await expect(judge("tests pass", "assistant: done")).resolves.toEqual({
      satisfied: false,
      unavailable: true,
    });
  });

  it("treats malformed judge output as unavailable instead of an unmet goal", async () => {
    generateTextMock.mockResolvedValue({ text: "not-json" });

    const judge = createModelGoalJudge({} as LanguageModel);
    await expect(judge("tests pass", "assistant: done")).resolves.toEqual({
      satisfied: false,
      unavailable: true,
    });
  });
});
