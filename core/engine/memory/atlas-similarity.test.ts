import { describe, expect, it } from "vitest";

import { atlasEmbed, computeRelatedEdges, RELATED_TOP_K, type RelatedNodeInput } from "./atlas-similarity";

/**
 * A tiny deterministic embedder: maps text to a 3-dim vector by keyword. Nodes
 * sharing a keyword get near-identical vectors (cosine ≈ 1); different keywords
 * are orthogonal (cosine 0). Keeps the test independent of the lexical model.
 */
function keywordEmbed(text: string): Float32Array {
  const v = new Float32Array(3);
  if (text.includes("alpha")) v[0] = 1;
  if (text.includes("beta")) v[1] = 1;
  if (text.includes("gamma")) v[2] = 1;
  return v;
}

const nodes = (entries: Array<[string, string]>): RelatedNodeInput[] =>
  entries.map(([id, text]) => ({ id, text }));

describe("computeRelatedEdges", () => {
  it("links nodes above the similarity threshold and skips dissimilar ones", async () => {
    const edges = await computeRelatedEdges(
      nodes([
        ["memory:a1", "alpha topic one"],
        ["memory:a2", "alpha topic two"],
        ["memory:b1", "beta unrelated"],
      ]),
      { embed: keywordEmbed, threshold: 0.9 },
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: "memory:a1", target: "memory:a2", type: "related", sourceId: "memory" });
  });

  it("is deterministic and order-independent — shuffled input yields the same edges", async () => {
    const input = nodes([
      ["memory:a2", "alpha two"],
      ["memory:a1", "alpha one"],
      ["memory:a3", "alpha three"],
    ]);
    const first = await computeRelatedEdges(input, { embed: keywordEmbed, threshold: 0.9 });
    const shuffled = [input[2]!, input[0]!, input[1]!];
    const second = await computeRelatedEdges(shuffled, { embed: keywordEmbed, threshold: 0.9 });
    expect(second).toEqual(first);
  });

  it("dedupes undirected pairs (emits each pair once, id-sorted)", async () => {
    const edges = await computeRelatedEdges(
      nodes([
        ["memory:z", "alpha"],
        ["memory:a", "alpha"],
      ]),
      { embed: keywordEmbed, threshold: 0.9 },
    );
    expect(edges).toHaveLength(1);
    // Sorted so the lexicographically smaller id is the source.
    expect(edges[0]!.source).toBe("memory:a");
    expect(edges[0]!.target).toBe("memory:z");
  });

  it("respects the maxEdges cap", async () => {
    const input = nodes(
      Array.from({ length: 6 }, (_, i) => [`memory:a${i}`, "alpha shared"] as [string, string]),
    );
    const edges = await computeRelatedEdges(input, { embed: keywordEmbed, threshold: 0.9, maxEdges: 3 });
    expect(edges).toHaveLength(3);
    expect(edges.every((edge) => edge.type === "related")).toBe(true);
  });

  it("skips empty text and zero vectors but still links the usable pair", async () => {
    const edges = await computeRelatedEdges(
      nodes([
        ["memory:a1", "alpha"],
        ["memory:a2", "alpha again"],
        ["memory:empty", "   "],
        ["memory:unknown", "delta epsilon"],
      ]),
      { embed: keywordEmbed, threshold: 0.9 },
    );
    // "empty" is blank and "unknown" embeds to the zero vector — both dropped,
    // without taking the a1/a2 link down with them.
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: "memory:a1", target: "memory:a2" });
  });

  it("caps per-node degree so no node becomes a hub when scores tie", async () => {
    // 12 identical documents: every pair scores 1.0. Without a degree cap the
    // tie-break would wire the whole set to whichever ids sort first.
    const input = nodes(
      Array.from({ length: 12 }, (_, i) => [`memory:d${String(i).padStart(2, "0")}`, "alpha"] as [string, string]),
    );
    const edges = await computeRelatedEdges(input, { embed: keywordEmbed, threshold: 0.9, maxEdges: 1_000 });
    const degree = new Map<string, number>();
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    expect(Math.max(...degree.values())).toBeLessThanOrEqual(RELATED_TOP_K);
    expect(edges.every((edge) => edge.source !== edge.target)).toBe(true);
  });

  it("collapses duplicate ids instead of emitting a self-edge", async () => {
    const edges = await computeRelatedEdges(
      nodes([
        ["memory:x", "alpha"],
        ["memory:x", "alpha"],
        ["memory:y", "alpha"],
      ]),
      { embed: keywordEmbed, threshold: 0.9 },
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: "memory:x", target: "memory:y" });
  });

  it("drops only the offending node when the embedder throws", async () => {
    const flaky = (text: string): Float32Array => {
      if (text.includes("poison")) throw new Error("embed failed");
      return keywordEmbed(text);
    };
    const edges = await computeRelatedEdges(
      nodes([
        ["memory:a1", "alpha one"],
        ["memory:a2", "alpha two"],
        ["memory:bad", "poison alpha"],
      ]),
      { embed: flaky, threshold: 0.9 },
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: "memory:a1", target: "memory:a2" });
  });
});

describe("atlasEmbed separation (the default, offline embedder)", () => {
  // Regression guard: the first implementation reused the FTS lexical embedder,
  // whose character trigrams saturate on prose. Every pair of ~1k-char English
  // documents scored 0.84-0.90 regardless of topic, so the feature emitted an
  // effectively random graph. These two tests pin the property that matters —
  // unrelated documents must stay below the threshold and related ones above.
  const UNRELATED = [
    ["memory:pasta", "Weeknight pasta. Salt the boiling water aggressively, warm olive oil in a wide pan with thinly sliced garlic and dried chilli flakes, then reserve a mug of the starchy cooking water before draining the spaghetti."],
    ["memory:cathedral", "Medieval cathedral construction. A pointed arch directs thrust more steeply downward than a rounded one and therefore needs far less lateral buttressing, which let the walls open into large glazed areas."],
    ["memory:weather", "Weather observations. Mornings were persistently overcast with light drizzle clearing before midday, afternoons broke into scattered cloud, and the prevailing wind remained westerly throughout the month."],
    ["memory:chain", "Bicycle drivetrain maintenance. Chain wear is measured by elongation rather than visible dirt, and a stretched chain carves matching wear into the cassette sprockets so it will skip under load."],
  ] as const;

  it("keeps unrelated documents unlinked", async () => {
    const edges = await computeRelatedEdges(nodes(UNRELATED.map(([id, text]) => [id, text])));
    expect(edges).toEqual([]);
  });

  it("links documents that genuinely share a subject", async () => {
    const related: Array<[string, string]> = [
      ["memory:pool1", "Database connection exhaustion under load. Every worker process instantiates its own independent pool at startup, so the ceiling on simultaneous backend connections is the pool size multiplied by the worker count, and sustained traffic pushes it past the server maximum."],
      ["memory:pool2", "Fix for the pool exhaustion incident. We capped the per worker connection pool so pool size times worker count stays beneath the configured server maximum, and intend to add a multiplexing proxy so idle client sessions stop holding backend connections open."],
    ];
    const edges = await computeRelatedEdges(nodes([...UNRELATED.map(([id, text]) => [id, text] as [string, string]), ...related]));
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: "memory:pool1", target: "memory:pool2", type: "related" });
  });

  it("produces an L2-normalized vector and a zero vector for empty text", () => {
    const vector = atlasEmbed("connection pool exhaustion");
    let norm = 0;
    for (const value of vector) norm += value * value;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
    expect(atlasEmbed("   ").every((value) => value === 0)).toBe(true);
  });
});
