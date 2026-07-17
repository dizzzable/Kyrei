/**
 * Wave H+ — grounded memory_ask (MemoBase cite-or-refuse for local sources).
 *
 * Vault-first when configured; always includes MEMORY.md / notes / decisions
 * as searchable snippets. Never invents: weak hits → honest refuse.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLtmBridge } from "../memory/ltm-bridge.js";
import {
  buildGroundedContextPack,
  checkSufficiency,
  normalizeCiteConfig,
  refuseMessage,
  type CiteOrRefuseConfig,
  type GroundedSnippet,
} from "../memory/cite-or-refuse.js";
import { normalizeVaultConfig, searchVaultFiles, type VaultConfig } from "../memory/vault.js";
import { postProcessRecall } from "../memory/recall-pipeline.js";
import { TOOL_DESCRIPTIONS } from "../prompt/tool-descriptions.js";

export interface MemoryAskOptions {
  workspace: string;
  ltmDir?: string;
  ltmEnabled?: boolean;
  vault?: VaultConfig;
  maxModelOutputChars?: number;
  citeOrRefuse?: Partial<CiteOrRefuseConfig>;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function scoreText(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const hay = text.toLowerCase();
  if (!hay) return 0;
  let score = 0;
  if (hay.includes(q)) score += 10;
  for (const t of q.split(/\s+/).filter((x) => x.length >= 2)) {
    if (hay.includes(t)) score += 2;
  }
  return score;
}

async function readIf(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Collect grounded snippets from vault + project memory files + decisions. */
export async function collectAskSnippets(
  options: MemoryAskOptions,
  query: string,
  limit = 12,
): Promise<GroundedSnippet[]> {
  const raw: GroundedSnippet[] = [];
  const lim = Math.max(4, Math.min(20, limit));

  // Vault (primary for document-style ask)
  const vaultCfg = normalizeVaultConfig(options.vault);
  if (vaultCfg.enabled && vaultCfg.paths.length) {
    const vaultHits = await searchVaultFiles(vaultCfg, query, lim);
    for (let i = 0; i < vaultHits.length; i++) {
      const v = vaultHits[i]!;
      raw.push({
        id: `vault-${i + 1}`,
        text: v.snippet,
        source: v.path,
        score: v.score + 2,
      });
    }
  }

  // Project markdown canon
  for (const rel of [".kyrei/memory/MEMORY.md", ".kyrei/memory/notes.md"] as const) {
    const body = await readIf(join(options.workspace, rel));
    if (!body) continue;
    const score = scoreText(query, body);
    if (score <= 0) continue;
    // Prefer matching paragraphs when file is large
    const paras = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    let best = body.slice(0, 800);
    let bestScore = score;
    for (const p of paras) {
      const s = scoreText(query, p);
      if (s > bestScore) {
        bestScore = s;
        best = p.slice(0, 800);
      }
    }
    raw.push({
      id: rel.endsWith("MEMORY.md") ? "memory-md" : "notes-md",
      text: best,
      source: rel,
      score: bestScore + (rel.endsWith("MEMORY.md") ? 3 : 1),
    });
  }

  // Active decisions
  if (options.ltmEnabled !== false && options.ltmDir) {
    try {
      const bridge = createLtmBridge(options.ltmDir);
      const decisions = await bridge.listDecisions({ rankByConfidence: true });
      for (const d of decisions.slice(0, 40)) {
        const blob = `${d.decision} ${d.rationale}`;
        const score = scoreText(query, blob);
        if (score <= 0) continue;
        raw.push({
          id: d.id,
          text: clip(`${d.decision}${d.rationale ? ` — ${d.rationale}` : ""}${d.pinned ? " [pinned]" : ""}`, 500),
          source: `ltm/store/decisions.jsonl#${d.id}`,
          score: score + (d.pinned ? 5 : 3),
        });
      }
    } catch {
      /* optional */
    }
  }

  // Diversity post-process via recall pipeline shape
  const ranked = postProcessRecall(
    raw.map((s) => ({
      source: s.source ?? s.id,
      score: s.score,
      title: s.id,
      snippet: s.text,
      path: s.source,
    })),
    { k: lim, mmrEnabled: true, clusterEnabled: true },
  );

  // Refresh last_accessed for decision snippets that survived ranking (fail-open).
  if (options.ltmDir) {
    const ids = ranked
      .map((h) => String(h.title ?? ""))
      .filter((id) => /^dec_\d+$/i.test(id))
      .slice(0, 3);
    if (ids.length) {
      try {
        const bridge = createLtmBridge(options.ltmDir);
        if (typeof bridge.touchDecisions === "function") await bridge.touchDecisions(ids);
      } catch {
        /* fail-open */
      }
    }
  }

  return ranked.map((h, i) => ({
    id: String(h.title || `s${i + 1}`),
    text: h.snippet,
    source: h.path,
    score: h.score,
  }));
}

/**
 * Pure ask pipeline: sufficiency → grounded pack or refuse.
 * Does not call an LLM — returns context pack for the agent to answer from,
 * or a refuse message. Keeps tool surface non-hallucinating.
 */
export async function runMemoryAsk(
  options: MemoryAskOptions,
  query: string,
  limit?: number,
): Promise<string> {
  const max = options.maxModelOutputChars ?? 12_000;
  const cite = normalizeCiteConfig({
    minTopScore: 4,
    minHits: 1,
    ...options.citeOrRefuse,
  });
  const snippets = await collectAskSnippets(options, query, limit ?? 10);
  const sufficiency = checkSufficiency(snippets, cite);
  if (!sufficiency.sufficient) {
    const body = [
      "# memory_ask — grounded refuse",
      refuseMessage(query, sufficiency),
      "",
      "Tried: vault (if enabled) + MEMORY.md/notes + LTM decisions.",
      "Do not invent facts. Suggest ingesting sources or rephrasing.",
    ].join("\n");
    return body.length <= max ? body : `${body.slice(0, max)}\n…`;
  }

  const pack = buildGroundedContextPack(snippets, {
    maxSnippets: limit ?? 8,
    maxChars: Math.min(max - 400, 8_000),
  });
  const body = [
    "# memory_ask — grounded sources only",
    "Answer ONLY from the fragments below. Quote verbatim when claiming facts.",
    "If a detail is not covered, say it is not in local memory — do not guess.",
    `Query: ${query.slice(0, 300)}`,
    "",
    pack,
  ].join("\n");
  return body.length <= max ? body : `${body.slice(0, max)}\n… [обрезано]`;
}

export function buildMemoryAskTools(options: MemoryAskOptions): ToolSet {
  return {
    memory_ask: tool({
      description: TOOL_DESCRIPTIONS.memory_ask,
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(500)
          .describe("Question to answer strictly from local vault / MEMORY / decisions."),
        limit: z.number().int().min(1).max(16).optional().describe("Max source fragments (default 8)."),
      }),
      execute: async ({ query, limit }) => {
        try {
          return await runMemoryAsk(options, query, limit);
        } catch (error) {
          return `memory_ask failed: ${(error as Error).message}`;
        }
      },
    }),
  };
}
