import { beforeEach, describe, expect, it, vi } from "vitest";

const streamTextMock = vi.fn();
const generateTextMock = vi.fn();
const isStepCountMock = vi.fn((steps: number) => ({ steps }));
const assembleSystemContextMock = vi.fn();
const buildSystemPromptMock = vi.fn(() => "system prompt");
const isWorkspaceDirMock = vi.fn();
const openStreamMock = vi.fn();
const bridgeStreamMock = vi.fn();
const buildToolsMock = vi.fn();
const resolveModelMock = vi.fn();
const buildGBrainToolsMock = vi.fn();
const buildSkillToolsMock = vi.fn();
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
  tool: (definition: unknown) => definition,
}));

vi.mock("../config/schema.js", () => ({
  resolveEngineConfig: resolveEngineConfigMock,
}));

vi.mock("../provider/build.js", () => ({
  buildModel: buildModelMock,
  buildProviderOptions: buildProviderOptionsMock,
  hasProviderCredentials: () => true,
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

vi.mock("../tools/skills.js", () => ({
  buildSkillTools: buildSkillToolsMock,
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

function engineConfig(delegation: Partial<{ enabled: boolean; maxTasks: number; maxParallel: number; maxSteps: number }> = {}) {
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
    delegation: { enabled: true, maxTasks: 3, maxParallel: 2, maxSteps: 8, ...delegation },
    memory: {
      gbrain: { mode: "off", command: "gbrain", timeoutMs: 180_000, maxOutputBytes: 200_000 },
    },
  };
}

describe("runKyreiChat project context wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    buildSystemPromptMock.mockReturnValue("system prompt");
    buildToolsMock.mockReturnValue({ read_file: { name: "read_file" } });
    buildGBrainToolsMock.mockReturnValue({});
    buildWebToolsMock.mockReturnValue({});
    buildSkillToolsMock.mockReturnValue({});
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
    openStreamMock.mockImplementation(async (_count: number, hasTools: boolean, start: (ci: number, useTools: boolean) => unknown) => start(0, hasTools));
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
      start: (ci: number, useTools: boolean) => { stream: AsyncIterable<unknown>; responseMessages: PromiseLike<unknown[]> },
    ) => {
      start(0, hasTools);
      return { ...start(1, hasTools), candidateIndex: 1 };
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

    expect(makePrepareStepMock).toHaveBeenNthCalledWith(1, expect.anything(), "mock-model", 96_000, expect.anything());
    expect(makePrepareStepMock).toHaveBeenNthCalledWith(2, expect.anything(), "fallback-model", 128_000, expect.anything());
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
      start: (ci: number, useTools: boolean) => { stream: AsyncIterable<unknown>; responseMessages: PromiseLike<unknown[]> },
    ) => {
      start(0, hasTools);
      return { ...start(1, hasTools), candidateIndex: 1 };
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

    expect(makePrepareStepMock).toHaveBeenNthCalledWith(1, expect.anything(), "primary-model", 90_000, expect.anything());
    expect(makePrepareStepMock).toHaveBeenNthCalledWith(2, expect.anything(), "fallback-model", 40_000, expect.anything());
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

    expect(makePrepareStepMock).toHaveBeenCalledWith(expect.anything(), "mock-model", 128_000, expect.anything());
    expect(streamTextMock.mock.calls[0]?.[0]).toMatchObject({ maxOutputTokens: 8_192 });
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
    ).resolves.toEqual({
      text: "ok",
      parts: [],
      status: "complete",
      attempts: [],
      route: { providerId: "mock-provider", modelId: "mock-model" },
    });

    expect(buildSystemPromptMock).toHaveBeenCalledWith(
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
    expect(buildSystemPromptMock).toHaveBeenCalledWith(
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

    expect(buildSystemPromptMock).toHaveBeenCalledWith(
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

    expect(buildSystemPromptMock).toHaveBeenCalledWith(expect.objectContaining({ hasBrainTools: true, hasTools: true }));
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
    expect(childOptions["abortSignal"]).toBe(controller.signal);
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
      start: (candidate: number, useTools: boolean) => { stream: AsyncIterable<unknown>; responseMessages: PromiseLike<unknown[]> },
    ) => {
      expect(count).toBe(2);
      start(0, hasTools);
      return { ...start(1, hasTools), candidateIndex: 1 };
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
    });
    expect(buildModelMock).toHaveBeenNthCalledWith(2, {
      protocol: "anthropic-messages",
      baseURL: "https://backup.example/v1",
      apiKey: "backup-key",
      credentials: { apiKey: "backup-key" },
      model: "shared-model",
      headers: { "X-Backup": "backup-header" },
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
      start: (candidate: number, useTools: boolean) => { stream: AsyncIterable<unknown>; responseMessages: PromiseLike<unknown[]> },
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
      start(0, hasTools);
      options.attemptLifecycle.release(firstHandle, {
        candidateIndex: 0,
        outcome: "retryable-error",
        phase: "probe",
        statusCode: 429,
        retryAfterMs: 2_000,
      });
      const secondHandle = options.attemptLifecycle.acquire(1);
      const selected = start(1, hasTools);
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
      start: (candidate: number, useTools: boolean) => { stream: AsyncIterable<unknown>; responseMessages: PromiseLike<unknown[]> },
    ) => ({
      ...start(0, hasTools),
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
    });
    expect(buildModelMock).toHaveBeenCalledWith({
      protocol: "anthropic-messages",
      baseURL: "https://worker.example/v1",
      apiKey: "worker-secret",
      credentials: { apiKey: "worker-secret" },
      model: "worker-model",
      headers: { "X-Worker": "worker-header" },
    });
    expect(parentOptions["model"]).toEqual({ builtFor: "main-model" });
    const childOptions = generateTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(childOptions["model"]).toEqual({ builtFor: "worker-model" });
    expect(childOptions["providerOptions"]).toEqual({
      "anthropic-messages": { effort: "provider-default" },
    });
    expect(parentOptions["providerOptions"]).toEqual({
      "openai-chat": { effort: "high" },
    });
    expect(buildProviderOptionsMock).toHaveBeenCalledWith("openai-chat", { effort: "high" });
    expect(buildProviderOptionsMock).toHaveBeenCalledWith("anthropic-messages", undefined);
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
    expect(buildSystemPromptMock).toHaveBeenCalledWith(expect.objectContaining({
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
});
