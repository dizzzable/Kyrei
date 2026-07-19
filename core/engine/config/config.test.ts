import { describe, it, expect } from "vitest";
import { resolveEngineConfig } from "./schema.js";
import { DEFAULT_ENGINE_CONFIG } from "../types.js";

describe("resolveEngineConfig (task 2.6)", () => {
  it("returns full defaults for empty/undefined input", () => {
    expect(resolveEngineConfig().config).toEqual(DEFAULT_ENGINE_CONFIG);
    expect(resolveEngineConfig({}).config).toEqual(DEFAULT_ENGINE_CONFIG);
    expect(resolveEngineConfig().warnings).toHaveLength(0);
  });

  it("merges a partial config over defaults", () => {
    const { config } = resolveEngineConfig({ maxSteps: 20, fallbackChain: ["small"] });
    expect(config.maxSteps).toBe(20);
    expect(config.fallbackChain).toEqual(["small"]);
    expect(config.commandTimeoutMs).toBe(DEFAULT_ENGINE_CONFIG.commandTimeoutMs);
  });

  it("normalizes bounded prompt profiles and reconciles the active main-agent assignment", () => {
    const { config } = resolveEngineConfig({
      promptProfiles: [{
        id: "coding-lead",
        name: "Coding lead",
        description: "Plans and verifies changes",
        systemPrompt: "Prefer evidence and focused patches.",
        ignoredSecretCarrier: "discarded",
      }],
      activePromptProfileId: "coding-lead",
    });
    expect(config.promptProfiles).toEqual([{
      id: "coding-lead",
      name: "Coding lead",
      description: "Plans and verifies changes",
      systemPrompt: "Prefer evidence and focused patches.",
    }]);
    expect(config.activePromptProfileId).toBe("coding-lead");
    expect(resolveEngineConfig({
      promptProfiles: config.promptProfiles,
      activePromptProfileId: "missing",
    }).config.activePromptProfileId).toBe("");
  });

  it("drops malformed prompt-profile collections instead of accepting unsafe controls", () => {
    const { config, warnings } = resolveEngineConfig({
      maxSteps: 20,
      promptProfiles: [{ id: "unsafe", name: "Unsafe", systemPrompt: "line one\u0000line two" }],
      activePromptProfileId: "unsafe",
    });
    expect(config.maxSteps).toBe(20);
    expect(config.promptProfiles).toEqual([]);
    expect(config.activePromptProfileId).toBe("");
    expect(warnings.some((warning) => warning.includes("promptProfiles"))).toBe(true);
  });

  it("preserves the fail-closed sandbox admission mode", () => {
    expect(resolveEngineConfig({ sandbox: "strict-required" }).config.sandbox).toBe("strict-required");
  });

  it("validates bounded read-only delegation settings", () => {
    const { config } = resolveEngineConfig({
      delegation: { enabled: false, maxTasks: 6, maxParallel: 2, maxSteps: 12, timeoutMs: 45_000 },
    });
    expect(config.delegation).toEqual({
      enabled: false,
      maxTasks: 6,
      maxParallel: 2,
      maxSteps: 12,
      timeoutMs: 45_000,
      idleTimeoutMs: 45_000,
      maxRuntimeMs: DEFAULT_ENGINE_CONFIG.delegation.maxRuntimeMs,
    });
  });

  it("keeps evolution proposal-first and bounded by default", () => {
    expect(resolveEngineConfig({}).config.evolution).toEqual({
      harvestEnabled: true,
      evaluationEnabled: false,
      promotionMode: "manual",
      maxCandidates: 500,
      retentionDays: 180,
      maxEvaluationCostUsd: null,
    });
    expect(resolveEngineConfig({ evolution: {
      harvestEnabled: false,
      evaluationEnabled: true,
      promotionMode: "low-risk-canary",
      maxCandidates: 80,
      retentionDays: 30,
      maxEvaluationCostUsd: 2,
    } }).config.evolution).toMatchObject({
      harvestEnabled: false,
      evaluationEnabled: true,
      promotionMode: "low-risk-canary",
      maxCandidates: 80,
      retentionDays: 30,
      maxEvaluationCostUsd: 2,
    });
  });

  it("normalizes explicit child idle and max-runtime limits", () => {
    const { config, warnings } = resolveEngineConfig({
      delegation: { timeoutMs: 45_000, idleTimeoutMs: 60_000, maxRuntimeMs: 30_000 },
    });
    expect(config.delegation).toEqual({
      ...DEFAULT_ENGINE_CONFIG.delegation,
      timeoutMs: 60_000,
      idleTimeoutMs: 60_000,
      maxRuntimeMs: 60_000,
    });
    expect(warnings.some((warning) => warning.includes("legacy alias"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("maxRuntimeMs < idleTimeoutMs"))).toBe(true);
  });

  it("preserves advisory delegation leases up to one hour", () => {
    const { config, warnings } = resolveEngineConfig({
      delegation: { timeoutMs: 3_600_000, idleTimeoutMs: 3_600_000, maxRuntimeMs: 7_200_000 },
    });

    expect(config.delegation).toMatchObject({
      timeoutMs: 3_600_000,
      idleTimeoutMs: 3_600_000,
      maxRuntimeMs: 7_200_000,
    });
    expect(warnings).not.toContain(expect.stringContaining("delegation.idleTimeoutMs"));
  });

  it("migrates the legacy 90-second child cutoff without shrinking the hard runtime", () => {
    const { config, warnings } = resolveEngineConfig({
      delegation: { timeoutMs: 90_000 },
    });

    expect(config.delegation).toMatchObject({
      timeoutMs: 180_000,
      idleTimeoutMs: 180_000,
      maxRuntimeMs: DEFAULT_ENGINE_CONFIG.delegation.maxRuntimeMs,
    });
    expect(warnings.some((warning) => warning.includes("90-second delegation cutoff"))).toBe(true);
  });

  it("rejects delegation leases outside the supported observation range", () => {
    const tooShort = resolveEngineConfig({ delegation: { timeoutMs: 999 } });
    const tooLong = resolveEngineConfig({ delegation: { timeoutMs: 3_600_001 } });

    expect(tooShort.config.delegation).toEqual(DEFAULT_ENGINE_CONFIG.delegation);
    expect(tooLong.config.delegation).toEqual(DEFAULT_ENGINE_CONFIG.delegation);
    expect(tooShort.warnings.some((warning) => warning.includes("delegation.timeoutMs"))).toBe(true);
    expect(tooLong.warnings.some((warning) => warning.includes("delegation.timeoutMs"))).toBe(true);
  });

  it("clamps delegation parallelism to the accepted task count", () => {
    const { config, warnings } = resolveEngineConfig({
      delegation: { maxTasks: 2, maxParallel: 6 },
    });
    expect(config.delegation).toEqual({
      ...DEFAULT_ENGINE_CONFIG.delegation,
      maxTasks: 2,
      maxParallel: 2,
    });
    expect(warnings.some((warning) => warning.includes("maxParallel"))).toBe(true);
  });

  it("migrates Hermes delegation concurrency into both bounded Kyrei limits", () => {
    const { config, warnings } = resolveEngineConfig({
      delegation: { max_concurrent_children: 4 },
    });
    expect(config.delegation).toEqual({
      ...DEFAULT_ENGINE_CONFIG.delegation,
      maxTasks: 4,
      maxParallel: 4,
    });
    expect(warnings.some((warning) => warning.includes("max_concurrent_children"))).toBe(true);
  });

  it("validates optional GBrain settings without enabling them by default", () => {
    expect(resolveEngineConfig().config.memory.gbrain).toEqual(DEFAULT_ENGINE_CONFIG.memory.gbrain);
    const { config } = resolveEngineConfig({
      memory: { gbrain: { mode: "read", command: "gbrain-local", source: "personal", timeoutMs: 30_000 } },
    });
    expect(config.memory.gbrain).toEqual({
      provider: "external-cli",
      mode: "read",
      command: "gbrain-local",
      source: "personal",
      timeoutMs: 30_000,
      maxOutputBytes: DEFAULT_ENGINE_CONFIG.memory.gbrain.maxOutputBytes,
    });
  });

  it("preserves Streamable HTTP MCP servers instead of treating them as malformed stdio", () => {
    const { config, warnings } = resolveEngineConfig({
      mcp: {
        enabled: true,
        servers: [{
          id: "remote-tools",
          transport: "streamable-http",
          url: "https://mcp.example.test/v1",
          headers: { "X-Workspace": "kyrei" },
        }],
      },
    });

    expect(warnings).toEqual([]);
    expect(config.mcp).toMatchObject({
      enabled: true,
      servers: [{
        id: "remote-tools",
        transport: "streamable-http",
        url: "https://mcp.example.test/v1",
        headers: { "X-Workspace": "kyrei" },
      }],
    });
  });

  it("keeps MCP enabled when a stdio launcher has a long but valid argument", () => {
    const launcher = "x".repeat(2_048);
    const { config, warnings } = resolveEngineConfig({
      mcp: {
        enabled: true,
        servers: [{ id: "local-bridge", transport: "stdio", command: "node", args: ["-e", launcher] }],
      },
    });

    expect(warnings).toEqual([]);
    expect(config.mcp).toMatchObject({
      enabled: true,
      servers: [{ id: "local-bridge", command: "node", args: ["-e", launcher] }],
    });
  });

  it("treats an empty GBrain source field as unset", () => {
    const { config, warnings } = resolveEngineConfig({ memory: { gbrain: { mode: "read", source: "" } } });
    expect(config.memory.gbrain.mode).toBe("read");
    expect(config.memory.gbrain.source).toBeUndefined();
    expect(warnings).toContain("migrated default GBrain setup to built-in Kyrei Memory");
  });

  it("validates nested permissions", () => {
    const { config } = resolveEngineConfig({
      permissions: { terminal: "turbo", review: "always", rules: [{ pattern: "rm *", action: "deny" }] },
    });
    expect(config.permissions.terminal).toBe("turbo");
    expect(config.permissions.rules[0]).toEqual({ pattern: "rm *", action: "deny" });
  });

  it("drops legacy provider role aliases that never had runtime consumers", () => {
    const { config, warnings } = resolveEngineConfig({
      providerRoles: { default: "gpt", small: "mini", plan: "o1" },
    });
    expect(config).not.toHaveProperty("providerRoles");
    expect(warnings.some((warning) => warning.includes("providerRoles"))).toBe(true);
  });

  it("drops an invalid field and keeps valid ones (fail-open, never throws)", () => {
    const { config, warnings } = resolveEngineConfig({ maxSteps: 9999, fallbackChain: ["a"] });
    // 9999 exceeds max(200) → dropped to default; fallbackChain preserved.
    expect(config.maxSteps).toBe(DEFAULT_ENGINE_CONFIG.maxSteps);
    expect(config.fallbackChain).toEqual(["a"]);
    expect(warnings.some((w) => w.includes("maxSteps"))).toBe(true);
  });

  it("rejects invalid enum values without throwing", () => {
    const { config } = resolveEngineConfig({ permissions: { terminal: "yolo" } });
    expect(config.permissions.terminal).toBe("off");
  });

  it("salvages valid permission fields and rules when a sibling is malformed", () => {
    const { config, warnings } = resolveEngineConfig({
      permissions: {
        terminal: "off",
        web: "search",
        review: "sometimes",
        rules: [
          { pattern: "run_command:rm", action: "deny" },
          { pattern: "write_file:secrets", action: "maybe" },
        ],
      },
    });

    expect(config.permissions).toEqual({
      terminal: "off",
      web: "search",
      review: "always",
      rules: [
        { pattern: "run_command:rm", action: "deny" },
        { pattern: "write_file:secrets", action: "deny" },
      ],
      protectedPaths: DEFAULT_ENGINE_CONFIG.permissions.protectedPaths,
    });
    expect(warnings.some((warning) => warning.includes("permissions.review"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("rules.1.action"))).toBe(true);
  });

  it("turns a rule with an unusable pattern into deny-all instead of dropping sibling rules", () => {
    const { config, warnings } = resolveEngineConfig({
      permissions: {
        rules: [
          { pattern: "web_fetch:trusted", action: "allow" },
          { pattern: "[", action: "deny" },
        ],
      },
    });

    expect(config.permissions.rules).toEqual([
      { pattern: "web_fetch:trusted", action: "allow" },
      { pattern: ".*", action: "deny" },
    ]);
    expect(warnings.some((warning) => warning.includes("rules.1"))).toBe(true);
  });

  it("fails closed for unknown terminal, review, and web policies", () => {
    const { config, warnings } = resolveEngineConfig({
      permissions: { terminal: "yolo", review: "never", web: "unrestricted" },
    });

    expect(config.permissions.terminal).toBe("off");
    expect(config.permissions.review).toBe("always");
    expect(config.permissions.web).toBe("off");
    expect(warnings.filter((warning) => warning.includes("invalid security value"))).toHaveLength(3);
  });

  it("enforces softPct < hardPct invariant", () => {
    const { config, warnings } = resolveEngineConfig({ contextBudget: { softPct: 0.95, hardPct: 0.9 } });
    expect(config.contextBudget).toEqual(DEFAULT_ENGINE_CONFIG.contextBudget);
    expect(warnings.some((w) => w.includes("softPct"))).toBe(true);
  });

  it("migrates legacy 'autonomy' → permissions.terminal", () => {
    const { config, warnings } = resolveEngineConfig({ autonomy: "turbo" });
    expect(config.permissions.terminal).toBe("turbo");
    expect(warnings.some((w) => w.includes("autonomy"))).toBe(true);
  });

  it("migrates legacy 'maxToolCalls' → maxSteps", () => {
    const { config, warnings } = resolveEngineConfig({ maxToolCalls: 30 });
    expect(config.maxSteps).toBe(30);
    expect(warnings.some((w) => w.includes("maxToolCalls"))).toBe(true);
  });

  it("migrates Hermes nested agent aliases and snake_case file read limit", () => {
    const { config, warnings } = resolveEngineConfig({
      agent: { max_turns: 21, api_max_retries: 4 },
      file_read_max_chars: 345678,
    });
    expect(config.maxSteps).toBe(21);
    expect(config.apiMaxRetries).toBe(4);
    expect(config.fileReadMaxChars).toBe(345678);
    expect(warnings.some((w) => w.includes("agent.max_turns"))).toBe(true);
    expect(warnings.some((w) => w.includes("agent.api_max_retries"))).toBe(true);
    expect(warnings.some((w) => w.includes("file_read_max_chars"))).toBe(true);
  });

  it("migrates Hermes tool_output, terminal timeout, compression, tool_loop, reasoning", () => {
    const { config, warnings } = resolveEngineConfig({
      agent: { reasoning_effort: "xhigh", image_input_mode: "native" },
      tool_output: { max_bytes: 50_000 },
      terminal: { timeout: 180 },
      compression: { enabled: true, threshold: 0.25, protect_last_n: 20 },
      tool_loop_guardrails: {
        hard_stop_enabled: false,
        hard_stop_after: { exact_failure: 5, idempotent_no_progress: 4 },
      },
      timezone: "Europe/Moscow",
    });
    expect(config.defaultReasoningEffort).toBe("xhigh");
    expect(config.imageInputMode).toBe("native");
    expect(config.maxToolOutput).toBe(50_000);
    expect(config.commandTimeoutMs).toBe(180_000);
    expect(config.compression.protectLastN).toBe(20);
    expect(config.compression.enabled).toBe(true);
    expect(config.contextBudget.softPct).toBeCloseTo(0.75, 5);
    expect(config.reliability.toolLoop.hardStopEnabled).toBe(false);
    expect(config.reliability.toolLoop.repeatedCallThreshold).toBe(4);
    expect(config.reliability.toolLoop.healAfterFailures).toBe(5);
    expect(config.timezone).toBe("Europe/Moscow");
    expect(warnings.some((w) => w.includes("tool_output"))).toBe(true);
    expect(warnings.some((w) => w.includes("terminal.timeout"))).toBe(true);
    expect(warnings.some((w) => w.includes("compression"))).toBe(true);
    expect(warnings.some((w) => w.includes("tool_loop_guardrails"))).toBe(true);
    expect(warnings.some((w) => w.includes("reasoning_effort"))).toBe(true);
    expect(warnings.some((w) => w.includes("image_input_mode"))).toBe(true);
  });

  it("preserves current field precedence over Hermes aliases", () => {
    const { config, warnings } = resolveEngineConfig({
      maxSteps: 9,
      apiMaxRetries: 1,
      fileReadMaxChars: 111111,
      agent: { max_turns: 21, api_max_retries: 4 },
      file_read_max_chars: 345678,
    });
    expect(config.maxSteps).toBe(9);
    expect(config.apiMaxRetries).toBe(1);
    expect(config.fileReadMaxChars).toBe(111111);
    expect(warnings.some((w) => w.includes("agent.max_turns"))).toBe(false);
    expect(warnings.some((w) => w.includes("agent.api_max_retries"))).toBe(false);
    expect(warnings.some((w) => w.includes("file_read_max_chars"))).toBe(false);
  });

  it("ignores malformed Hermes alias shapes without throwing", () => {
    const { config, warnings } = resolveEngineConfig({
      agent: "turbo",
      file_read_max_chars: "a lot",
      fallbackChain: ["mini"],
    });
    expect(config.maxSteps).toBe(DEFAULT_ENGINE_CONFIG.maxSteps);
    expect(config.apiMaxRetries).toBe(DEFAULT_ENGINE_CONFIG.apiMaxRetries);
    expect(config.fileReadMaxChars).toBe(DEFAULT_ENGINE_CONFIG.fileReadMaxChars);
    expect(config.fallbackChain).toEqual(["mini"]);
    expect(warnings).toEqual([]);
  });

  it("never throws on garbage input", () => {
    expect(() => resolveEngineConfig(42)).not.toThrow();
    expect(() => resolveEngineConfig("nonsense")).not.toThrow();
    expect(() => resolveEngineConfig([1, 2, 3])).not.toThrow();
    expect(resolveEngineConfig(42).config).toEqual(DEFAULT_ENGINE_CONFIG);
  });
});
