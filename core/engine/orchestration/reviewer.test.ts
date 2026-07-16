import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: generateTextMock,
  };
});

import { createReviewJudge } from "./reviewer.js";

const mockModel = { modelId: "mock-model" } as unknown as LanguageModel;

describe("createReviewJudge (clean-context LLM diff judge)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("approves a clean diff", async () => {
    generateTextMock.mockResolvedValueOnce({
      output: { approved: true, issues: [] },
    });
    const judge = createReviewJudge(mockModel);
    const result = await judge("+ const x = 1;");
    expect(result).toEqual({ approved: true, issues: [], severity: undefined });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const call = generateTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.model).toBe(mockModel);
    // Clean-context contract: only system prompt + diff, never conversation history.
    expect(call.messages).toHaveLength(2);
    const messages = call.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toContain("+ const x = 1;");
  });

  it("blocks a diff with a hardcoded secret", async () => {
    generateTextMock.mockResolvedValueOnce({
      output: {
        approved: false,
        issues: ["Hardcoded API key detected: sk-abc123"],
        severity: "error",
      },
    });
    const judge = createReviewJudge(mockModel);
    const result = await judge('+ const apiKey = "sk-abc123";');
    expect(result.approved).toBe(false);
    expect(result.issues).toContain("Hardcoded API key detected: sk-abc123");
    expect(result.severity).toBe("error");
  });

  it("fails open (approves with warning) when the judge model errors", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("provider unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const judge = createReviewJudge(mockModel);
    const result = await judge("+ some change");
    expect(result.approved).toBe(true);
    expect(result.severity).toBe("warning");
    expect(result.issues[0]).toContain("provider unavailable");
    warn.mockRestore();
  });

  it("fails open when the judge times out", async () => {
    generateTextMock.mockImplementationOnce(() => new Promise(() => {
      /* never resolves within the tiny test timeout */
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const judge = createReviewJudge(mockModel, undefined, 5);
    const result = await judge("+ some change");
    expect(result.approved).toBe(true);
    expect(result.severity).toBe("warning");
    warn.mockRestore();
  });

  it("respects an external abort signal", async () => {
    generateTextMock.mockImplementationOnce(() => new Promise(() => {
      /* never resolves; abort should still fail open */
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = new AbortController();
    const judge = createReviewJudge(mockModel, controller.signal, 30_000);
    const pending = judge("+ some change");
    controller.abort();
    const result = await pending;
    expect(result.approved).toBe(true);
    warn.mockRestore();
  });
});
