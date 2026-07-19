import { beforeEach, describe, expect, it, vi } from "vitest";

const streamTextMock = vi.fn();
const generateTextMock = vi.fn();
const isStepCountMock = vi.fn((steps: number) => ({ steps }));
const assembleSystemContextMock = vi.fn();
const buildSystemPromptPartsMock = vi.fn(() => ({ stable: "system prompt" }));
const isWorkspaceDirMock = vi.fn();
const openStreamMock = vi.fn();
const bridgeStreamMock = vi.fn();
const buildToolsMock = vi.fn();
const resolveModelMock = vi.fn();
const buildGBrainToolsMock = vi.fn();
const buildPlanningToolsMock = vi.fn(() => ({}));
const buildOpenVikingToolsMock = vi.fn(() => ({}));
const buildMemorySearchToolsMock = vi.fn(() => ({}));
const buildMemoryAskToolsMock = vi.fn(() => ({}));
const buildMemoryWriteToolsMock = vi.fn(() => ({}));
const buildSkillToolsMock = vi.fn();
const buildMcpToolsMock = vi.fn(() => ({}));
const createMcpManagerMock = vi.fn(() => ({ close: vi.fn(async () => undefined) }));
const buildModelMock = vi.fn();
const buildProviderOptionsMock = vi.fn();
const resolveEngineConfigMock = vi.fn();
const toPartsMock = vi.fn(() => []);
const buildWebToolsMock = vi.fn(() => ({}));
const createAuditLogMock = vi.fn();
const makePrepareStepMock = vi.fn(() => "prepare-step");

vi.mock("ai", () => ({
  streamText: streamTextMock,
  generateText: generateTextMock,
  isStepCount: isStepCountMock,
  modelMessageSchema: {
    safeParse: (value: unknown) => ({ success: true, data: value }),
  },
  tool: (definition: unknown) => definition,
}));

vi.mock("../config/schema.js", () => ({
  resolveEngineConfig: resolveEngineConfigMock,
}));

vi.mock("../provider/build.js", () => ({
  buildModel: buildModelMock,
  buildProviderOptions: buildProviderOptionsMock,
  hasProviderCredentials: () => true,
  resolveTurnModelParams: (params: { effort?: string } | undefined, def?: string) => {
    if (params?.effort) return params;
    if (def && def !== "off" && def !== "none") return { ...(params ?? {}), effort: def };
    return params;
  },
}));

vi.mock("../provider/registry.js", () => ({
  resolve: (id: string, hint?: { baseURL?: string; id?: string; provider?: string; protocol?: string }) => {
    resolveModelMock(id, hint);
    return ({
    id: hint?.id ?? id,
    provider: hint?.provider ?? "mock-provider",
    baseURL: hint?.baseURL ?? "http://mock",
    limits: id === "unknown-partial-model" ? {} : { contextWindow: 128_000, maxOutput: 8_192 },
    cost: { inputPerM: 1, outputPerM: 2 },
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
  streamAttemptsFromError: () => [],
}));

vi.mock("../tools/index.js", () => ({
  buildTools: buildToolsMock,
}));

vi.mock("../tools/gbrain.js", () => ({
  buildGBrainTools: buildGBrainToolsMock,
}));

vi.mock("../tools/planning.js", () => ({
  buildPlanningTools: buildPlanningToolsMock,
}));

vi.mock("../tools/openviking.js", () => ({
  buildOpenVikingTools: buildOpenVikingToolsMock,
}));

vi.mock("../tools/memory-search.js", () => ({
  buildMemorySearchTools: buildMemorySearchToolsMock,
}));

vi.mock("../tools/memory-ask.js", () => ({
  buildMemoryAskTools: buildMemoryAskToolsMock,
}));

vi.mock("../tools/memory-write.js", () => ({
  buildMemoryWriteTools: buildMemoryWriteToolsMock,
}));

vi.mock("../tools/web.js", () => ({
  buildWebTools: buildWebToolsMock,
}));

vi.mock("../tools/skills.js", () => ({
  buildSkillTools: buildSkillToolsMock,
}));

vi.mock("../tools/mcp.js", () => ({
  buildMcpTools: buildMcpToolsMock,
}));

vi.mock("../mcp/manager.js", () => ({
  normalizeMcpConfig: (config: unknown) => config,
  createMcpManager: createMcpManagerMock,
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
  buildSystemPromptParts: buildSystemPromptPartsMock,
}));

vi.mock("../prompt/cache-packing.js", () => ({
  packSystemForCache: (parts: { stable?: string; volatile?: string } | undefined) => ({
    instructions: [parts?.stable, parts?.volatile].filter(Boolean).join("\n\n"),
    cacheBreakpoints: false,
  }),
  mergeProviderOptions: (
    base: Record<string, Record<string, unknown>> | undefined,
    extra: Record<string, Record<string, unknown>> | undefined,
  ) => {
    if (!base) return extra;
    if (!extra) return base;
    const merged = { ...base };
    for (const [key, value] of Object.entries(extra)) merged[key] = { ...(merged[key] ?? {}), ...value };
    return merged;
  },
}));

vi.mock("./stop-conditions.js", () => ({
  buildStopWhen: () => "stop-when",
}));

vi.mock("./prepare-step.js", () => ({
  makePrepareStep: makePrepareStepMock,
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

function engineConfig(delegation: Partial<{
  enabled: boolean;
  maxTasks: number;
  maxParallel: number;
  maxSteps: number;
  timeoutMs: number;
}> = {}) {
  return {
    maxSteps: 12,
    commandTimeoutMs: 60_000,
    maxToolOutput: 12_000,
    contextBudget: { softPct: 0.75, hardPct: 0.9 },
    permissions: { terminal: "auto", web: "off", review: "agent", rules: [] },
    fallbackChain: ["fallback-model"],
    sandbox: "off",
    apiMaxRetries: 2,
    personality: "",
    activePromptProfileId: "",
    promptProfiles: [],
    fileReadMaxChars: 250_000,
    delegation: { enabled: true, maxTasks: 3, maxParallel: 2, maxSteps: 8, timeoutMs: 90_000, ...delegation },
    memory: {
      gbrain: { mode: "off", command: "gbrain", timeoutMs: 180_000, maxOutputBytes: 200_000 },
      ltm: { enabled: false },
      openviking: { enabled: false },
      index: { enabled: false, backend: "off" as const, embed: { mode: "lexical" as const } },
      sessionMirror: { enabled: false, readSearch: false, enginePrimary: false },
    },
    planning: { enabled: false },
    review: { cleanContext: false },
    executionMode: "autopilot" as const,
    reliability: { goalVerify: false },
    mcp: { enabled: false, servers: [], timeoutMs: 30_000, maxServers: 8, maxToolsPerServer: 64, maxResultChars: 24_000 },
  };
}

describe("runKyreiChat project context wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    buildSystemPromptPartsMock.mockReturnValue({ stable: "system prompt" });
    buildToolsMock.mockReturnValue({ read_file: { name: "read_file" } });
    buildGBrainToolsMock.mockReturnValue({});
    buildPlanningToolsMock.mockReturnValue({});
    buildOpenVikingToolsMock.mockReturnValue({});
    buildMemorySearchToolsMock.mockReturnValue({});
    buildMemoryAskToolsMock.mockReturnValue({});
    buildMemoryWriteToolsMock.mockReturnValue({});
    buildWebToolsMock.mockReturnValue({});
    buildSkillToolsMock.mockReturnValue({});
    buildMcpToolsMock.mockReturnValue({});
    createMcpManagerMock.mockReturnValue({ close: vi.fn(async () => undefined) });
    buildModelMock.mockReturnValue({ model: "mock" });
    buildProviderOptionsMock.mockReturnValue(undefined);
    resolveEngineConfigMock.mockReturnValue({ config: engineConfig(), warnings: [] });
    generateTextMock.mockResolvedValue({
      text: "child result",
      steps: [{ text: "child result" }],
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });
    isWorkspaceDirMock.mockResolvedValue(true);
    assembleSystemContextMock.mockResolvedValue("PROJECT_CTX");
    streamTextMock.mockReturnValue({
      stream: (async function* () {})(),
      responseMessages: Promise.resolve([]),
    });
    openStreamMock.mockImplementation(async (_count: number, hasTools: boolean, start: (ci: number, useTools: boolean) => unknown) => await start(0, hasTools));
    bridgeStreamMock.mockResolvedValue({ text: "ok", parts: [], status: "complete" });
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
    expect(buildSystemPromptPartsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: "/workspace",
        hasTools: true,
        projectContext: "PROJECT_CTX",
        hasDecisionTools: false,
        hasPlanningTools: false,
        hasOpenVikingTools: false,
        hasMemorySearch: false,
      }),
    );
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const streamOptions = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(streamOptions.instructions).toBe("system prompt");
    expect(streamOptions).not.toHaveProperty("system");
  });

  it("forces one explicitly requested available diagnostic tool instead of allowing a text-only claim", async () => {
    resolveEngineConfigMock.mockReturnValueOnce({
      config: {
        ...engineConfig(),
        memory: {
          ...engineConfig().memory,
          gbrain: { mode: "read", provider: "builtin" },
        },
      },
      warnings: [],
    });
    const execute = vi.fn(async () => "state=ready");
    buildGBrainToolsMock.mockReturnValueOnce({ brain_status: { name: "brain_status", execute } });
    streamTextMock.mockReturnValueOnce({
      stream: (async function* () {})(),
      responseMessages: Promise.resolve([{ role: "assistant", content: "The diagnostic is unavailable." }]),
    });

    const { runKyreiChat } = await import("./run.js");
    const result = await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "Use the available brain_status tool before you answer." }],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
    });

    const streamOptions = streamTextMock.mock.calls[0]?.[0] as { toolChoice?: unknown };
    expect(streamOptions.toolChoice).toEqual({ type: "tool", toolName: "brain_status" });
    expect(execute).toHaveBeenCalledWith({}, expect.objectContaining({ messages: [] }));
    expect(result.text).toContain("Authoritative brain_status result");
    expect(result.parts).toContainEqual(expect.objectContaining({
      type: "tool",
      name: "brain_status",
      result: "state=ready",
    }));
    expect(result.responseMessages).toEqual([{
      role: "assistant",
      content: expect.stringContaining("Authoritative brain_status result"),
    }]);
  });

  it("keeps an explicitly requested MCP catalog diagnostic when an endpoint retries without tool_choice", async () => {
    resolveEngineConfigMock.mockReturnValueOnce({
      config: {
        ...engineConfig(),
        mcp: {
          ...engineConfig().mcp,
          enabled: true,
          servers: [{ id: "project-mcp", transport: "stdio", command: "node", args: [] }],
        },
      },
      warnings: [],
    });
    const execute = vi.fn(async () => "project-mcp: 1 tool");
    buildMcpToolsMock.mockReturnValueOnce({ mcp_list_tools: { name: "mcp_list_tools", execute } });
    openStreamMock.mockImplementationOnce(async (
      _count: number,
      hasTools: boolean,
      start: (candidate: number, useTools: boolean) => Promise<{ stream: AsyncIterable<unknown>; responseMessages: PromiseLike<unknown[]> }>,
    ) => {
      expect(hasTools).toBe(true);
      await start(0, true);
      return await start(0, false);
    });

    const { runKyreiChat } = await import("./run.js");
    const result = await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "Use mcp_list_tools before you answer." }],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
    });

    expect(streamTextMock).toHaveBeenCalledTimes(2);
    expect(streamTextMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      toolChoice: { type: "tool", toolName: "mcp_list_tools" },
    }));
    expect(streamTextMock.mock.calls[1]?.[0]).not.toHaveProperty("tools");
    expect(execute).toHaveBeenCalledWith({}, expect.objectContaining({ messages: [] }));
    expect(result.text).toContain("Authoritative mcp_list_tools result");
    expect(result.parts).toContainEqual(expect.objectContaining({
      type: "tool",
      name: "mcp_list_tools",
      result: "project-mcp: 1 tool",
    }));
  });

  it("forces only an exact MCP call selection so it reaches the normal approval path", async () => {
    resolveEngineConfigMock.mockReturnValueOnce({
      config: {
        ...engineConfig(),
        mcp: {
          ...engineConfig().mcp,
          enabled: true,
          servers: [{ id: "project-mcp", transport: "stdio", command: "node", args: [] }],
        },
      },
      warnings: [],
    });
    buildMcpToolsMock.mockReturnValueOnce({ mcp_call: { name: "mcp_call" } });

    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: () => {},
      messages: [{
        role: "user",
        content: "Invoke mcp_call with serverId project-mcp, tool repository_status, and empty arguments.",
      }],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
    });

    expect(streamTextMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      toolChoice: { type: "tool", toolName: "mcp_call" },
    }));
  });

  it("stops an explicitly forced diagnostic after its first completed tool step", async () => {
    resolveEngineConfigMock.mockReturnValueOnce({
      config: {
        ...engineConfig(),
        memory: {
          ...engineConfig().memory,
          gbrain: { mode: "read", provider: "builtin" },
        },
      },
      warnings: [],
    });
    buildGBrainToolsMock.mockReturnValueOnce({ brain_status: { name: "brain_status", execute: vi.fn() } });

    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "Use brain_status now." }],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
    });

    const streamOptions = streamTextMock.mock.calls[0]?.[0] as {
      stopWhen?: Array<(value: { steps: Array<{ toolCalls: Array<{ toolName: string }> }> }) => boolean>;
    };
    const forcedStop = streamOptions.stopWhen?.[0];
    expect(forcedStop).toBeTypeOf("function");
    expect(forcedStop?.({ steps: [{ toolCalls: [{ toolName: "brain_status" }] }] })).toBe(true);
    expect(forcedStop?.({ steps: [{ toolCalls: [{ toolName: "memory_search" }] }] })).toBe(false);
  });

  it("puts a clean-session continuation packet ahead of project context without altering chat messages", async () => {
    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "continue" }],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
      workspace: "/workspace",
      continuationContext: "<<layer:SESSION_CONTINUATION_REFERENCE>>\ncheckpoint",
    });

    expect(buildSystemPromptPartsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectContext: "<<layer:SESSION_CONTINUATION_REFERENCE>>\ncheckpoint\n\nPROJECT_CTX",
      }),
    );
    const streamOptions = streamTextMock.mock.calls[0]?.[0] as { messages?: unknown[] };
    expect(streamOptions.messages).toEqual([{ role: "user", content: "continue" }]);
  });

  it("wires LTM decisions, plan-as-files, and OpenViking when each flag is on", async () => {
    resolveEngineConfigMock.mockReturnValueOnce({
      config: {
        ...engineConfig(),
        memory: {
          gbrain: { mode: "off", command: "gbrain", timeoutMs: 180_000, maxOutputBytes: 200_000 },
          ltm: { enabled: true },
          openviking: { enabled: true, baseURL: "http://127.0.0.1:1933" },
          index: { enabled: false, backend: "off" as const, embed: { mode: "lexical" as const } },
          sessionMirror: { enabled: false },
        },
        planning: { enabled: true },
      },
      warnings: [],
    });
    buildPlanningToolsMock.mockReturnValueOnce({ plan_read: { name: "plan_read" } });
    buildOpenVikingToolsMock.mockReturnValueOnce({ openviking_find: { name: "openviking_find" } });
    buildMemorySearchToolsMock.mockReturnValueOnce({ memory_search: { name: "memory_search" } });

    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "hi" }],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
      workspace: "/workspace",
      sessionId: "sess-1",
    });

    expect(assembleSystemContextMock).toHaveBeenCalledWith({
      workspace: "/workspace",
      ltmDir: expect.stringMatching(/ltm$/),
      includePlan: true,
    });
    expect(buildPlanningToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "/workspace" }),
    );
    expect(buildOpenVikingToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, baseURL: "http://127.0.0.1:1933" }),
      expect.objectContaining({ sessionId: "sess-1" }),
    );
    expect(buildMemorySearchToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "/workspace", ltmEnabled: true }),
    );
    expect(buildSystemPromptPartsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hasDecisionTools: true,
        hasPlanningTools: true,
        hasOpenVikingTools: true,
        hasMemorySearch: true,
      }),
    );
  });

  it("carries a validated receipt into guarded execution when policy changes from ask to allow", async () => {
    resolveEngineConfigMock.mockReturnValueOnce({
      config: {
        ...engineConfig(),
        permissions: { ...engineConfig().permissions, terminal: "turbo" },
      },
      warnings: [],
    });
    const onApprovalConsumed = vi.fn(async () => undefined);
    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "hi" }],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
      workspace: "/workspace",
      approvalSecret: "approval-secret",
      onApprovalConsumed,
    });

    const streamOptions = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const approval = streamOptions.toolApproval as (input: {
      toolCall: { toolCallId: string; toolName: string; input: unknown };
      messages: Array<Record<string, unknown>>;
    }) => Promise<unknown>;
    const result = await approval({
      toolCall: { toolCallId: "call-policy-allow", toolName: "run_command", input: { command: "npm test" } },
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool-approval-request", approvalId: "approval-policy-allow", toolCallId: "call-policy-allow", signature: "validated-by-ai-sdk" }],
        },
        {
          role: "tool",
          content: [{ type: "tool-approval-response", approvalId: "approval-policy-allow", approved: true }],
        },
      ],
    });

    expect(result).toBe("not-applicable");
    const buildOptions = buildToolsMock.mock.calls[0]?.[3] as { approvedToolCalls: Map<string, string> };
    expect(buildOptions.approvedToolCalls.get("call-policy-allow")).toBe("approval-policy-allow");
    expect(onApprovalConsumed).not.toHaveBeenCalled();
  });

  it("durably consumes a validated receipt without execution when policy changes from ask to deny", async () => {
    resolveEngineConfigMock.mockReturnValueOnce({
      config: {
        ...engineConfig(),
        permissions: {
          ...engineConfig().permissions,
          rules: [{ pattern: "^run_command:", action: "deny" }],
        },
      },
      warnings: [],
    });
    const onApprovalConsumed = vi.fn(async () => undefined);
    const emit = vi.fn();
    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit,
      messages: [{ role: "user", content: "hi" }],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
      workspace: "/workspace",
      approvalSecret: "approval-secret",
      onApprovalConsumed,
    });

    const streamOptions = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const approval = streamOptions.toolApproval as (input: {
      toolCall: { toolCallId: string; toolName: string; input: unknown };
      messages: Array<Record<string, unknown>>;
    }) => Promise<unknown>;
    const result = await approval({
      toolCall: { toolCallId: "call-policy-deny", toolName: "run_command", input: { command: "npm test" } },
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool-approval-request", approvalId: "approval-policy-deny", toolCallId: "call-policy-deny", signature: "validated-by-ai-sdk" }],
        },
        {
          role: "tool",
          content: [{ type: "tool-approval-response", approvalId: "approval-policy-deny", approved: true }],
        },
      ],
    });

    expect(result).toEqual({ type: "denied", reason: "permission_rule_denied" });
    expect(onApprovalConsumed).toHaveBeenCalledWith("approval-policy-deny", "call-policy-deny");
    expect(emit).toHaveBeenCalledWith({
      type: "approval.consumed",
      payload: { approval_id: "approval-policy-deny", tool_call_id: "call-policy-deny" },
    });
    const buildOptions = buildToolsMock.mock.calls[0]?.[3] as { approvedToolCalls: Map<string, string> };
    expect(buildOptions.approvedToolCalls.has("call-policy-deny")).toBe(false);
  });

  it("applies bounded context/output overrides only to the primary candidate", async () => {
    openStreamMock.mockImplementationOnce(async (
      _count: number,
      hasTools: boolean,
      start: (ci: number, useTools: boolean) => Promise<{ stream: AsyncIterable<unknown>; responseMessages: PromiseLike<unknown[]> }>,
    ) => {
      await start(0, hasTools);
      return { ...(await start(1, hasTools)), candidateIndex: 1 };
    });
    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "hi" }],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
      workspace: "/workspace",
      modelLimits: { contextWindow: 90_000, maxOutput: 9_000 },
      modelParams: { contextWindowOverride: 96_000, maxOutputOverride: 12_000 },
    });

    expect(makePrepareStepMock).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ model: "mock-model", window: 75_808, ccr: expect.anything(), workspace: "/workspace", sessionId: undefined }));
    expect(makePrepareStepMock).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ model: "fallback-model", window: 111_616, ccr: expect.anything(), workspace: "/workspace", sessionId: undefined }));
    expect(streamTextMock.mock.calls[0]?.[0]).toMatchObject({ maxOutputTokens: 12_000 });
    expect(streamTextMock.mock.calls[1]?.[0]).toMatchObject({ maxOutputTokens: 8_192 });
  });

  it("uses each target's sanitized detected limits for compaction and output", async () => {
    resolveEngineConfigMock.mockReturnValueOnce({
      config: { ...engineConfig(), fallbackChain: [] },
      warnings: [],
    });
    openStreamMock.mockImplementationOnce(async (
      _count: number,
      hasTools: boolean,
      start: (ci: number, useTools: boolean) => Promise<{ stream: AsyncIterable<unknown>; responseMessages: PromiseLike<unknown[]> }>,
    ) => {
      await start(0, hasTools);
      return { ...(await start(1, hasTools)), candidateIndex: 1 };
    });
    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "hi" }],
      providerBase: "https://primary.example/v1",
      providerProtocol: "openai-chat",
      providerId: "primary",
      apiKey: "primary-key",
      model: "primary-model",
      workspace: "/workspace",
      modelLimits: { contextWindow: 90_000, maxOutput: 9_000 },
      fallbackProviders: [{
        providerId: "fallback",
        protocol: "openai-chat",
        baseURL: "https://fallback.example/v1",
        model: "fallback-model",
        apiKey: "fallback-key",
        limits: { contextWindow: 40_000, maxOutput: 4_000 },
      }],
    });

    expect(makePrepareStepMock).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ model: "primary-model", window: 72_808, ccr: expect.anything(), workspace: "/workspace", sessionId: undefined }));
    expect(makePrepareStepMock).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ model: "fallback-model", window: 27_808, ccr: expect.anything(), workspace: "/workspace", sessionId: undefined }));
    expect(streamTextMock.mock.calls[0]?.[0]).toMatchObject({ maxOutputTokens: 9_000 });
    expect(streamTextMock.mock.calls[1]?.[0]).toMatchObject({ maxOutputTokens: 4_000 });
  });

  it("keeps an output-only runtime limit partial instead of inventing context", async () => {
    resolveEngineConfigMock.mockReturnValueOnce({
      config: { ...engineConfig(), fallbackChain: [] },
      warnings: [],
    });
    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "hi" }],
      providerBase: "https://proxy.example/v1",
      providerProtocol: "openai-chat",
      providerId: "proxy",
      apiKey: "proxy-key",
      model: "unknown-partial-model",
      workspace: "/workspace",
      modelLimits: { contextWindow: -1, maxOutput: 2_000 },
    });

    expect(makePrepareStepMock).not.toHaveBeenCalled();
    expect(streamTextMock.mock.calls[0]?.[0]).toMatchObject({ maxOutputTokens: 2_000 });
  });

  it("rejects untrusted non-integer and out-of-range limit overrides at runtime", async () => {
    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "hi" }],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
      workspace: "/workspace",
      modelParams: {
        contextWindowOverride: "96000" as unknown as number,
        maxOutputOverride: 10_000_001,
      },
    });

    expect(makePrepareStepMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: "mock-model", window: 111_616, ccr: expect.anything(), workspace: "/workspace", sessionId: undefined }));
    expect(streamTextMock.mock.calls[0]?.[0]).toMatchObject({ maxOutputTokens: 8_192 });
  });

  it("compacts the initial restored history before the first provider request", async () => {
    const compacted = [{ role: "user", content: "compact context" }];
    makePrepareStepMock.mockReturnValueOnce(async () => ({ messages: compacted }));
    const { runKyreiChat } = await import("./run.js");

    await runKyreiChat({
      emit: () => {},
      messages: [
        { role: "user", content: "old large context" },
        { role: "assistant", content: "old response" },
        { role: "user", content: "continue" },
      ],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
      workspace: "/workspace",
    });

    const options = streamTextMock.mock.calls[0]?.[0] as { messages?: unknown };
    expect(options.messages).toEqual(compacted);
    expect(makePrepareStepMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ window: 111_616 }),
    );
  });

  it("keeps an OpenAI Responses prompt-cache key stable for one session", async () => {
    buildProviderOptionsMock.mockReturnValueOnce({ openai: { reasoningEffort: "high" } });
    const { runKyreiChat } = await import("./run.js");

    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "continue" }],
      providerBase: "https://api.openai.com/v1",
      providerProtocol: "openai-responses",
      apiKey: "key",
      model: "gpt-5.6-sol",
      workspace: "/workspace",
      sessionId: "sess:cache/test",
      modelParams: { effort: "high" },
    });

    const options = streamTextMock.mock.calls[0]?.[0] as { providerOptions?: Record<string, Record<string, unknown>> };
    expect(options.providerOptions).toEqual({
      openai: {
        reasoningEffort: "high",
        promptCacheKey: "kyrei:v2:sess_cache_test:gpt-5.6-sol",
      },
    });
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
    ).resolves.toMatchObject({
      text: "ok",
      parts: [],
      status: "complete",
      attempts: [],
      route: { providerId: "mock-provider", modelId: "mock-model" },
      harness: expect.objectContaining({ intentRoute: expect.any(String) }),
    });

    expect(buildSystemPromptPartsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectContext: undefined,
      }),
    );
    expect(warn).toHaveBeenCalledWith("[kyrei v2] project context disabled:", expect.any(Error));
    warn.mockRestore();
  });

  it("keeps model-only read delegation available without a workspace", async () => {
    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "hi" }],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
    });

    expect(assembleSystemContextMock).not.toHaveBeenCalled();
    expect(buildSystemPromptPartsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: undefined,
        hasTools: true,
        hasDelegation: true,
        projectContext: undefined,
      }),
    );
  });

  it("preserves bare chat mode when delegation and every other tool group are disabled", async () => {
    resolveEngineConfigMock.mockReturnValueOnce({
      config: engineConfig({ enabled: false }),
      warnings: [],
    });
    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "hi" }],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
    });

    expect(buildSystemPromptPartsMock).toHaveBeenCalledWith(
      expect.objectContaining({ hasTools: false, hasDelegation: false }),
    );
    expect(openStreamMock).toHaveBeenCalledWith(2, false, expect.any(Function));
    expect(streamTextMock.mock.calls[0]?.[0]).not.toHaveProperty("tools");
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

  it.each(["max_steps", "heal_handoff", "goal_unsatisfied"] as const)(
    "continues the same turn after the internal %s checkpoint",
    async (checkpointStatus) => {
      const firstResponse = [
        { role: "assistant", content: [{ type: "text", text: "partial " }] },
      ];
      const secondResponse = [
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ];
      streamTextMock
        .mockReturnValueOnce({
          stream: (async function* () {})(),
          responseMessages: Promise.resolve(firstResponse),
        })
        .mockReturnValueOnce({
          stream: (async function* () {})(),
          responseMessages: Promise.resolve(secondResponse),
        });
      toPartsMock
        .mockReturnValueOnce([{ type: "text", text: "partial " }])
        .mockReturnValueOnce([{ type: "text", text: "done" }]);
      bridgeStreamMock
        .mockImplementationOnce(async (_stream, emit: (event: unknown) => void) => {
          emit({ type: "message.delta", payload: { text: "partial " } });
          emit({ type: "message.complete", payload: { text: "partial ", status: checkpointStatus } });
          return {
            text: "partial ",
            parts: [{ type: "text", text: "partial " }],
            status: checkpointStatus,
          };
        })
        .mockImplementationOnce(async (_stream, emit: (event: unknown) => void) => {
          emit({ type: "message.delta", payload: { text: "done" } });
          emit({ type: "message.complete", payload: { text: "done", status: "complete" } });
          return {
            text: "done",
            parts: [{ type: "text", text: "done" }],
            status: "complete",
          };
        });
      const emit = vi.fn();

      const { runKyreiChat } = await import("./run.js");
      const result = await runKyreiChat({
        emit,
        messages: [{ role: "user", content: "Finish the original task" }],
        providerBase: "http://mock",
        apiKey: "key",
        model: "mock-model",
      });

      expect(streamTextMock).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        text: "partial done",
        status: "complete",
        parts: [{ type: "text", text: "partial done" }],
        responseMessages: [...firstResponse, ...secondResponse],
      });
      const completionEvents = emit.mock.calls
        .map(([event]) => event)
        .filter((event) => event?.type === "message.complete");
      expect(completionEvents).toEqual([{
        type: "message.complete",
        payload: { text: "partial done", status: "complete" },
      }]);
      const secondPass = streamTextMock.mock.calls[1]?.[0] as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(secondPass.messages.at(-1)).toMatchObject({
        role: "user",
        content: expect.stringContaining("engine recovery checkpoint"),
      });
    },
  );

  it("stops automatic recovery when a later window repeats the same tool observation", async () => {
    const firstResponse = [{ role: "assistant", content: [{ type: "text", text: "indexing " }] }];
    const secondResponse = [{ role: "assistant", content: [{ type: "text", text: "again" }] }];
    streamTextMock
      .mockReturnValueOnce({ stream: (async function* () {})(), responseMessages: Promise.resolve(firstResponse) })
      .mockReturnValueOnce({ stream: (async function* () {})(), responseMessages: Promise.resolve(secondResponse) });
    toPartsMock
      .mockReturnValueOnce([{
        type: "tool",
        toolCallId: "index-1",
        name: "project_index",
        args: {},
        result: "workspace index is current; generatedAt: 2026-07-19T03:00:00Z",
        running: false,
      }])
      .mockReturnValueOnce([{
        type: "tool",
        toolCallId: "index-2",
        name: "project_index",
        args: {},
        result: "workspace index is current; generatedAt: 2026-07-19T03:02:00Z",
        running: false,
      }]);
    bridgeStreamMock
      .mockResolvedValueOnce({ text: "indexing ", parts: [], status: "max_steps" })
      .mockResolvedValueOnce({ text: "again", parts: [], status: "max_steps" });
    const emit = vi.fn();

    const { runKyreiChat } = await import("./run.js");
    const result = await runKyreiChat({
      emit,
      messages: [{ role: "user", content: "Finish the original task" }],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
    });

    expect(streamTextMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("max_steps");
    expect(emit).toHaveBeenCalledWith({
      type: "message.complete",
      payload: { text: "indexing again", status: "max_steps" },
    });
  });

  it("continues across recovery windows while each window adds new tool evidence", async () => {
    const responses = ["first", "second", "done"].map((text) => ([{
      role: "assistant",
      content: [{ type: "text", text }],
    }]));
    for (const response of responses) {
      streamTextMock.mockReturnValueOnce({
        stream: (async function* () {})(),
        responseMessages: Promise.resolve(response),
      });
    }
    toPartsMock
      .mockReturnValueOnce([{
        type: "tool",
        toolCallId: "list-1",
        name: "list_dir",
        args: { path: "." },
        result: "src\ntests",
        running: false,
      }])
      .mockReturnValueOnce([{
        type: "tool",
        toolCallId: "read-1",
        name: "read_file",
        args: { path: "src/index.ts" },
        result: "export const ready = true;",
        running: false,
      }])
      .mockReturnValueOnce([{ type: "text", text: "done" }]);
    bridgeStreamMock
      .mockResolvedValueOnce({ text: "first", parts: [], status: "max_steps" })
      .mockResolvedValueOnce({ text: "second", parts: [], status: "max_steps" })
      .mockResolvedValueOnce({ text: "done", parts: [], status: "complete" });

    const { runKyreiChat } = await import("./run.js");
    const result = await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "Inspect the project thoroughly" }],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
    });

    expect(streamTextMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ text: "firstseconddone", status: "complete" });
  });

  it("keeps a configured cumulative budget terminal instead of auto-continuing", async () => {
    resolveEngineConfigMock.mockReturnValue({
      config: {
        ...engineConfig(),
        reliability: { ...engineConfig().reliability, maxTokens: 1_000 },
      },
      warnings: [],
    });
    bridgeStreamMock.mockImplementationOnce(async (_stream, emit: (event: unknown) => void) => {
      emit({
        type: "message.complete",
        payload: { text: "window reached", status: "max_steps", usage: { totalTokens: 1_000 } },
      });
      return {
        text: "window reached",
        parts: [],
        status: "max_steps",
        usage: { totalTokens: 1_000 },
      };
    });
    const emit = vi.fn();

    const { runKyreiChat } = await import("./run.js");
    const result = await runKyreiChat({
      emit,
      messages: [{ role: "user", content: "Finish the original task" }],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
    });

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("budget_exceeded");
    expect(emit).toHaveBeenCalledWith({
      type: "message.complete",
      payload: { text: "window reached", status: "budget_exceeded", usage: { totalTokens: 1_000 } },
    });
  });

  it("keeps private recovery markers out of streaming and durable assistant text", async () => {
    streamTextMock
      .mockReturnValueOnce({
        stream: (async function* () {})(),
        responseMessages: Promise.resolve([]),
      })
      .mockReturnValueOnce({
        stream: (async function* () {})(),
        responseMessages: Promise.resolve([]),
      });
    toPartsMock
      .mockReturnValueOnce([{ type: "text", text: "partial KYREI_FAILURE_HANDOFF" }])
      .mockReturnValueOnce([{ type: "text", text: "done" }]);
    bridgeStreamMock
      .mockImplementationOnce(async (_stream, emit: (event: unknown) => void) => {
        emit({ type: "message.delta", payload: { text: "partial KYREI_FAIL" } });
        emit({ type: "message.delta", payload: { text: "URE_HANDOFF" } });
        emit({ type: "message.complete", payload: { text: "partial KYREI_FAILURE_HANDOFF", status: "heal_handoff" } });
        return {
          text: "partial KYREI_FAILURE_HANDOFF",
          parts: [{ type: "text", text: "partial KYREI_FAILURE_HANDOFF" }],
          status: "heal_handoff",
        };
      })
      .mockImplementationOnce(async (_stream, emit: (event: unknown) => void) => {
        emit({ type: "message.delta", payload: { text: "done" } });
        emit({ type: "message.complete", payload: { text: "done", status: "complete" } });
        return { text: "done", parts: [{ type: "text", text: "done" }], status: "complete" };
      });
    const emit = vi.fn();

    const { runKyreiChat } = await import("./run.js");
    const result = await runKyreiChat({
      emit,
      messages: [{ role: "user", content: "Finish the original task" }],
      providerBase: "http://mock",
      apiKey: "key",
      model: "mock-model",
    });

    const visibleText = emit.mock.calls
      .map(([event]) => event?.payload?.text ?? "")
      .join("");
    expect(visibleText).not.toContain("KYREI_FAILURE");
    expect(result.text).toBe("partial done");
    expect(result.parts).toEqual([{ type: "text", text: "partial done" }]);
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
      expect.objectContaining({
        abortSignal: undefined,
        audit,
        sessionId: "session-1",
        sensitiveValues: ["key"],
      }),
    );
    expect(buildWebToolsMock).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      audit,
      sessionId: "session-1",
      signal: undefined,
    }));
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

    expect(buildSystemPromptPartsMock).toHaveBeenCalledWith(expect.objectContaining({ hasBrainTools: true, hasTools: true }));
    expect(openStreamMock).toHaveBeenCalledWith(2, true, expect.any(Function));
  });

  it("runs delegate_read on the active parent model with only read-only tools and preserved Skills", async () => {
    buildToolsMock.mockReturnValueOnce({
      read_file: { name: "read_file" },
      write_file: { name: "write_file" },
      run_command: { name: "run_command" },
      project_index: { name: "project_index" },
      project_map: { name: "project_map" },
    });
    buildWebToolsMock.mockReturnValue({ web_search: { name: "web_search" } });
    buildGBrainToolsMock.mockReturnValueOnce({
      brain_search: { name: "brain_search" },
      brain_capture: { name: "brain_capture" },
    });
    buildSkillToolsMock.mockImplementation((
      _skills: unknown,
      options: { onUsed?: (id: string) => void | Promise<void> },
    ) => ({
      read_skill: {
        name: "read_skill",
        execute: async () => {
          await options.onUsed?.("review");
          return "# Review";
        },
      },
    }));
    generateTextMock.mockImplementationOnce(async (options: Record<string, unknown>) => {
      const onToolExecutionStart = options["onToolExecutionStart"] as (event: unknown) => void;
      const onStepEnd = options["onStepEnd"] as (event: unknown) => void;
      const childReadSkill = (options["tools"] as Record<string, { execute: () => Promise<string> }>)["read_skill"];
      await childReadSkill?.execute();
      onToolExecutionStart({ toolCall: { toolName: "read_file", input: { path: "src/entry.ts" } } });
      onStepEnd({
        stepNumber: 0,
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      });
      return {
        text: "Child evidence",
        steps: [{ text: "Child evidence" }],
        toolCalls: [{}],
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      };
    });

    const controller = new AbortController();
    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const onSkillUsed = vi.fn();
    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: (event: { type: string; payload?: Record<string, unknown> }) => events.push(event),
      messages: [{ role: "user", content: "hi" }],
      providerBase: "http://mock",
      providerProtocol: "openai-chat",
      apiKey: "key",
      model: "mock-model",
      workspace: "/workspace",
      sessionId: "session-delegate",
      abortSignal: controller.signal,
      skills: [
        {
          id: "review",
          name: "Review",
          description: "Inspect code",
          provenance: "project",
          content: "# Review",
        },
      ],
      onSkillUsed,
    });

    expect(buildSkillToolsMock).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining([expect.objectContaining({ id: "review" })]),
      { maxOutputChars: 12_000, onUsed: onSkillUsed },
    );
    expect(buildSkillToolsMock).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining([expect.objectContaining({ id: "review" })]),
      { maxOutputChars: 12_000 },
    );
    const parentOptions = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const parentTools = parentOptions["tools"] as Record<string, unknown>;
    expect(parentTools).toHaveProperty("read_skill");
    expect(parentTools).toHaveProperty("delegate_read");

    const delegate = parentTools["delegate_read"] as {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };
    await expect(
      delegate.execute(
        { tasks: [{ goal: "Find the entry point" }] },
        { toolCallId: "delegate-call", messages: [], abortSignal: controller.signal },
      ),
    ).resolves.toBe("[1] Child evidence");

    const childOptions = generateTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(childOptions["model"]).toBe(parentOptions["model"]);
    expect(childOptions["abortSignal"]).toBeInstanceOf(AbortSignal);
    expect(childOptions["abortSignal"]).not.toBe(controller.signal);
    expect((childOptions["abortSignal"] as AbortSignal).aborted).toBe(false);
    // memory_ask is allowlisted for children when built; mock returns {} so omit it here.
    expect(Object.keys(childOptions["tools"] as Record<string, unknown>).sort()).toEqual([
      "brain_search",
      "project_map",
      "read_file",
      "read_skill",
      "retrieve",
      "web_search",
    ]);
    expect(childOptions["tools"]).not.toHaveProperty("write_file");
    expect(childOptions["tools"]).not.toHaveProperty("run_command");
    expect(childOptions["tools"]).not.toHaveProperty("project_index");
    expect(childOptions["tools"]).not.toHaveProperty("brain_capture");
    expect(childOptions["tools"]).not.toHaveProperty("delegate_read");
    expect(onSkillUsed).not.toHaveBeenCalled();
    expect(isStepCountMock).toHaveBeenCalledWith(8);

    expect(events.find((event) => event.type === "subagent.complete")?.payload).toMatchObject({
      subagent_id: "session:session-delegate:delegate-tool:delegate-call:0",
      model: "mock-model",
      status: "completed",
      input_tokens: 20,
      output_tokens: 5,
      total_tokens: 25,
      tool_count: 1,
      files_read: ["src/entry.ts"],
      files_written: [],
      summary: "Child evidence",
    });
  });

  it("keeps a slow child recoverable until a late provider result arrives", async () => {
    vi.useFakeTimers();
    try {
      resolveEngineConfigMock.mockReturnValueOnce({
        config: engineConfig({ timeoutMs: 1_000 }),
        warnings: [],
      });
      let providerSignal: AbortSignal | undefined;
      let resolveLate: ((value: unknown) => void) | undefined;
      generateTextMock.mockImplementationOnce((options: Record<string, unknown>) => {
        providerSignal = options["abortSignal"] as AbortSignal;
        return new Promise((resolve) => {
          resolveLate = resolve;
        });
      });
      const parent = new AbortController();
      const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
      const { runKyreiChat } = await import("./run.js");
      await runKyreiChat({
        emit: (event: { type: string; payload?: Record<string, unknown> }) => events.push(event),
        messages: [{ role: "user", content: "hi" }],
        providerBase: "http://mock",
        providerProtocol: "openai-chat",
        apiKey: "key",
        model: "mock-model",
        abortSignal: parent.signal,
      });

      const parentOptions = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
      const delegate = (parentOptions["tools"] as Record<string, {
        execute: (input: unknown, options: unknown) => Promise<string>;
      }>)["delegate_read"]!;
      const pending = delegate.execute(
        { tasks: [{ goal: "Inspect a slow endpoint" }] },
        { toolCallId: "delegate-timeout", messages: [], abortSignal: parent.signal },
      );

      await vi.advanceTimersByTimeAsync(1_000);
      expect(parent.signal.aborted).toBe(false);
      expect(providerSignal?.aborted).toBe(false);
      expect(events.find((event) => event.type === "subagent.progress")?.payload).toMatchObject({
        status: "recovering",
      });

      resolveLate?.({ text: "late but valid", steps: [{ text: "late but valid" }], toolCalls: [], usage: {} });
      await vi.runAllTicks();
      await expect(pending).resolves.toBe("[1] late but valid");
      expect(events.some((event) => event.type === "subagent.failed")).toBe(false);
      expect(events.find((event) => event.type === "subagent.complete")?.payload).toMatchObject({
        status: "completed",
        summary: "late but valid",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("pins fallback models to the active provider endpoint", async () => {
    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "hi" }],
      providerBase: "https://active.example/v1",
      providerProtocol: "openai-chat",
      providerId: "active",
      apiKey: "key",
      model: "primary-model",
    });

    expect(resolveModelMock).toHaveBeenCalledWith("fallback-model", {
      baseURL: "https://active.example/v1",
      id: "fallback-model",
      provider: "active",
      protocol: "openai-chat",
    });
  });

  it("routes provider-scoped fallbacks with isolated credentials and reports the winning target", async () => {
    resolveEngineConfigMock.mockReturnValueOnce({
      config: { ...engineConfig(), fallbackChain: [] },
      warnings: [],
    });
    buildModelMock.mockImplementation((options: { model: string }) => ({ builtFor: options.model }));
    buildProviderOptionsMock.mockImplementation((protocol: string) => ({
      [protocol]: { reasoning: "configured" },
    }));
    openStreamMock.mockImplementationOnce(async (
      count: number,
      hasTools: boolean,
      start: (candidate: number, useTools: boolean) => Promise<{ stream: AsyncIterable<unknown>; responseMessages: PromiseLike<unknown[]> }>,
    ) => {
      expect(count).toBe(2);
      await start(0, hasTools);
      return { ...(await start(1, hasTools)), candidateIndex: 1 };
    });

    const { runKyreiChat } = await import("./run.js");
    const result = await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "hi" }],
      providerBase: "https://primary.example/v1",
      providerProtocol: "openai-chat",
      providerId: "primary",
      providerHeaders: { "X-Primary": "primary-header" },
      apiKey: "primary-key",
      providerCredentials: { apiKey: "primary-key" },
      model: "shared-model",
      modelParams: { effort: "high" },
      fallbackProviders: [{
        providerId: "backup",
        accountId: "backup-account",
        protocol: "anthropic-messages",
        baseURL: "https://backup.example/v1",
        model: "shared-model",
        apiKey: "backup-key",
        credentials: { apiKey: "backup-key" },
        headers: { "X-Backup": "backup-header" },
        requiresApiKey: true,
      }],
    });

    expect(buildModelMock).toHaveBeenNthCalledWith(1, {
      protocol: "openai-chat",
      baseURL: "https://primary.example/v1",
      apiKey: "primary-key",
      credentials: { apiKey: "primary-key" },
      model: "shared-model",
      headers: { "X-Primary": "primary-header" },
      identifyEngine: false,
      fetch: expect.any(Function),
    });
    expect(buildModelMock).toHaveBeenNthCalledWith(2, {
      protocol: "anthropic-messages",
      baseURL: "https://backup.example/v1",
      apiKey: "backup-key",
      credentials: { apiKey: "backup-key" },
      model: "shared-model",
      headers: { "X-Backup": "backup-header" },
      identifyEngine: false,
      fetch: expect.any(Function),
    });
    expect(buildProviderOptionsMock).toHaveBeenCalledWith("openai-chat", { effort: "high" });
    expect(buildProviderOptionsMock).toHaveBeenCalledWith("anthropic-messages", { effort: "high" });
    expect(bridgeStreamMock).toHaveBeenCalledWith(expect.anything(), expect.any(Function), expect.objectContaining({
      provider: "backup",
      model: "shared-model",
    }));
    expect(result.route).toEqual({
      providerId: "backup",
      modelId: "shared-model",
      accountId: "backup-account",
    });
  });

  it("keeps same-provider same-model accounts as distinct early-fallback candidates", async () => {
    resolveEngineConfigMock.mockReturnValueOnce({
      config: { ...engineConfig(), fallbackChain: [] },
      warnings: [],
    });
    const acquire = vi.fn((target: { accountId?: string }) => `lease-${target.accountId}`);
    const release = vi.fn();
    openStreamMock.mockImplementationOnce(async (
      count: number,
      hasTools: boolean,
      start: (candidate: number, useTools: boolean) => Promise<{ stream: AsyncIterable<unknown>; responseMessages: PromiseLike<unknown[]> }>,
      options: {
        attemptLifecycle: {
          acquire(candidate: number): unknown | null;
          release(handle: unknown, outcome: {
            candidateIndex: number;
            outcome: "retryable-error" | "success";
            phase: "probe" | "stream";
            statusCode?: number;
            retryAfterMs?: number;
          }): void;
        };
      },
    ) => {
      expect(count).toBe(2);
      const firstHandle = options.attemptLifecycle.acquire(0);
      await start(0, hasTools);
      options.attemptLifecycle.release(firstHandle, {
        candidateIndex: 0,
        outcome: "retryable-error",
        phase: "probe",
        statusCode: 429,
        retryAfterMs: 2_000,
      });
      const secondHandle = options.attemptLifecycle.acquire(1);
      const selected = await start(1, hasTools);
      options.attemptLifecycle.release(secondHandle, {
        candidateIndex: 1,
        outcome: "success",
        phase: "stream",
      });
      return {
        ...selected,
        candidateIndex: 1,
        attempts: [
          { candidateIndex: 0, outcome: "retryable-error", phase: "probe", statusCode: 429, retryAfterMs: 2_000 },
          { candidateIndex: 1, outcome: "success", phase: "stream" },
        ],
      };
    });
    const { runKyreiChat } = await import("./run.js");
    const result = await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "hi" }],
      providerBase: "https://same.example/v1",
      providerProtocol: "openai-chat",
      providerId: "same-provider",
      providerAccountId: "primary",
      apiKey: "primary-secret",
      model: "same-model",
      providerAttemptLifecycle: { acquire, release },
      fallbackProviders: [{
        providerId: "same-provider",
        accountId: "backup",
        protocol: "openai-chat",
        baseURL: "https://same.example/v1",
        model: "same-model",
        apiKey: "backup-secret",
        credentials: { apiKey: "backup-secret" },
        requiresApiKey: true,
      }],
    });
    expect(result.route).toEqual({
      providerId: "same-provider",
      modelId: "same-model",
      accountId: "backup",
    });
    expect(result.status).toBe("complete");
    expect(result.attempts).toEqual([
      {
        providerId: "same-provider",
        accountId: "primary",
        modelId: "same-model",
        outcome: "retryable-error",
        phase: "probe",
        statusCode: 429,
        retryAfterMs: 2_000,
      },
      {
        providerId: "same-provider",
        accountId: "backup",
        modelId: "same-model",
        outcome: "success",
        phase: "stream",
      },
    ]);
    expect(acquire.mock.calls).toEqual([
      [{ providerId: "same-provider", accountId: "primary", modelId: "same-model" }],
      [{ providerId: "same-provider", accountId: "backup", modelId: "same-model" }],
    ]);
    expect(JSON.stringify(acquire.mock.calls)).not.toMatch(/primary-secret|backup-secret|baseURL|credentials|apiKey/);
    expect(release.mock.calls).toEqual([
      ["lease-primary", result.attempts[0]],
      ["lease-backup", result.attempts[1]],
    ]);
  });

  it("preserves a terminal bridge error in the result and its safe attempt outcome", async () => {
    resolveEngineConfigMock.mockReturnValueOnce({
      config: { ...engineConfig(), fallbackChain: [] },
      warnings: [],
    });
    openStreamMock.mockImplementationOnce(async (
      _count: number,
      hasTools: boolean,
      start: (candidate: number, useTools: boolean) => Promise<{ stream: AsyncIterable<unknown>; responseMessages: PromiseLike<unknown[]> }>,
    ) => ({
      ...(await start(0, hasTools)),
      candidateIndex: 0,
      attempts: [{ candidateIndex: 0, outcome: "terminal-error", phase: "probe", statusCode: 401 }],
    }));
    bridgeStreamMock.mockResolvedValueOnce({ text: "", parts: [], status: "error" });

    const { runKyreiChat } = await import("./run.js");
    const result = await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "hi" }],
      providerBase: "https://same.example/v1",
      providerProtocol: "openai-chat",
      providerId: "same-provider",
      providerAccountId: "primary",
      apiKey: "must-not-appear",
      model: "same-model",
    });

    expect(result).toMatchObject({
      status: "error",
      attempts: [{
        providerId: "same-provider",
        accountId: "primary",
        modelId: "same-model",
        outcome: "terminal-error",
        phase: "probe",
        statusCode: 401,
      }],
    });
    expect(JSON.stringify(result)).not.toContain("must-not-appear");
  });

  it("routes read-only delegates through an explicitly configured worker provider", async () => {
    const handle = { lease: "worker-account" };
    const acquire = vi.fn(() => handle);
    const release = vi.fn();
    buildModelMock.mockImplementation((options: { model: string }) => ({ builtFor: options.model }));
    buildProviderOptionsMock.mockImplementation((protocol: string, params?: { effort?: string }) => ({
      [protocol]: { effort: params?.effort ?? "provider-default" },
    }));
    generateTextMock.mockResolvedValue({
      text: "Worker evidence",
      steps: [{ text: "Worker evidence" }],
      toolCalls: [],
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    });

    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "hi" }],
      providerBase: "https://main.example/v1",
      providerProtocol: "openai-chat",
      providerId: "main-provider",
      providerHeaders: { "X-Main": "main-header" },
      apiKey: "main-secret",
      providerCredentials: { apiKey: "main-secret" },
      model: "main-model",
      modelParams: { effort: "high" },
      providerAttemptLifecycle: { acquire, release },
      workerProvider: {
        providerId: "worker-provider",
        accountId: "worker-account",
        protocol: "anthropic-messages",
        baseURL: "https://worker.example/v1",
        model: "worker-model",
        apiKey: "worker-secret",
        credentials: { apiKey: "worker-secret" },
        headers: { "X-Worker": "worker-header" },
        requiresApiKey: true,
      },
    });

    const parentOptions = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const delegate = (parentOptions["tools"] as Record<string, {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    }>)["delegate_read"];
    await delegate.execute(
      { tasks: [{ goal: "Inspect routing" }] },
      { toolCallId: "worker-route", messages: [] },
    );

    expect(buildModelMock).toHaveBeenCalledWith({
      protocol: "openai-chat",
      baseURL: "https://main.example/v1",
      apiKey: "main-secret",
      credentials: { apiKey: "main-secret" },
      model: "main-model",
      headers: { "X-Main": "main-header" },
      identifyEngine: false,
      fetch: expect.any(Function),
    });
    expect(buildModelMock).toHaveBeenCalledWith({
      protocol: "anthropic-messages",
      baseURL: "https://worker.example/v1",
      apiKey: "worker-secret",
      credentials: { apiKey: "worker-secret" },
      model: "worker-model",
      headers: { "X-Worker": "worker-header" },
      identifyEngine: false,
      fetch: expect.any(Function),
    });
    expect(parentOptions["model"]).toEqual({ builtFor: "main-model" });
    const childOptions = generateTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(childOptions["model"]).toEqual({ builtFor: "worker-model" });
    // Mock returns protocol-keyed bags; worker inherits turn effort from modelParams.
    expect(childOptions["providerOptions"]).toEqual({
      "anthropic-messages": { effort: "high" },
    });
    expect(parentOptions["providerOptions"]).toEqual({
      "openai-chat": { effort: "high" },
    });
    expect(buildProviderOptionsMock).toHaveBeenCalledWith("openai-chat", { effort: "high" });
    expect(buildProviderOptionsMock).toHaveBeenCalledWith("anthropic-messages", { effort: "high" });
    expect(acquire).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledWith({
      providerId: "worker-provider",
      accountId: "worker-account",
      modelId: "worker-model",
    });
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(handle, {
      providerId: "worker-provider",
      accountId: "worker-account",
      modelId: "worker-model",
      outcome: "success",
      phase: "stream",
    });
  });

  it("keeps read-only delegates on the active model when no worker provider is configured", async () => {
    buildModelMock.mockImplementation((options: { model: string }) => ({ builtFor: options.model }));
    buildProviderOptionsMock.mockReturnValue({ openai: { reasoningEffort: "medium" } });
    generateTextMock.mockResolvedValue({
      text: "Inherited evidence",
      steps: [{ text: "Inherited evidence" }],
      toolCalls: [],
      usage: {},
    });

    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "hi" }],
      providerBase: "https://main.example/v1",
      providerProtocol: "openai-responses",
      providerId: "main-provider",
      apiKey: "main-secret",
      model: "main-model",
      modelParams: { effort: "medium" },
    });

    const parentOptions = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const delegate = (parentOptions["tools"] as Record<string, {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    }>)["delegate_read"];
    await delegate.execute(
      { tasks: [{ goal: "Inspect inheritance" }] },
      { toolCallId: "worker-inherit", messages: [] },
    );

    const childOptions = generateTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(buildModelMock).toHaveBeenCalledTimes(1);
    expect(childOptions["model"]).toBe(parentOptions["model"]);
    expect(childOptions["providerOptions"]).toBe(parentOptions["providerOptions"]);
  });

  it("runs configured Team roles on isolated provider targets with role-scoped tools and skills", async () => {
    const acquire = vi.fn((target: { accountId?: string }) => ({ lease: target.accountId }));
    const release = vi.fn();
    buildToolsMock.mockReturnValueOnce({
      read_file: { name: "read_file" },
      write_file: { name: "write_file" },
      run_command: { name: "run_command" },
    });
    buildWebToolsMock.mockReturnValue({ web_search: { name: "web_search" } });
    buildGBrainToolsMock.mockReturnValueOnce({ brain_search: { name: "brain_search" } });
    buildSkillToolsMock.mockImplementation((skills: Array<{ id: string }>) => (
      skills.length ? { read_skill: { name: `read_skill:${skills.map((skill) => skill.id).join(",")}` } } : {}
    ));
    buildModelMock.mockImplementation((options: { model: string; baseURL: string }) => ({
      builtFor: options.model,
      endpoint: options.baseURL,
    }));
    generateTextMock.mockImplementation(async (options: Record<string, unknown>) => ({
      text: `<team_artifact>{"summary":"Evidence from ${(options["model"] as { builtFor: string }).builtFor}","confidence":0.9,"evidence":["checked"],"validation":[],"uncertainties":[],"whatWasNotChecked":[],"provenance":[]}</team_artifact>`,
      steps: [],
      toolCalls: [],
      usage: {},
    }));

    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: (event: { type: string; payload?: Record<string, unknown> }) => events.push(event),
      messages: [{ role: "user", content: "Review the project" }],
      providerBase: "https://main.example/v1",
      providerProtocol: "openai-chat",
      providerId: "main",
      apiKey: "main-secret",
      model: "main-model",
      providerAttemptLifecycle: { acquire, release },
      workspace: "/workspace",
      skills: [
        { id: "review", name: "Review", description: "Review code", provenance: "project", content: "# Review" },
        { id: "research", name: "Research", description: "Search sources", provenance: "global", content: "# Research" },
      ],
      team: {
        profileId: "core-team",
        name: "Core team",
        workflow: "supervisor",
        limits: {
          maxParallel: 2,
          maxDepth: 1,
          maxAgents: 4,
          maxTasks: 4,
          maxStepsPerAgent: 5,
          timeoutMs: 30_000,
        },
        roles: [
          {
            id: "reviewer",
            name: "Reviewer",
            target: {
              providerId: "anthropic-worker",
              accountId: "review-account",
              protocol: "anthropic-messages",
              baseURL: "https://anthropic.example/v1",
              model: "claude-worker",
              apiKey: "anthropic-secret",
              credentials: { apiKey: "anthropic-secret" },
              headers: { "X-Worker": "reviewer" },
              limits: { contextWindow: 42_000, maxOutput: 3_333 },
            },
            skillIds: ["review"],
            capabilities: ["workspace.read", "skills.read"],
            canSpawn: false,
            maxChildren: 0,
          },
          {
            id: "researcher",
            name: "Researcher",
            target: {
              providerId: "search-worker",
              accountId: "research-account",
              protocol: "openai-chat",
              baseURL: "https://search.example/v1",
              model: "search-model",
              apiKey: "search-secret",
            },
            skillIds: ["research"],
            capabilities: ["web"],
            canSpawn: false,
            maxChildren: 0,
          },
        ],
      },
    });

    const parentOptions = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const team = (parentOptions["tools"] as Record<string, {
      execute: (input: unknown, options: unknown) => Promise<string>;
    }>)["team_delegate"];
    expect(team).toBeDefined();
    const result = JSON.parse(await team.execute({
      tasks: [
        { id: "review", goal: "Review code", memberId: "reviewer" },
        { id: "research", goal: "Find docs", memberId: "researcher" },
      ],
    }, { toolCallId: "team-call", messages: [] }));

    expect(result.tasks).toEqual([
      expect.objectContaining({ id: "review", status: "succeeded" }),
      expect.objectContaining({ id: "research", status: "succeeded" }),
    ]);
    expect(buildModelMock).toHaveBeenCalledWith(expect.objectContaining({
      protocol: "anthropic-messages",
      baseURL: "https://anthropic.example/v1",
      apiKey: "anthropic-secret",
      credentials: { apiKey: "anthropic-secret" },
      model: "claude-worker",
      headers: { "X-Worker": "reviewer" },
    }));
    expect(buildModelMock).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: "https://search.example/v1",
      apiKey: "search-secret",
      model: "search-model",
    }));
    expect(buildSystemPromptPartsMock).toHaveBeenCalledWith(expect.objectContaining({
      team: {
        name: "Core team",
        workflow: "supervisor",
        roles: [
          expect.objectContaining({ id: "reviewer", model: "anthropic-worker/claude-worker" }),
          expect.objectContaining({ id: "researcher", model: "search-worker/search-model" }),
        ],
      },
    }));
    const reviewerCall = generateTextMock.mock.calls.find(
      ([options]) => (options as { model?: { builtFor?: string } }).model?.builtFor === "claude-worker",
    )?.[0] as Record<string, unknown>;
    const researcherCall = generateTextMock.mock.calls.find(
      ([options]) => (options as { model?: { builtFor?: string } }).model?.builtFor === "search-model",
    )?.[0] as Record<string, unknown>;
    expect(Object.keys(reviewerCall["tools"] as Record<string, unknown>).sort()).toEqual([
      "read_file",
      "read_skill",
      "retrieve",
    ]);
    expect(Object.keys(researcherCall["tools"] as Record<string, unknown>)).toEqual(["web_search"]);
    expect(reviewerCall["tools"]).not.toHaveProperty("write_file");
    expect(reviewerCall["tools"]).not.toHaveProperty("run_command");
    expect(reviewerCall).toMatchObject({ maxOutputTokens: 3_333 });
    expect(String(reviewerCall["instructions"])).toContain("PROJECT_CTX");
    expect(String(researcherCall["instructions"])).not.toContain("PROJECT_CTX");
    expect(String(researcherCall["instructions"])).toContain("Workspace boundary: not selected");
    expect(events.filter((event) => event.type === "subagent.complete").map((event) => event.payload?.provider_id).sort())
      .toEqual(["anthropic-worker", "search-worker"]);
    expect(events.at(-1)).toMatchObject({ type: "team.complete", payload: { status: "completed" } });
    expect(acquire.mock.calls).toEqual(expect.arrayContaining([
      [{ providerId: "anthropic-worker", accountId: "review-account", modelId: "claude-worker" }],
      [{ providerId: "search-worker", accountId: "research-account", modelId: "search-model" }],
    ]));
    expect(release).toHaveBeenCalledTimes(2);
    expect(release.mock.calls.map(([, outcome]) => outcome)).toEqual(expect.arrayContaining([
      {
        providerId: "anthropic-worker",
        accountId: "review-account",
        modelId: "claude-worker",
        outcome: "success",
        phase: "stream",
      },
      {
        providerId: "search-worker",
        accountId: "research-account",
        modelId: "search-model",
        outcome: "success",
        phase: "stream",
      },
    ]));
  });

  it("gives memory-reading Team roles the parent built-in memory directory", async () => {
    const config = engineConfig();
    config.memory.gbrain = {
      provider: "builtin",
      mode: "read",
      timeoutMs: 30_000,
      maxOutputBytes: 200_000,
    };
    resolveEngineConfigMock.mockReturnValue({ config, warnings: [] });
    buildGBrainToolsMock.mockReturnValue({ brain_search: { name: "brain_search" } });
    buildModelMock.mockImplementation((options: { model: string }) => ({ builtFor: options.model }));
    generateTextMock.mockResolvedValue({
      text: '<team_artifact>{"summary":"memory checked","confidence":0.9,"evidence":["local store"],"validation":[],"uncertainties":[],"whatWasNotChecked":[],"provenance":[]}</team_artifact>',
      steps: [],
      toolCalls: [],
      usage: {},
    });

    const { runKyreiChat } = await import("./run.js");
    await runKyreiChat({
      emit: () => {},
      messages: [{ role: "user", content: "Check personal memory" }],
      providerBase: "https://main.example/v1",
      providerProtocol: "openai-chat",
      providerId: "main",
      apiKey: "main-secret",
      model: "main-model",
      globalMemoryDir: "/profile/kyrei-memory",
      team: {
        profileId: "memory-team",
        name: "Memory team",
        workflow: "supervisor",
        limits: { maxParallel: 1, maxDepth: 0, maxAgents: 1, maxTasks: 1, maxStepsPerAgent: 2, timeoutMs: 30_000 },
        roles: [{
          id: "memory-reader",
          name: "Memory reader",
          target: {
            providerId: "memory-worker",
            protocol: "openai-chat",
            baseURL: "https://worker.example/v1",
            model: "worker-model",
            apiKey: "worker-secret",
          },
          skillIds: [],
          capabilities: ["memory.read"],
          canSpawn: false,
          maxChildren: 0,
        }],
      },
    });

    const parentOptions = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const team = (parentOptions.tools as Record<string, {
      execute: (input: unknown, options: unknown) => Promise<string>;
    }>).team_delegate;
    await team.execute({ tasks: [{ id: "memory", goal: "Search local memory", memberId: "memory-reader" }] }, {
      toolCallId: "team-memory", messages: [],
    });

    expect(buildGBrainToolsMock.mock.calls).toEqual(expect.arrayContaining([
      [
        expect.objectContaining({ provider: "builtin", mode: "read" }),
        expect.objectContaining({ dataDir: "/profile/kyrei-memory" }),
      ],
    ]));
    expect(buildGBrainToolsMock.mock.calls.length).toBeGreaterThan(1);
    expect(buildGBrainToolsMock.mock.calls.every(([, options]) => (
      (options as { dataDir?: string }).dataDir === "/profile/kyrei-memory"
    ))).toBe(true);
  });
});
