import { describe, expect, it } from "vitest";
import type { ToolSet } from "ai";
import { DEFAULT_ENGINE_CONFIG } from "../types.js";
import { buildWebTools } from "./web.js";
import type { WebBrowser } from "../web/browser.js";

const browser: WebBrowser = {
  search: async () => [{ title: "Docs", url: "https://example.com/docs", snippet: "Reference" }],
  fetch: async () => ({ url: "https://example.com/docs", title: "Docs", text: "Body", links: [] }),
};

async function execute(tools: ToolSet, name: string, args: unknown): Promise<string> {
  const toolDef = tools[name] as { execute: (input: unknown, options: unknown) => Promise<unknown> };
  return String(await toolDef.execute(args, { toolCallId: "web-test", messages: [] }));
}

describe("web tools", () => {
  it("exposes search and fetch in read mode and audits metadata without page bodies", async () => {
    const records: unknown[] = [];
    const tools = buildWebTools(DEFAULT_ENGINE_CONFIG, { browser, audit: { write: async (record) => { records.push(record); } } });
    expect(await execute(tools, "web_search", { query: "Kyrei" })).toContain("https://example.com/docs");
    expect(await execute(tools, "web_fetch", { url: "https://example.com/docs" })).toContain("Body");
    expect(records).toHaveLength(4);
    expect(JSON.stringify(records)).not.toContain("Body");
  });

  it("offers search only in search mode", () => {
    const cfg = { ...DEFAULT_ENGINE_CONFIG, permissions: { ...DEFAULT_ENGINE_CONFIG.permissions, web: "search" as const } };
    const tools = buildWebTools(cfg, { browser });
    expect(tools["web_search"]).toBeDefined();
    expect(tools["web_fetch"]).toBeUndefined();
  });

  it("does not expose browser tools when web access is off", () => {
    const cfg = { ...DEFAULT_ENGINE_CONFIG, permissions: { ...DEFAULT_ENGINE_CONFIG.permissions, web: "off" as const } };
    expect(buildWebTools(cfg, { browser })).toEqual({});
  });
});
