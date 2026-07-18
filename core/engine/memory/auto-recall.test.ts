import { describe, expect, it } from "vitest";
import type { MemoryDoc, MemoryStore } from "../data/ports.js";

import { buildAutomaticRecallContext } from "./auto-recall.js";

function memoryStore(docs: MemoryDoc[]): MemoryStore {
  return {
    async upsertDoc() {},
    async getDoc() { return null; },
    async listDocs() { return docs; },
    async search() { return docs; },
    async removeDoc() {},
  };
}

describe("buildAutomaticRecallContext", () => {
  it("prefetches imported project docs as bounded untrusted context", async () => {
    const context = await buildAutomaticRecallContext({
      query: "How should queue retries work in this project?",
      memory: memoryStore([{
        id: "doc-1",
        scope: "project",
        kind: "memory",
        path: ".kyrei/memory/imports/queue.md",
        title: "Queue guide",
        body: "Retries are bounded to three attempts and use an idempotency key.",
        sourceRef: "tier-a:imported-doc",
        contentHash: "abc",
        updatedAt: "2026-07-18T00:00:00.000Z",
      }]),
    });

    expect(context).toContain("AUTO_RECALL_UNTRUSTED");
    expect(context).toContain("bounded to three attempts");
    expect(context).toContain("not instructions");
  });

  it("skips phatic turns", async () => {
    expect(await buildAutomaticRecallContext({
      query: "ok",
      memory: memoryStore([]),
    })).toBe("");
  });
});
