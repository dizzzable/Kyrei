import { beforeEach, describe, expect, it, vi } from "vitest";

const streamTextMock = vi.fn();
const assembleSystemContextMock = vi.fn();
const buildSystemPromptMock = vi.fn(() => "system prompt");
const isWorkspaceDirMock = vi.fn();
const openStreamMock = vi.fn();
const bridgeStreamMock = vi.fn();
const buildToolsMock = vi.fn();
const resolveModelMock = vi.fn();
const buildGBrainToolsMock = vi.fn();
const toPartsMock = vi.fn(() => []);
const buildWebToolsMock = vi.fn(() => ({}));
const createAuditLogMock = vi.fn();

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
      permissions: { terminal: "auto", web: "off", review: "agent", rules: [] },
      providerRoles: { default: "default", small: "small", plan: "plan" },
      fallbackChain: ["fallback-model"],
      sandbox: "off",
      apiMaxRetries: 2,
      personality: "",
      fileReadMaxChars: 250_000,
      memory: {
        gbrain: { mode: "off", command: "gbrain", timeoutMs: 180_000, maxOutputBytes: 200_000 },
      },
    },
    warnings: [],
  }),
}));

vi.mock("../provider/build.js", () => ({
  buildModel: () => ({ model: "mock" }),
  buildProviderOptions: () => undefined,
  hasProviderCredentials: () => true,
}));

vi.mock("../provider/registry.js", () => ({
  resolve: (id: string, hint?: { baseURL?: string; id?: string; provider?: string }) => {
    resolveModelMock(id, hint);
    return ({
    id: hint?.id ?? id,
    provider: hint?.provider ?? "mock-provider",
    baseURL: hint?.baseURL ?? "http://mock",
    limits: { contextWindow: 128_000, maxOutput: 8_192 },
    });
  },
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

vi.mock("../tools/gbrain.js", () => ({
  buildGBrainTools: buildGBrainToolsMock,
}));

vi.mock("../tools/web.js", () => ({
  buildWebTools: buildWebToolsMock,
}));

vi.mock("../security/audit.js", () => ({
  createAuditLog: createAuditLogMock,
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
  toParts: toPartsMock,
}));

describe("runKyreiChat project context wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    buildSystemPromptMock.mockReturnValue("system prompt");
    buildToolsMock.mockReturnValue({ read_file: { name: "read_file" } });
    buildGBrainToolsMock.mockReturnValue({});
    buildWebToolsMock.mockReturnValue({});
    isWorkspaceDirMock.mockResolvedValue(true);
    assembleSystemContextMock.mockResolvedValue("PROJECT_CTX");
    streamTextMock.mockReturnValue({
      stream: (async function* () {})(),
      responseMessages: Promise.resolve([]),
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
    const streamOptions = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(streamOptions.instructions).toBe("system prompt");
    expect(streamOptions).not.toHaveProperty("system");
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

  it("persists the cumulative responseMessages from every tool-loop step", async () => {
    const responseMessages = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "read_file", output: { type: "text", value: "data" } }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    streamTextMock.mockReturnValueOnce({
      stream: (async function* () {})(),
      responseMessages: Promise.resolve(responseMessages),
    });
    const bridged = { text: "done", parts: [] };
    bridgeStreamMock.mockResolvedValueOnce(bridged);

    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "hi" }],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
      workspace: "/workspace",
    });

    expect(toPartsMock).toHaveBeenCalledWith(responseMessages, bridged);
  });

  it("shares one audit sink with local and web tools and correlates the session", async () => {
    const audit = { write: vi.fn() };
    createAuditLogMock.mockReturnValueOnce(audit);
    const { runKyreiChat } = await import("./run.js");

    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "hi" }],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
      workspace: "/workspace",
      auditLogPath: "/audit.jsonl",
      sessionId: "session-1",
    });

    expect(createAuditLogMock).toHaveBeenCalledTimes(1);
    expect(buildToolsMock).toHaveBeenCalledWith(
      "/workspace",
      expect.any(Object),
      expect.any(Map),
      { abortSignal: undefined, audit, sessionId: "session-1" },
    );
    expect(buildWebToolsMock).toHaveBeenCalledWith(expect.any(Object), { audit, sessionId: "session-1" });
  });

  it("makes enabled brain tools available without a workspace", async () => {
    buildGBrainToolsMock.mockReturnValueOnce({ brain_search: { name: "brain_search" } });
    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "hi" }],
      providerBase: "http://mock",
      providerProtocol: "openai-chat",
      apiKey: "key",
      model: "mock-model",
    });

    expect(buildSystemPromptMock).toHaveBeenCalledWith(expect.objectContaining({ hasBrainTools: true, hasTools: true }));
    expect(openStreamMock).toHaveBeenCalledWith(2, true, expect.any(Function));
  });

  it("pins fallback models to the active provider endpoint", async () => {
    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "hi" }],
      providerBase: "https://active.example/v1",
      providerId: "active",
      apiKey: "key",
      model: "primary-model",
    });

    expect(resolveModelMock).toHaveBeenCalledWith("fallback-model", {
      baseURL: "https://active.example/v1",
      provider: "active",
    });
  });
});
