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

  it("validates nested permissions and provider roles", () => {
    const { config } = resolveEngineConfig({
      permissions: { terminal: "turbo", review: "always", rules: [{ pattern: "rm *", action: "deny" }] },
      providerRoles: { default: "gpt", small: "mini", plan: "o1" },
    });
    expect(config.permissions.terminal).toBe("turbo");
    expect(config.permissions.rules[0]).toEqual({ pattern: "rm *", action: "deny" });
    expect(config.providerRoles.plan).toBe("o1");
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
    expect(config.permissions.terminal).toBe(DEFAULT_ENGINE_CONFIG.permissions.terminal);
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
