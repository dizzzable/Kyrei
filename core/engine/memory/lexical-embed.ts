/**
 * Deterministic local lexical embedding for hybrid memory ranking.
 *
 * No external model/network: hashed bag-of-tokens + character trigrams into a
 * fixed L2-normalized vector. Good enough to boost FTS with semantic-ish
 * near-duplicates offline; replaceable later by a real embedding model under
 * the same VectorStore contract (model id changes the upsert key).
 */

export const LEXICAL_EMBED_MODEL = "kyrei-lexical-v1";
export const LEXICAL_EMBED_DIM = 256;

/** FNV-1a 32-bit hash → non-negative. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function tokenize(text: string): string[] {
  const lower = text.toLowerCase().normalize("NFKC");
  const words = lower.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const out: string[] = [...words];
  // Character trigrams capture partial / fuzzy matches without a stemmer.
  const compact = lower.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  for (const word of compact.split(/\s+/).filter(Boolean)) {
    if (word.length < 3) continue;
    const padded = ` ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) {
      out.push(`#${padded.slice(i, i + 3)}`);
    }
  }
  return out;
}

/**
 * Embed free text into a fixed-dim dense vector (L2-normalized).
 * Empty input yields the zero vector (callers should skip ranking).
 */
export function lexicalEmbed(text: string, dim = LEXICAL_EMBED_DIM): Float32Array {
  const v = new Float32Array(dim);
  const tokens = tokenize(text);
  if (tokens.length === 0) return v;
  for (const token of tokens) {
    const h = fnv1a(token);
    const idx = h % dim;
    // Signed contribution reduces collisions dumping into one polarity.
    const sign = (h & 1) === 0 ? 1 : -1;
    v[idx]! += sign;
    // Second hash bucket (like feature hashing trick).
    const h2 = fnv1a(`:${token}`);
    v[h2 % dim]! += sign * 0.5;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) v[i]! /= norm;
  }
  return v;
}

export function isZeroVector(v: Float32Array): boolean {
  for (let i = 0; i < v.length; i++) if (v[i] !== 0) return false;
  return true;
}
