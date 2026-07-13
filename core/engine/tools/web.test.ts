import { describe, expect, it } from "vitest";
import type { ToolSet } from "ai";
import { DEFAULT_ENGINE_CONFIG } from "../types.js";
import { buildWebTools } from "./web.js";
import type { WebBrowser } from "../web/browser.js";

const browser: WebBrowser = {
  search: async () => [{ title: "Docs", url: "https://example.com/docs", snippet: "Reference" }],
  fetch: async () => ({ url: "https://example.com/docs", title: "Docs", text: "Body", links: [] }),
};

async function execute(tools: ToolSet, name: string, args: unknown, toolCallId = "web-test"): Promise<string> {
  const toolDef = tools[name] as { execute: (input: unknown, options: unknown) => Promise<unknown> };
  return String(await toolDef.execute(args, { toolCallId, messages: [] }));
}

describe("web tools", () => {
  it("exposes search and fetch in read mode and audits metadata without page bodies", async () => {
    const records: unknown[] = [];
    const tools = buildWebTools(DEFAULT_ENGINE_CONFIG, {
      browser,
      sessionId: "session-web",
      audit: { write: async (record) => { records.push(record); } },
    });
    expect(await execute(tools, "web_search", { query: "Kyrei" }, "search-call")).toContain("https://example.com/docs");
    expect(await execute(tools, "web_fetch", { url: "https://example.com/docs" }, "fetch-call")).toContain("Body");
    expect(records).toHaveLength(4);
    expect(records).toMatchObject([
      { sessionId: "session-web", toolCallId: "search-call", metadata: { queryLength: 5, limit: 5 }, status: "start" },
      { sessionId: "session-web", toolCallId: "search-call", metadata: { queryLength: 5, limit: 5 }, status: "complete" },
      { sessionId: "session-web", toolCallId: "fetch-call", metadata: { origin: "https://example.com", pathDepth: 1 }, status: "start" },
      { sessionId: "session-web", toolCallId: "fetch-call", metadata: { finalOrigin: "https://example.com", finalPathDepth: 1, textLength: 4, linkCount: 0 }, status: "complete" },
    ]);
    expect(JSON.stringify(records)).not.toContain("Body");
  });

  it("never audits search text, URL credentials, query strings, fragments, or provider error details", async () => {
    const records: unknown[] = [];
    const unsafeBrowser: WebBrowser = {
      search: async (query) => { throw new Error(`provider rejected ${query}`); },
      fetch: async () => ({
        url: "https://redirect-user:redirect-pass@example.net/download/final-path-secret?final-token=gamma#final-fragment",
        title: "Docs",
        text: "Safe body",
        links: [],
      }),
    };
    const tools = buildWebTools(DEFAULT_ENGINE_CONFIG, {
      browser: unsafeBrowser,
      sessionId: "session-secret-test",
      audit: { write: async (record) => { records.push(record); } },
    });

    const secretQuery = "private research phrase alpha";
    const credentialUrl = "https://request-user:request-pass@example.com/reset/request-path-secret?access_token=beta#request-fragment";
    expect(await execute(tools, "web_search", { query: secretQuery, limit: 3 }, "secret-search")).toContain(secretQuery);
    expect(await execute(tools, "web_fetch", { url: credentialUrl }, "secret-fetch")).toContain("Safe body");

    const serialized = JSON.stringify(records);
    for (const secret of [
      secretQuery,
      "request-user",
      "request-pass",
      "access_token",
      "beta",
      "request-fragment",
      "request-path-secret",
      "redirect-user",
      "redirect-pass",
      "final-token",
      "gamma",
      "final-fragment",
      "final-path-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(records).toMatchObject([
      { sessionId: "session-secret-test", toolCallId: "secret-search", metadata: { queryLength: secretQuery.length, limit: 3 }, status: "start" },
      { sessionId: "session-secret-test", toolCallId: "secret-search", error: "web search failed", status: "error" },
      { sessionId: "session-secret-test", toolCallId: "secret-fetch", metadata: { origin: "https://example.com", pathDepth: 2 }, status: "start" },
      { sessionId: "session-secret-test", toolCallId: "secret-fetch", metadata: { finalOrigin: "https://example.net", finalPathDepth: 2 }, status: "complete" },
    ]);
  });

  it("correlates denied web audits without persisting the denied target", async () => {
    const records: unknown[] = [];
    const deniedQuery = "confidential denied lookup";
    const cfg = {
      ...DEFAULT_ENGINE_CONFIG,
      permissions: {
        ...DEFAULT_ENGINE_CONFIG.permissions,
        rules: [{ pattern: "confidential", action: "deny" as const }],
      },
    };
    const tools = buildWebTools(cfg, {
      browser,
      sessionId: "session-denied",
      audit: { write: async (record) => { records.push(record); } },
    });

    expect(await execute(tools, "web_search", { query: deniedQuery }, "denied-call")).toContain("disabled");
    expect(records).toMatchObject([
      {
        sessionId: "session-denied",
        toolCallId: "denied-call",
        metadata: { queryLength: deniedQuery.length, limit: 5 },
        decision: "deny",
        status: "denied",
      },
    ]);
    expect(JSON.stringify(records)).not.toContain(deniedQuery);
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
