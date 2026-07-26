import { describe, it, expect } from "vitest";
import { resolveEngineConfig } from "./schema.js";
import { DEFAULT_ENGINE_CONFIG } from "../types.js";

describe("resolveEngineConfig (task 2.6)", () => {
  it("returns full defaults for empty/undefined input", () => {
    expect(resolveEngineConfig().config).toEqual(DEFAULT_ENGINE_CONFIG);
    expect(resolveEngineConfig({}).config).toEqual(DEFAULT_ENGINE_CONFIG);
    expect(resolveEngineConfig().warnings).toHaveLength(0);
  });

  it("enables LLM compaction summary by default", () => {
    expect(resolveEngineConfig({}).config.compression.summaryUseLlm).toBe(true);
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
    const { config, warnings, rejections } = resolveEngineConfig({
      delegation: { timeoutMs: 45_000, idleTimeoutMs: 60_000, maxRuntimeMs: 30_000 },
    });
    expect(config.delegation).toEqual({
      ...DEFAULT_ENGINE_CONFIG.delegation,
      timeoutMs: 60_000,
      idleTimeoutMs: 60_000,
      maxRuntimeMs: 60_000,
    });
    expect(warnings.some((warning) => warning.includes("legacy alias"))).toBe(true);
    // The clamp is a REJECTION — the configured 30s is not in force — so it has
    // to reach the user, not just the log. The alias rename is not: the value
    // the user set still applies under its current name.
    expect(rejections).toEqual([
      { path: "delegation.maxRuntimeMs", message: expect.stringContaining("idleTimeoutMs") },
    ]);
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

  it("preserves OpenViking apiKey and allowRemote so a remote/authed server is reachable", () => {
    const { config } = resolveEngineConfig({
      memory: {
        openviking: {
          enabled: true,
          baseURL: "https://viking.example.test",
          apiKey: "ov-secret-key",
          allowRemote: true,
        },
      },
    });
    expect(config.memory.openviking).toEqual({
      enabled: true,
      baseURL: "https://viking.example.test",
      apiKey: "ov-secret-key",
      allowRemote: true,
    });
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

  describe("rejections are separated from migration notices", () => {
    // `warnings` is the full diagnostic log and is dominated by successful
    // migrations, which are noise to a user. `rejections` carries only the
    // settings that were REFUSED, so the UI can say "this is not in force"
    // without also reporting every legacy key it quietly rewrote.
    it("reports a refused leaf with its dotted path and leaves migrations out", () => {
      const { warnings, rejections } = resolveEngineConfig({
        maxToolCalls: 12, // legacy alias → migrated, NOT a rejection
        memory: { index: { enabled: true, connectionString: "" } },
      });

      expect(warnings.some((w) => w.includes("maxToolCalls"))).toBe(true);
      expect(rejections.map((r) => r.path)).toEqual(["memory.index.connectionString"]);
      expect(rejections.every((r) => !r.path.includes("maxToolCalls"))).toBe(true);
      // Every rejection must also stay in the log, so nothing is lost.
      for (const rejection of rejections) {
        expect(warnings.some((w) => w.includes(rejection.path))).toBe(true);
      }
    });

    it("reports no rejections for a clean config", () => {
      expect(resolveEngineConfig({ maxSteps: 12 }).rejections).toEqual([]);
      expect(resolveEngineConfig({}).rejections).toEqual([]);
      expect(resolveEngineConfig(undefined).rejections).toEqual([]);
    });
  });

  describe("partial recovery is leaf-granular", () => {
    // Regression: salvage pruned by `issue.path[0]`, so one bad leaf reset the
    // whole top-level block. Clearing the Postgres connection string in
    // Settings writes "", which fails z.string().min(1), and every memory.*
    // setting reverted to defaults on every turn — silently, since the
    // warnings are only console.warn'd.
    it("keeps sibling memory settings when one leaf is invalid", () => {
      const { config, warnings } = resolveEngineConfig({
        memory: {
          index: { enabled: true, connectionString: "" },
          ltm: { enabled: true },
          recall: { k: 9 },
        },
      });

      expect(warnings.some((w) => w.includes("memory.index.connectionString"))).toBe(true);
      // The offending leaf is defaulted…
      expect(config.memory.index.connectionString).toBe(DEFAULT_ENGINE_CONFIG.memory.index.connectionString);
      // …and its siblings survive.
      expect(config.memory.index.enabled).toBe(true);
      expect(config.memory.ltm.enabled).toBe(true);
      expect(config.memory.recall.k).toBe(9);
    });

    it("drops only the offending array element, not the whole array", () => {
      // A bad MCP server id used to discard the entire `mcp` block, silently
      // disabling every configured server.
      const { config } = resolveEngineConfig({
        mcp: {
          enabled: true,
          servers: [
            { id: "good-one", command: "node" },
            { id: "has spaces and is invalid", command: "node" },
            { id: "good-two", command: "node" },
          ],
        },
      });

      expect(config.mcp.enabled).toBe(true);
      expect(config.mcp.servers.map((server) => server.id)).toEqual(["good-one", "good-two"]);
    });

    it("fails permission rules closed rather than pruning them", () => {
      // normalizePermissions runs before the zod parse and coerces an unknown
      // action to `deny`, so a malformed rule is tightened, not dropped. That
      // is deliberate and must stay that way — pruning would silently widen
      // access.
      const { config } = resolveEngineConfig({
        permissions: {
          rules: [
            { pattern: "^run_command:npm test$", action: "allow" },
            { pattern: "^write_file:", action: "not-a-real-action" },
            { pattern: "^run_command:git push$", action: "deny" },
          ],
        },
      });

      expect(config.permissions.rules.map((rule) => rule.action)).toEqual(["allow", "deny", "deny"]);
    });

    it("keeps user deny rules when an allow-once path is over-long", () => {
      // The gateway injects protectedPathAllowOnce from the model's own
      // approval args on every later turn of a session. An entry past the
      // schema's 500-char bound used to fail the whole `permissions` block, and
      // salvage replaced it with the defaults — erasing every user deny rule.
      // The gateway now refuses such an entry; this pins the engine side so a
      // stale poisoned config cannot widen access either.
      const { config } = resolveEngineConfig({
        permissions: {
          terminal: "off",
          rules: [{ pattern: "^run_command:", action: "deny" }],
          protectedPathAllowOnce: ["src/ok.ts", "x".repeat(600)],
        },
      });

      expect(config.permissions.terminal).toBe("off");
      expect(config.permissions.rules).toEqual([{ pattern: "^run_command:", action: "deny" }]);
      expect(config.permissions.protectedPathAllowOnce ?? []).not.toContain("x".repeat(600));
    });

    it("keeps unrelated top-level blocks intact", () => {
      const { config } = resolveEngineConfig({
        maxSteps: 24,
        compression: { protectLastN: 9 },
        memory: { index: { connectionString: "" } },
      });

      expect(config.maxSteps).toBe(24);
      expect(config.compression.protectLastN).toBe(9);
    });
  });
});

describe("array salvage survives an element with several problems", () => {
  // Regression: zod reports one issue per bad FIELD, so a single malformed
  // element produced several issues at the SAME index. Splicing as each one
  // arrived removed that index repeatedly and deleted the element's innocent
  // neighbours — and because the retry then succeeded, the truncated array was
  // accepted and persisted with nothing in warnings or rejections to say so.
  it("drops only the bad element when it has two invalid fields", () => {
    const { config, rejections } = resolveEngineConfig({
      mcp: {
        enabled: true,
        servers: [
          { id: "bad id with spaces", command: "" },
          { id: "good-one", command: "node" },
        ],
      },
    });

    expect(config.mcp.servers.map((server) => server.id)).toEqual(["good-one"]);
    expect(rejections.every((rejection) => rejection.path.startsWith("mcp.servers.0"))).toBe(true);
  });

  it("drops the right elements when several are bad at non-adjacent indices", () => {
    const { config } = resolveEngineConfig({
      mcp: {
        enabled: true,
        servers: [
          { id: "bad one", command: "" },
          { id: "keep-a", command: "node" },
          { id: "also bad", command: "" },
          { id: "keep-b", command: "node" },
        ],
      },
    });

    expect(config.mcp.servers.map((server) => server.id)).toEqual(["keep-a", "keep-b"]);
  });

  it("still salvages when the only bad element is the last one", () => {
    const { config } = resolveEngineConfig({
      mcp: {
        enabled: true,
        servers: [
          { id: "keep-a", command: "node" },
          { id: "bad tail", command: "" },
        ],
      },
    });

    expect(config.mcp.servers.map((server) => server.id)).toEqual(["keep-a"]);
  });
});
