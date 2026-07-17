/**
 * Optional embedding provider seam. Default online path uses lexical hashing
 * (see lexical-embed.ts). HTTP neural models plug in via createHttpEmbedAdapter
 * without changing MemoryStore / VectorStore contracts.
 */

import { lexicalEmbed, LEXICAL_EMBED_MODEL, LEXICAL_EMBED_DIM, isZeroVector } from "./lexical-embed.js";
import { createHttpEmbedAdapter, type HttpEmbedOptions } from "./http-embed.js";

export interface EmbedAdapter {
  readonly modelId: string;
  readonly dim: number;
  embed(text: string): Promise<Float32Array> | Float32Array;
}

export type EmbedMode = "lexical" | "http";

export interface EmbedConfig {
  mode: EmbedMode;
  /** OpenAI-compatible base URL when mode=http. */
  baseURL?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  dim?: number;
}

/** Default offline adapter — deterministic, no network, no native deps. */
export function createLexicalEmbedAdapter(): EmbedAdapter {
  return {
    modelId: LEXICAL_EMBED_MODEL,
    dim: LEXICAL_EMBED_DIM,
    embed(text: string) {
      return lexicalEmbed(text);
    },
  };
}

let activeAdapter: EmbedAdapter = createLexicalEmbedAdapter();

/** Replace the process-wide embed adapter (tests / neural plugin). */
export function setEmbedAdapter(adapter: EmbedAdapter | null): void {
  activeAdapter = adapter ?? createLexicalEmbedAdapter();
}

export function getEmbedAdapter(): EmbedAdapter {
  return activeAdapter;
}

export async function embedText(text: string): Promise<Float32Array> {
  return await activeAdapter.embed(text);
}

/**
 * Split long searchable bodies into stable overlapping embedding windows.
 * The document itself remains a single FTS row; chunks only improve vector
 * recall and are addressed by VectorStore.chunkIndex.
 */
export function splitTextForEmbedding(
  text: string,
  options: { maxChars?: number; overlap?: number; maxChunks?: number } = {},
): string[] {
  const value = text.trim();
  if (!value) return [];
  const maxChars = Math.max(256, Math.floor(options.maxChars ?? 1_800));
  const overlap = Math.max(0, Math.min(maxChars - 1, Math.floor(options.overlap ?? 180)));
  const maxChunks = Math.max(1, Math.floor(options.maxChunks ?? 16));
  if (value.length <= maxChars) return [value];

  const chunks: string[] = [];
  let start = 0;
  while (start < value.length && chunks.length < maxChunks) {
    let end = Math.min(value.length, start + maxChars);
    if (end < value.length) {
      const boundary = value.lastIndexOf("\n", end);
      if (boundary > start + Math.floor(maxChars * 0.55)) end = boundary;
    }
    const chunk = value.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= value.length) break;
    const next = Math.max(start + 1, end - overlap);
    if (next <= start) break;
    start = next;
  }

  // Preserve the tail when a very large document hits the chunk cap. This
  // keeps conclusions/appendices searchable without unbounded API calls.
  if (chunks.length >= maxChunks && start < value.length - maxChars) {
    const tail = value.slice(Math.max(0, value.length - maxChars)).trim();
    if (tail && tail !== chunks[chunks.length - 1]) chunks[chunks.length - 1] = tail;
  }
  return chunks;
}

/**
 * Configure process-wide embedder from engine config. Fail-open to lexical
 * when HTTP config is incomplete or invalid.
 */
export function configureEmbedAdapterFromConfig(config?: EmbedConfig | null): EmbedAdapter {
  if (!config || config.mode !== "http") {
    const lexical = createLexicalEmbedAdapter();
    setEmbedAdapter(lexical);
    return lexical;
  }
  const baseURL = config.baseURL?.trim();
  const model = config.model?.trim();
  if (!baseURL || !model) {
    const lexical = createLexicalEmbedAdapter();
    setEmbedAdapter(lexical);
    return lexical;
  }
  try {
    const opts: HttpEmbedOptions = {
      baseURL,
      model,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.dim ? { dim: config.dim } : {}),
    };
    const http = createHttpEmbedAdapter(opts);
    setEmbedAdapter(http);
    return http;
  } catch {
    const lexical = createLexicalEmbedAdapter();
    setEmbedAdapter(lexical);
    return lexical;
  }
}

export { isZeroVector, LEXICAL_EMBED_MODEL, LEXICAL_EMBED_DIM, createHttpEmbedAdapter };
export type { HttpEmbedOptions };
