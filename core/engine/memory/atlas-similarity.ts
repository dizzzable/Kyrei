/**
 * Atlas similarity edges (pure, deterministic, offline).
 *
 * Turns a set of memory/document nodes into `type: "related"` atlas edges by
 * embedding each node's text and linking its nearest neighbours above a cosine
 * threshold. This is what gives the graph a "web" of semantic links instead of
 * a bare containment tree.
 *
 * Why this does NOT reuse `embedText`/`lexicalEmbed`:
 *
 * 1. `lexicalEmbed` mixes word tokens with character trigrams into 256 dims.
 *    Trigrams are what make it good at fuzzy FTS recall, but they saturate on
 *    long text: past a few hundred characters, almost all of a document's
 *    trigram mass is ordinary English (" th", "ing", "he "), so any two prose
 *    documents converge on the same direction. Measured over 8 deliberately
 *    unrelated ~1k-char documents, every pair scored 0.84-0.90 while a
 *    genuinely related pair scored 0.90 — i.e. no separation at all, and no
 *    threshold can recover it. The set-of-words embedding below scores those
 *    same unrelated pairs 0.10-0.26 and related pairs 0.30-0.50.
 * 2. `embedText` resolves the process-wide adapter, which may be an HTTP
 *    model. Awaiting that once per document inside an interactive atlas
 *    request would mean hundreds of serial network round-trips, and would make
 *    the graph non-deterministic and dependent on remote availability.
 *
 * So similarity here is its own offline, allocation-cheap measure. The embedder
 * stays injectable for tests and for a future batched neural implementation.
 * Code nodes are intentionally excluded by the caller: there are too many and
 * their relatedness axis (imports) is already modelled.
 */

import type { MemoryAtlasEdge } from "./atlas-types.js";

/**
 * Minimum cosine similarity for two nodes to be considered related.
 * Calibrated against `atlasEmbed`: unrelated prose tops out around 0.26,
 * genuinely related notes start around 0.30.
 */
export const RELATED_THRESHOLD = 0.32;
/** Maximum related edges per node. Also the per-node degree cap. */
export const RELATED_TOP_K = 4;
/** Hard cap on total related edges emitted (respects the atlas edge budget). */
export const RELATED_MAX_EDGES = 400;
/** Vector width. Wider than the FTS embedder because collisions cost accuracy. */
export const ATLAS_EMBED_DIM = 1_024;

export interface RelatedNodeInput {
  /** Atlas node id (e.g. `memory:<docId>`). */
  id: string;
  /** Text to embed — typically `title` + a preview slice. */
  text: string;
}

export interface ComputeRelatedEdgesOptions {
  /** Injectable embedder; defaults to the offline `atlasEmbed`. */
  embed?: (text: string) => Promise<Float32Array> | Float32Array;
  threshold?: number;
  topK?: number;
  maxEdges?: number;
  sourceId?: string;
}

/** FNV-1a 32-bit hash → non-negative. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Embed text as a hashed set-of-words vector, L2-normalized.
 *
 * Set semantics (each distinct word counts once) is the important part: it
 * stops long documents from being dominated by how often they repeat common
 * words, which is what destroys the signal in a frequency-weighted embedding.
 * Words shorter than 3 characters are dropped as near-universal.
 */
export function atlasEmbed(text: string, dim = ATLAS_EMBED_DIM): Float32Array {
  const vector = new Float32Array(dim);
  const words = new Set(text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}_-]{3,}/gu) ?? []);
  if (words.size === 0) return vector;
  for (const word of words) {
    const h = fnv1a(word);
    // Signed contribution keeps unrelated vectors near-orthogonal instead of
    // piling every hash collision into the same polarity.
    const sign = (h & 1) === 0 ? 1 : -1;
    vector[h % dim]! += sign;
    vector[fnv1a(`:${word}`) % dim]! += sign * 0.5;
  }
  let norm = 0;
  for (let i = 0; i < dim; i += 1) norm += vector[i]! * vector[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i += 1) vector[i]! /= norm;
  }
  return vector;
}

/** Cosine similarity. Length mismatch → 0 (meaningless to compare). */
function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Code-unit ordering. Deliberately not `localeCompare`, whose result depends on
 * the ICU data compiled into the running Node build.
 */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compute undirected `related` edges between the given nodes.
 *
 * - Embeds each node once; a node whose text is empty, whose vector is zero, or
 *   whose embedder throws is skipped rather than failing the whole batch.
 * - Keeps the strongest pairs above `threshold`, admitting each only while both
 *   endpoints are still under the `topK` degree cap — so no node can become a
 *   hub, even when many documents score identically.
 * - Emits each undirected pair once, id-sorted, capped at `maxEdges`.
 */
export async function computeRelatedEdges(
  input: readonly RelatedNodeInput[],
  options: ComputeRelatedEdgesOptions = {},
): Promise<MemoryAtlasEdge[]> {
  const embed = options.embed ?? atlasEmbed;
  const threshold = options.threshold ?? RELATED_THRESHOLD;
  const topK = Math.max(1, Math.floor(options.topK ?? RELATED_TOP_K));
  const maxEdges = Math.max(0, Math.floor(options.maxEdges ?? RELATED_MAX_EDGES));
  const sourceId = options.sourceId ?? "memory";
  if (maxEdges === 0) return [];

  // Stable order in, stable order out. Duplicate ids collapse so a repeated
  // node can never be linked to itself.
  const unique = new Map<string, RelatedNodeInput>();
  for (const node of input) {
    if (!node || typeof node.id !== "string" || !node.id || typeof node.text !== "string") continue;
    if (!unique.has(node.id)) unique.set(node.id, node);
  }
  const nodes = [...unique.values()].sort((left, right) => compareIds(left.id, right.id));
  if (nodes.length < 2) return [];

  const vectors: Array<{ id: string; vec: Float32Array }> = [];
  for (const node of nodes) {
    const text = node.text.trim();
    if (!text) continue;
    let vec: Float32Array;
    try {
      vec = await embed(text);
    } catch {
      // One unembeddable document costs one node, not the whole feature.
      continue;
    }
    if (!vec || vec.length === 0) continue;
    let nonZero = false;
    for (let i = 0; i < vec.length; i += 1) {
      if (vec[i] !== 0) { nonZero = true; break; }
    }
    if (nonZero) vectors.push({ id: node.id, vec });
  }
  if (vectors.length < 2) return [];

  const scored: Array<{ source: string; target: string; score: number }> = [];
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      const score = cosine(vectors[i]!.vec, vectors[j]!.vec);
      if (score < threshold) continue;
      // `vectors` is id-sorted, so i < j already means source < target.
      scored.push({ source: vectors[i]!.id, target: vectors[j]!.id, score });
    }
  }

  scored.sort((left, right) => right.score - left.score
    || compareIds(left.source, right.source)
    || compareIds(left.target, right.target));

  const degree = new Map<string, number>();
  const edges: MemoryAtlasEdge[] = [];
  for (const pair of scored) {
    if (edges.length >= maxEdges) break;
    if ((degree.get(pair.source) ?? 0) >= topK) continue;
    if ((degree.get(pair.target) ?? 0) >= topK) continue;
    degree.set(pair.source, (degree.get(pair.source) ?? 0) + 1);
    degree.set(pair.target, (degree.get(pair.target) ?? 0) + 1);
    edges.push({ source: pair.source, target: pair.target, type: "related", sourceId });
  }
  return edges;
}
