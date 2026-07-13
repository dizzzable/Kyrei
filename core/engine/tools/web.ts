/** Public-web tools available to an agent even when no workspace is selected. */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { EngineConfig } from "../types.js";
import { decide } from "../security/permissions.js";
import type { AuditRecord } from "../security/audit.js";
import {
  createWebBrowser,
  formatWebPage,
  formatWebSearchResults,
  type WebBrowser,
} from "../web/browser.js";
import { TOOL_DESCRIPTIONS } from "../prompt/tool-descriptions.js";
import { containsSecret } from "../security/secrets.js";

export interface WebToolAudit {
  write(record: AuditRecord): Promise<void>;
}

export interface WebToolOptions {
  browser?: WebBrowser;
  audit?: WebToolAudit;
  sessionId?: string;
  signal?: AbortSignal;
  /** Exact runtime credentials/headers that must never leave the process. */
  sensitiveValues?: readonly string[];
}

const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_MAX_CHARS = 18_000;

function decisionFor(cfg: EngineConfig, toolName: "web_search" | "web_fetch", target: string): "allow" | "ask" | "deny" {
  return decide(cfg.permissions, { tool: toolName, target });
}

function isConfiguredFor(cfg: EngineConfig, toolName: "web_search" | "web_fetch"): boolean {
  const mode = cfg.permissions.web;
  if (toolName === "web_search") return mode === "search" || mode === "read";
  return mode === "read";
}

function hasExplicitAllowRule(cfg: EngineConfig, toolName: string): boolean {
  return cfg.permissions.rules.some((rule) => {
    if (rule.action !== "allow") return false;
    try {
      return new RegExp(rule.pattern).test(`${toolName}:`);
    } catch {
      return false;
    }
  });
}

async function audit(
  sink: WebToolAudit | undefined,
  correlation: { sessionId?: string; toolCallId: string },
  record: Omit<AuditRecord, "ts" | "tool" | "sessionId" | "toolCallId"> & { tool: string },
): Promise<void> {
  await sink?.write({ ...record, ...correlation, ts: new Date().toISOString() }).catch(() => {});
}

function searchMetadata(query: string, limit: number | undefined): Record<string, unknown> {
  return { queryLength: query.length, limit: limit ?? DEFAULT_SEARCH_LIMIT };
}

function urlMetadata(raw: string, maxChars: number | undefined): Record<string, unknown> {
  const url = new URL(raw);
  return {
    origin: url.origin,
    pathDepth: url.pathname.split("/").filter(Boolean).length,
    urlLength: raw.length,
    maxChars: maxChars ?? DEFAULT_MAX_CHARS,
  };
}

function finalUrlMetadata(raw: string): Record<string, unknown> {
  const url = new URL(raw);
  return {
    finalOrigin: url.origin,
    finalPathDepth: url.pathname.split("/").filter(Boolean).length,
    finalUrlLength: raw.length,
  };
}

function denialMessage(decision: "ask" | "deny"): string {
  return decision === "ask"
    ? "Web action requires explicit approval by the current permission rule."
    : "Web access is disabled by the current permission policy.";
}

function containsSensitiveOutbound(value: string, sensitiveValues: readonly string[] = []): boolean {
  if (containsSecret(value)) return true;
  return sensitiveValues.some((candidate) => {
    const secret = candidate.trim();
    return secret.length >= 8 && value.includes(secret);
  });
}

const SENSITIVE_OUTBOUND_MESSAGE = "Web request blocked because it contains sensitive data.";

/** Build only tools allowed by the capability mode; user rules remain deny-wins. */
export function buildWebTools(cfg: EngineConfig, options: WebToolOptions = {}): ToolSet {
  const browser = options.browser ?? createWebBrowser({ signal: options.signal });
  const canSearch = isConfiguredFor(cfg, "web_search") || hasExplicitAllowRule(cfg, "web_search");
  const canFetch = isConfiguredFor(cfg, "web_fetch") || hasExplicitAllowRule(cfg, "web_fetch");
  const tools: ToolSet = {};

  if (canSearch) {
    tools["web_search"] = tool({
      description: TOOL_DESCRIPTIONS.web_search,
      inputSchema: z.object({
        query: z.string().min(1).max(500).describe("Public web search query."),
        limit: z.number().int().min(1).max(10).optional(),
      }),
      execute: async ({ query, limit }, { toolCallId }) => {
        const started = Date.now();
        const correlation = { sessionId: options.sessionId, toolCallId };
        const metadata = searchMetadata(query, limit);
        if (containsSensitiveOutbound(query, options.sensitiveValues)) {
          await audit(options.audit, correlation, { tool: "web_search", metadata, decision: "deny", status: "denied", durationS: (Date.now() - started) / 1000 });
          return SENSITIVE_OUTBOUND_MESSAGE;
        }
        const decision = decisionFor(cfg, "web_search", query);
        if (decision !== "allow") {
          await audit(options.audit, correlation, { tool: "web_search", metadata, decision, status: "denied", durationS: (Date.now() - started) / 1000 });
          return denialMessage(decision);
        }
        await audit(options.audit, correlation, { tool: "web_search", metadata, decision, status: "start" });
        try {
          const result = formatWebSearchResults(await browser.search(query, limit));
          await audit(options.audit, correlation, { tool: "web_search", metadata, decision, status: "complete", durationS: (Date.now() - started) / 1000 });
          return result;
        } catch (error) {
          await audit(options.audit, correlation, {
            tool: "web_search",
            metadata,
            decision,
            status: "error",
            error: "web search failed",
            durationS: (Date.now() - started) / 1000,
          });
          return `Web search failed: ${(error as Error).message}`;
        }
      },
    });
  }

  if (canFetch) {
    tools["web_fetch"] = tool({
      description: TOOL_DESCRIPTIONS.web_fetch,
      inputSchema: z.object({
        url: z.string().url().describe("Public http(s) URL returned by web_search or supplied by the user."),
        maxChars: z.number().int().min(1_000).max(60_000).optional(),
      }),
      execute: async ({ url, maxChars }, { toolCallId }) => {
        const started = Date.now();
        const correlation = { sessionId: options.sessionId, toolCallId };
        const metadata = urlMetadata(url, maxChars);
        if (containsSensitiveOutbound(url, options.sensitiveValues)) {
          await audit(options.audit, correlation, { tool: "web_fetch", metadata, decision: "deny", status: "denied", durationS: (Date.now() - started) / 1000 });
          return SENSITIVE_OUTBOUND_MESSAGE;
        }
        const decision = decisionFor(cfg, "web_fetch", url);
        if (decision !== "allow") {
          await audit(options.audit, correlation, { tool: "web_fetch", metadata, decision, status: "denied", durationS: (Date.now() - started) / 1000 });
          return denialMessage(decision);
        }
        await audit(options.audit, correlation, { tool: "web_fetch", metadata, decision, status: "start" });
        try {
          const page = await browser.fetch(url, maxChars);
          await audit(options.audit, correlation, {
            tool: "web_fetch",
            metadata: {
              ...metadata,
              ...finalUrlMetadata(page.url),
              textLength: page.text.length,
              linkCount: page.links.length,
            },
            decision,
            status: "complete",
            durationS: (Date.now() - started) / 1000,
          });
          return formatWebPage(page);
        } catch (error) {
          await audit(options.audit, correlation, {
            tool: "web_fetch",
            metadata,
            decision,
            status: "error",
            error: "web page fetch failed",
            durationS: (Date.now() - started) / 1000,
          });
          return `Web page could not be fetched: ${(error as Error).message}`;
        }
      },
    });
  }
  return tools;
}
