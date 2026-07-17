/**
 * Wave H — MemoHood-inspired recall post-processing (pure, offline).
 *
 * Pipeline after raw multi-channel hits:
 *   gate (should we bother?) → near-dupe collapse → MMR diversity → top-k
 *
 * No network, no embeddings required: token Jaccard similarity is enough
 * for snippet-level diversity. Fail-open: empty/invalid inputs return [].
 */

export interface RecallHit {
  source: string;
  score: number;
  title: string;
  snippet: string;
  path?: string;
}

export interface RecallPipelineConfig {
  /** Max hits after post-process (default 8). */
  k: number;
  /** Collapse near-duplicates (default true). */
  clusterEnabled: boolean;
  /** Jaccard threshold above which two snippets are one cluster (default 0.86). */
  clusterThreshold: number;
  /** MMR diversity reorder (default true). */
  mmrEnabled: boolean;
  /** 1 = pure relevance, 0 = pure diversity (default 0.72). */
  mmrLambda: number;
}

export const DEFAULT_RECALL_PIPELINE: RecallPipelineConfig = {
  k: 8,
  clusterEnabled: true,
  clusterThreshold: 0.86,
  mmrEnabled: true,
  mmrLambda: 0.72,
};

export function normalizeRecallConfig(value: unknown): RecallPipelineConfig {
  const src = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const num = (v: unknown, fallback: number, min: number, max: number) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  return {
    k: Math.floor(num(src.k, DEFAULT_RECALL_PIPELINE.k, 1, 20)),
    clusterEnabled: src.clusterEnabled !== false,
    clusterThreshold: num(
      src.clusterThreshold,
      DEFAULT_RECALL_PIPELINE.clusterThreshold,
      0.5,
      0.99,
    ),
    mmrEnabled: src.mmrEnabled !== false,
    mmrLambda: num(src.mmrLambda, DEFAULT_RECALL_PIPELINE.mmrLambda, 0, 1),
  };
}

/** Normalize text for similarity / dedupe keys. */
export function normalizeRecallText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenSet(text: string): Set<string> {
  const norm = normalizeRecallText(text);
  if (!norm) return new Set();
  return new Set(norm.split(" ").filter((t) => t.length >= 2));
}

/** Jaccard similarity of token sets in [0, 1]. */
export function jaccardSimilarity(a: string, b: string): number {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Cheap gate: skip full recall for pure phatics / very short acks.
 * Conservative — prefer false recall over false skip.
 * Explicit memory tools should still run; this is for auto-prefetch paths.
 */
export function shouldRecall(query: string): { recall: boolean; reason: string } {
  const q = query.trim();
  if (!q) return { recall: false, reason: "empty" };
  if (q.length < 2) return { recall: false, reason: "too_short" };

  // Explicit memory intent always wins (unicode-aware; JS \b is ASCII-only).
  if (
    /(?<![\p{L}\p{N}_])(?:remember|recall|memory|memo|запомни|вспомни|памят[ьи]|decision|решени[ея]|prefers?|предпочит[\p{L}]*)(?![\p{L}\p{N}_])/iu.test(
      q,
    )
  ) {
    return { recall: true, reason: "memory_intent" };
  }

  // Meaningful content floor: ≥3 alphanumeric tokens of length ≥2.
  const terms = normalizeRecallText(q).split(" ").filter((t) => t.length >= 2);
  if (terms.length >= 3) return { recall: true, reason: "contentful" };

  // Known phatics / acks (RU + EN).
  const phatic =
    /^(ok|okay|ок|окей|да|нет|no|yes|yep|nope|thanks|thank you|thx|спасибо|благодарю|понял[ао]?|хорошо|ладно|ага|угу|lol|haha|👍|🙏|👋|cool|nice|got it|lgtm|sg|sure|k|kk|👍+)$/iu;
  if (phatic.test(q.replace(/\s+/g, " ").trim())) {
    return { recall: false, reason: "phatic" };
  }

  // Short but non-phatic — still recall (safer).
  return { recall: true, reason: "default" };
}

/**
 * Keep the highest-scoring hit per near-duplicate cluster.
 * Two hits cluster when path matches or snippet Jaccard ≥ threshold.
 */
export function collapseNearDuplicates(
  hits: readonly RecallHit[],
  threshold = DEFAULT_RECALL_PIPELINE.clusterThreshold,
): RecallHit[] {
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const kept: RecallHit[] = [];
  for (const h of sorted) {
    let dupe = false;
    for (const k of kept) {
      if (h.path && k.path && h.path === k.path) {
        dupe = true;
        break;
      }
      const sim = jaccardSimilarity(
        `${h.title} ${h.snippet}`,
        `${k.title} ${k.snippet}`,
      );
      if (sim >= threshold) {
        dupe = true;
        // Slight boost when two channels agreed on near-same content.
        k.score = Math.max(k.score, h.score) + (h.source !== k.source ? 0.8 : 0);
        break;
      }
    }
    if (!dupe) kept.push({ ...h });
  }
  return kept;
}

/**
 * Maximal Marginal Relevance over lexical similarity of title+snippet.
 * Returns up to `k` hits reordered for relevance × diversity.
 */
export function mmrRerank(
  hits: readonly RecallHit[],
  opts: { k?: number; lambda?: number } = {},
): RecallHit[] {
  const k = Math.max(1, Math.min(50, opts.k ?? DEFAULT_RECALL_PIPELINE.k));
  const lambda = Math.min(1, Math.max(0, opts.lambda ?? DEFAULT_RECALL_PIPELINE.mmrLambda));
  if (hits.length <= 1) return hits.slice(0, k);

  const remaining = hits.map((h) => ({ ...h }));
  // Normalize scores to [0,1] for MMR mix.
  const maxScore = Math.max(...remaining.map((h) => h.score), 1e-9);
  const selected: RecallHit[] = [];

  while (selected.length < k && remaining.length) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i]!;
      const rel = cand.score / maxScore;
      let maxSim = 0;
      for (const s of selected) {
        const sim = jaccardSimilarity(
          `${cand.title} ${cand.snippet}`,
          `${s.title} ${s.snippet}`,
        );
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lambda * rel - (1 - lambda) * maxSim;
      if (mmr > bestVal) {
        bestVal = mmr;
        bestIdx = i;
      }
    }
    selected.push(remaining.splice(bestIdx, 1)[0]!);
  }
  return selected;
}

/** Full post-process: cluster → MMR → top-k. */
export function postProcessRecall(
  hits: readonly RecallHit[],
  config?: Partial<RecallPipelineConfig>,
): RecallHit[] {
  const cfg = normalizeRecallConfig({ ...DEFAULT_RECALL_PIPELINE, ...config });
  if (!hits.length) return [];
  let out = hits.map((h) => ({ ...h }));
  // Primary path-key dedupe (stable).
  const byPath = new Map<string, RecallHit>();
  for (const h of out) {
    const key = h.path ?? `${h.source}:${normalizeRecallText(h.title + " " + h.snippet).slice(0, 80)}`;
    const prev = byPath.get(key);
    if (!prev || h.score > prev.score) byPath.set(key, h);
  }
  out = [...byPath.values()].sort((a, b) => b.score - a.score);

  if (cfg.clusterEnabled) {
    out = collapseNearDuplicates(out, cfg.clusterThreshold);
  }
  if (cfg.mmrEnabled) {
    out = mmrRerank(out, { k: cfg.k, lambda: cfg.mmrLambda });
  } else {
    out = out.slice(0, cfg.k);
  }
  return out;
}
