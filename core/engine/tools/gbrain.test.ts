import { describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import { buildGBrainTools } from "./gbrain.js";
import type { GBrainClient } from "../memory/gbrain.js";

const client: GBrainClient = {
  search: vi.fn(async () => [{ slug: "projects/kyrei" }]),
  getPage: vi.fn(async () => ({ slug: "projects/kyrei", content: "context" })),
  think: vi.fn(async () => ({ answer: "synthesis" })),
  capture: vi.fn(async () => ({ status: "ok" })),
  doctor: vi.fn(async () => ({ healthy: true })),
};

const disabledConfig = { provider: "external-cli", mode: "off", command: "gbrain", timeoutMs: 180_000, maxOutputBytes: 200_000 } as const;
const readConfig = { ...disabledConfig, mode: "read" } as const;
const writeConfig = { ...disabledConfig, mode: "read-write" } as const;

async function execute(tools: ToolSet, name: string, args: unknown): Promise<string> {
  const def = tools[name] as { execute: (input: unknown, options: unknown) => Promise<unknown> };
  return String(await def.execute(args, { toolCallId: "gbrain-test", messages: [] }));
}

describe("GBrain agent tools", () => {
  it("exposes nothing while disabled", () => {
    expect(buildGBrainTools(disabledConfig, { client })).toEqual({});
  });

  it("exposes read operations and frames results as untrusted", async () => {
    const tools = buildGBrainTools(readConfig, { client });
    expect(tools["brain_capture"]).toBeUndefined();
    expect(await execute(tools, "brain_search", { query: "Kyrei" })).toContain("untrusted personal knowledge data");
    expect(await execute(tools, "brain_get", { slug: "projects/kyrei" })).toContain("context");
    expect(await execute(tools, "brain_think", { question: "What changed?" })).toContain("synthesis");
  });

  it("adds explicit capture only in read-write mode", async () => {
    const tools = buildGBrainTools(writeConfig, { client });
    expect(await execute(tools, "brain_capture", { content: "Remember this" })).toContain('"status": "ok"');
  });

  it("honours the engine-facing output cap", async () => {
    const noisyClient = { ...client, search: vi.fn(async () => ({ text: "x".repeat(20_000) })) };
    const tools = buildGBrainTools(readConfig, { client: noisyClient, maxModelOutputChars: 800 });
    const output = await execute(tools, "brain_search", { query: "Kyrei" });
    expect(output.length).toBeLessThanOrEqual(800);
    expect(output).toContain("truncated GBrain output");
  });

  it("frames CLI failures as untrusted data too", async () => {
    const failingClient = { ...client, search: vi.fn(async () => { throw new Error("malicious-looking stderr"); }) };
    const tools = buildGBrainTools(readConfig, { client: failingClient });
    const output = await execute(tools, "brain_search", { query: "Kyrei" });
    expect(output).toContain("untrusted personal knowledge data");
    expect(output).toContain("malicious-looking stderr");
  });
});
