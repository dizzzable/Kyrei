/**
 * OpenAI-compatible HTTP embedding adapter (optional neural path).
 * No heavy local model deps — user points at a local/remote /v1/embeddings endpoint.
 */

import type { EmbedAdapter } from "./embed-adapter.js";

export interface HttpEmbedOptions {
  baseURL: string;
  model: string;
  apiKey?: string;
  /** Request timeout (default 30s). */
  timeoutMs?: number;
  /** Expected dimension; if remote returns different, vector is used as-is. */
  dim?: number;
  fetch?: typeof fetch;
}

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Create an embed adapter that POSTs to `{baseURL}/embeddings` or
 * `{baseURL}/v1/embeddings` (auto-detects path if base already includes /v1).
 */
export function createHttpEmbedAdapter(options: HttpEmbedOptions): EmbedAdapter {
  const base = normalizeBase(options.baseURL);
  const embedPath = /\/v1$/i.test(base) ? `${base}/embeddings` : `${base}/v1/embeddings`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const fetchImpl = options.fetch ?? fetch;
  const dim = options.dim ?? 384;
  const modelId = options.model;

  return {
    modelId: `http:${modelId}`,
    dim,
    async embed(text: string): Promise<Float32Array> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "application/json",
        };
        if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
        const response = await fetchImpl(embedPath, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: modelId,
            input: text.slice(0, 32_000),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(`embed HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
        }
        const json = (await response.json()) as {
          data?: Array<{ embedding?: number[] }>;
        };
        const embedding = json.data?.[0]?.embedding;
        if (!Array.isArray(embedding) || embedding.length === 0) {
          throw new Error("embed response missing data[0].embedding");
        }
        return Float32Array.from(embedding);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
