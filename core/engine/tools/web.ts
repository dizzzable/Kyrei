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

export interface WebToolAudit {
  write(record: AuditRecord): Promise<void>;
}

export interface WebToolOptions {
  browser?: WebBrowser;
  audit?: WebToolAudit;
}

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
  record: Omit<AuditRecord, "ts" | "tool"> & { tool: string },
): Promise<void> {
  await sink?.write({ ...record, ts: new Date().toISOString() }).catch(() => {});
}

function denialMessage(decision: "ask" | "deny"): string {
  return decision === "ask"
    ? "Web action requires explicit approval by the current permission rule."
    : "Web access is disabled by the current permission policy.";
}

/** Build only tools allowed by the capability mode; user rules remain deny-wins. */
export function buildWebTools(cfg: EngineConfig, options: WebToolOptions = {}): ToolSet {
  const browser = options.browser ?? createWebBrowser();
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
      execute: async ({ query, limit }) => {
        const started = Date.now();
        const decision = decisionFor(cfg, "web_search", query);
        if (decision !== "allow") {
          await audit(options.audit, { tool: "web_search", args: { query }, decision, status: "denied", durationS: (Date.now() - started) / 1000 });
          return denialMessage(decision);
        }
        await audit(options.audit, { tool: "web_search", args: { query }, decision, status: "start" });
        try {
          const result = formatWebSearchResults(await browser.search(query, limit));
          await audit(options.audit, { tool: "web_search", args: { query }, decision, status: "complete", durationS: (Date.now() - started) / 1000 });
          return result;
        } catch (error) {
          await audit(options.audit, {
            tool: "web_search",
            args: { query },
            decision,
            status: "error",
            error: (error as Error).message,
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
      execute: async ({ url, maxChars }) => {
        const started = Date.now();
        const decision = decisionFor(cfg, "web_fetch", url);
        if (decision !== "allow") {
          await audit(options.audit, { tool: "web_fetch", args: { url }, decision, status: "denied", durationS: (Date.now() - started) / 1000 });
          return denialMessage(decision);
        }
        await audit(options.audit, { tool: "web_fetch", args: { url }, decision, status: "start" });
        try {
          const page = await browser.fetch(url, maxChars);
          await audit(options.audit, {
            tool: "web_fetch",
            args: { url, finalUrl: page.url },
            decision,
            status: "complete",
            durationS: (Date.now() - started) / 1000,
          });
          return formatWebPage(page);
        } catch (error) {
          await audit(options.audit, {
            tool: "web_fetch",
            args: { url },
            decision,
            status: "error",
            error: (error as Error).message,
            durationS: (Date.now() - started) / 1000,
          });
          return `Web page could not be fetched: ${(error as Error).message}`;
        }
      },
    });
  }
  return tools;
}
