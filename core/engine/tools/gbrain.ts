/** Optional GBrain retrieval/capture tools. Brain data is never system policy. */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  createGBrainClient,
  formatGBrainResult,
  type GBrainClient,
  type GBrainConfig,
} from "../memory/gbrain.js";
import { TOOL_DESCRIPTIONS } from "../prompt/tool-descriptions.js";

export interface GBrainToolOptions {
  client?: GBrainClient;
  signal?: AbortSignal;
  maxModelOutputChars?: number;
}

async function resultOf(operation: string, maxChars: number | undefined, run: () => Promise<unknown>): Promise<string> {
  try {
    return formatGBrainResult(await run(), maxChars);
  } catch (error) {
    return formatGBrainResult({ operation, error: (error as Error).message }, maxChars);
  }
}

export function buildGBrainTools(config: GBrainConfig, options: GBrainToolOptions = {}): ToolSet {
  if (config.mode === "off") return {};
  const client = options.client ?? createGBrainClient({ ...config, ...(options.signal ? { signal: options.signal } : {}) });
  const tools: ToolSet = {
    brain_search: tool({
      description: TOOL_DESCRIPTIONS.brain_search,
      inputSchema: z.object({
        query: z.string().min(1).max(2_000),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: ({ query, limit }) => resultOf("search", options.maxModelOutputChars, () => client.search(query, limit)),
    }),
    brain_get: tool({
      description: TOOL_DESCRIPTIONS.brain_get,
      inputSchema: z.object({ slug: z.string().min(1).max(500) }),
      execute: ({ slug }) => resultOf("page read", options.maxModelOutputChars, () => client.getPage(slug)),
    }),
    brain_think: tool({
      description: TOOL_DESCRIPTIONS.brain_think,
      inputSchema: z.object({
        question: z.string().min(1).max(8_000),
        anchor: z.string().min(1).max(500).optional(),
        rounds: z.number().int().min(1).max(3).optional(),
      }),
      execute: ({ question, anchor, rounds }) => resultOf("synthesis", options.maxModelOutputChars, () => client.think(question, { anchor, rounds })),
    }),
    brain_status: tool({
      description: TOOL_DESCRIPTIONS.brain_status,
      inputSchema: z.object({}),
      execute: () => resultOf("health check", options.maxModelOutputChars, () => client.doctor()),
    }),
  };

  if (config.mode === "read-write") {
    tools["brain_capture"] = tool({
      description: TOOL_DESCRIPTIONS.brain_capture,
      inputSchema: z.object({
        content: z.string().min(1).max(1_000_000),
        slug: z.string().min(1).max(500).optional(),
        type: z.string().min(1).max(64).optional(),
      }),
      execute: ({ content, slug, type }) => resultOf("capture", options.maxModelOutputChars, () => client.capture(content, { slug, type })),
    });
  }
  return tools;
}
