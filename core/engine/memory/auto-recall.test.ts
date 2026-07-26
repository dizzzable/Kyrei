import { describe, expect, it } from "vitest";
import type { MemoryDoc, MemoryHit, MemoryStore } from "../data/ports.js";
import { openDb } from "../data/sqlite/open.js";
import { createSqliteMemoryStore } from "../data/sqlite/memory-store.js";

import { buildAutomaticRecallContext, salientTerms } from "./auto-recall.js";

const hit = (doc: MemoryDoc): MemoryHit => ({ ...doc, relevance: 1 });

/** Records what the caller asked for; returns everything regardless. */
function recordingStore(docs: MemoryDoc[]) {
  const calls: Array<{ query: string; opts?: { limit?: number; match?: string } }> = [];
  const store: MemoryStore = {
    async upsertDoc() {},
    async getDoc() { return null; },
    async listDocs() { return docs; },
    async search(query, opts) {
      calls.push({ query, ...(opts ? { opts } : {}) });
      return docs.map(hit);
    },
    async removeDoc() {},
  };
  return { store, calls };
}

const IMPORTED = {
  id: "doc-1",
  scope: "project",
  kind: "memory",
  path: ".kyrei/memory/imports/queue.md",
  title: "Queue guide",
  body: "Retries are bounded to three attempts and use an idempotency key.",
  sourceRef: "tier-a:imported-doc",
  contentHash: "abc",
  updatedAt: "2026-07-18T00:00:00.000Z",
} satisfies MemoryDoc;

describe("salientTerms", () => {
  it("drops stopwords and short tokens, longest first", () => {
    // "how/should/the/in/this" are stopwords; equal-length terms keep the order
    // they appeared in.
    expect(salientTerms("How should the queue retries work in this project?"))
      .toEqual(["retries", "project", "queue", "work"]);
  });

  it("deduplicates and caps the term count", () => {
    expect(salientTerms("alpha alpha beta gamma delta epsilon zeta eta theta iota", 4)).toHaveLength(4);
  });

  it("returns nothing for a query made only of stopwords", () => {
    expect(salientTerms("what is it that we should do")).toEqual([]);
  });
});

describe("buildAutomaticRecallContext", () => {
  it("prefetches imported project docs as bounded untrusted context", async () => {
    const { store } = recordingStore([IMPORTED]);
    const context = await buildAutomaticRecallContext({
      query: "How should queue retries work in this project?",
      memory: store,
    });

    expect(context).toContain("AUTO_RECALL_UNTRUSTED");
    expect(context).toContain("bounded to three attempts");
    expect(context).toContain("not instructions");
  });

  it("queries salient terms with OR, not the raw message ANDed", async () => {
    // Regression: the whole (up to 4000-char) message went straight to a
    // matcher that ANDs every token, so a normal question matched nothing.
    const { store, calls } = recordingStore([IMPORTED]);
    await buildAutomaticRecallContext({
      query: "How should queue retries work in this project, and what about the idempotency key?",
      memory: store,
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.opts?.match).toBe("any");
    expect(call!.query).not.toContain("How should");
    expect(call!.query.split(" ")).toContain("retries");
    expect(call!.query.split(" ").length).toBeLessThanOrEqual(8);
  });

  it("over-fetches so the sourceRef filter has candidates to work with", async () => {
    // The filter used to run after a limit of 4, so the rows fetched were
    // rarely the doc kinds it keeps.
    const { store, calls } = recordingStore([IMPORTED]);
    await buildAutomaticRecallContext({ query: "queue retries idempotency", memory: store, limit: 4 });
    expect(calls[0]!.opts?.limit).toBeGreaterThan(4);
  });

  it("recalls a real imported doc from a natural-language question end to end", async () => {
    const { db } = openDb(":memory:");
    const store = createSqliteMemoryStore(db);
    await store.upsertDoc(IMPORTED);
    await store.upsertDoc({
      ...IMPORTED,
      id: "doc-2",
      path: ".kyrei/memory/imports/unrelated.md",
      title: "Styling",
      body: "Buttons use a 4px radius and the accent token.",
    });

    const context = await buildAutomaticRecallContext({
      query: "How should queue retries work in this project?",
      memory: store,
    });
    expect(context).toContain("bounded to three attempts");
  });

  it("excludes layers that are already injected separately", async () => {
    // MEMORY.md, decisions, plan and handoffs have their own prompt layers;
    // recalling them here would duplicate them.
    const { store } = recordingStore([{ ...IMPORTED, id: "mem", sourceRef: "tier-a:memory-md" }]);
    expect(await buildAutomaticRecallContext({ query: "queue retries idempotency", memory: store })).toBe("");
  });

  it("skips phatic turns", async () => {
    const { store, calls } = recordingStore([]);
    expect(await buildAutomaticRecallContext({ query: "ok", memory: store })).toBe("");
    expect(calls).toHaveLength(0);
  });
});
