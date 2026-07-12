import { beforeEach, describe, expect, it, vi } from "vitest";

const streamTextMock = vi.fn();
const assembleSystemContextMock = vi.fn();
const buildSystemPromptMock = vi.fn(() => "system prompt");
const isWorkspaceDirMock = vi.fn();
const openStreamMock = vi.fn();
const bridgeStreamMock = vi.fn();
const buildToolsMock = vi.fn();

vi.mock("ai", () => ({
  streamText: streamTextMock,
}));

vi.mock("../config/schema.js", () => ({
  resolveEngineConfig: () => ({
    config: {
      maxSteps: 12,
      commandTimeoutMs: 60_000,
      maxToolOutput: 12_000,
      contextBudget: { softPct: 0.75, hardPct: 0.9 },
      permissions: { terminal: "auto", review: "agent", rules: [] },
      providerRoles: { default: "default", small: "small", plan: "plan" },
      fallbackChain: [],
      sandbox: "off",
      apiMaxRetries: 2,
      personality: "",
      fileReadMaxChars: 250_000,
    },
    warnings: [],
  }),
}));

vi.mock("../provider/build.js", () => ({
  buildModel: () => ({ model: "mock" }),
  buildProviderOptions: () => undefined,
}));

vi.mock("../provider/registry.js", () => ({
  resolve: (id: string, hint?: { baseURL?: string; id?: string }) => ({
    id: hint?.id ?? id,
    provider: "mock-provider",
    baseURL: hint?.baseURL ?? "http://mock",
    limits: { contextWindow: 128_000, maxOutput: 8_192 },
  }),
}));

vi.mock("../provider/keys.js", () => ({
  KeyPool: class {
    isMulti() {
      return false;
    }
  },
}));

vi.mock("../provider/open-stream.js", () => ({
  openStream: openStreamMock,
}));

vi.mock("../tools/index.js", () => ({
  buildTools: buildToolsMock,
}));

vi.mock("../security/jail.js", () => ({
  isWorkspaceDir: isWorkspaceDirMock,
}));

vi.mock("../context/ccr.js", () => ({
  createCcrStore: () => ({ store: true }),
  makeRetrieveTool: () => ({ name: "retrieve" }),
}));

vi.mock("../memory/layers.js", () => ({
  assembleSystemContext: assembleSystemContextMock,
}));

vi.mock("./system-prompt.js", () => ({
  buildSystemPrompt: buildSystemPromptMock,
}));

vi.mock("./stop-conditions.js", () => ({
  buildStopWhen: () => "stop-when",
}));

vi.mock("./prepare-step.js", () => ({
  makePrepareStep: () => "prepare-step",
}));

vi.mock("./no-key-guidance.js", () => ({
  emitNoKeyGuidance: async () => ({ text: "", parts: [] }),
}));

vi.mock("../stream-bridge/bridge.js", () => ({
  bridgeStream: bridgeStreamMock,
}));

vi.mock("./persist.js", () => ({
  toParts: () => [],
}));

describe("runKyreiChat project context wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    buildSystemPromptMock.mockReturnValue("system prompt");
    buildToolsMock.mockReturnValue({ read_file: { name: "read_file" } });
    isWorkspaceDirMock.mockResolvedValue(true);
    assembleSystemContextMock.mockResolvedValue("PROJECT_CTX");
    streamTextMock.mockReturnValue({
      fullStream: (async function* () {})(),
      response: Promise.resolve({ messages: [] }),
    });
    openStreamMock.mockImplementation(async (_count: number, _hasTools: boolean, start: (ci: number, useTools: boolean) => unknown) => start(0, true));
    bridgeStreamMock.mockResolvedValue({ text: "ok", parts: [] });
  });

  it("injects assembled project context into live tool turns", async () => {
    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "hi" }],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
      workspace: "/workspace",
    });

    expect(assembleSystemContextMock).toHaveBeenCalledWith({ workspace: "/workspace" });
    expect(buildSystemPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: "/workspace",
        hasTools: true,
        projectContext: "PROJECT_CTX",
      }),
    );
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it("fails open when project context assembly throws", async () => {
    assembleSystemContextMock.mockRejectedValueOnce(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runKyreiChat } = await import("./run.js");

    await expect(
      runKyreiChat({
        emit: () => {},
        messages: [{ role: "user", content: "hi" }],
        providerBase: "http://mock",
        apiKey: "key",
        model: "mock-model",
        workspace: "/workspace",
      }),
    ).resolves.toEqual({ text: "ok", parts: [] });

    expect(buildSystemPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectContext: undefined,
      }),
    );
    expect(warn).toHaveBeenCalledWith("[kyrei v2] project context disabled:", expect.any(Error));
    warn.mockRestore();
  });

  it("preserves no-workspace behavior", async () => {
    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "hi" }],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
    });

    expect(assembleSystemContextMock).not.toHaveBeenCalled();
    expect(buildSystemPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: undefined,
        hasTools: false,
        projectContext: undefined,
      }),
    );
  });
});
