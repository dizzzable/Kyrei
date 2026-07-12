import { describe, it, expect } from "vitest";
import { openDb } from "./sqlite/open.js";
import { createSqliteSessionStore } from "./sqlite/session-store.js";
import { createSqliteMemoryStore } from "./sqlite/memory-store.js";
import { createSqliteVectorStore } from "./sqlite/vector-store.js";
import type { SessionStore } from "./ports.js";

function nowIso() {
  return new Date().toISOString();
}

// ── Shared SessionStore contract (Requirements §10.3) ──
function sessionContract(name: string, make: () => SessionStore) {
  describe(`SessionStore contract — ${name}`, () => {
    it("create/get/list/append/getMessages/search", async () => {
      const s = make();
      await s.createSession({ id: "s1", startedAt: nowIso(), status: "active", jsonlPath: "x", workspace: "/ws" });
      expect((await s.getSession("s1"))?.id).toBe("s1");

      await s.appendMessage({
        sessionId: "s1",
        seq: 1,
        role: "user",
        parts: [{ type: "text", text: "привет как дела" }],
        text: "привет как дела",
        createdAt: nowIso(),
      });
      await s.appendMessage({
        sessionId: "s1",
        seq: 2,
        role: "assistant",
        parts: [{ type: "text", text: "всё отлично kyrei работает" }],
        text: "всё отлично kyrei работает",
        createdAt: nowIso(),
      });

      const msgs = await s.getMessages("s1");
      expect(msgs).toHaveLength(2);
      expect(msgs[1]!.role).toBe("assistant");

      const list = await s.listSessions();
      expect(list.map((x) => x.id)).toContain("s1");

      const found = await s.searchMessages("kyrei", { sessionId: "s1" });
      expect(found.length).toBeGreaterThanOrEqual(1);
    });
  });
}

// SQLite backend (in-memory) — primary.
sessionContract("sqlite", () => createSqliteSessionStore(openDb(":memory:").db));

describe("SQLite MemoryStore + FTS", () => {
  it("upsert/get/list/search/remove", async () => {
    const { db } = openDb(":memory:");
    const mem = createSqliteMemoryStore(db);
    await mem.upsertDoc({
      id: "d1",
      scope: "project",
      kind: "memory",
      path: "/ws/.kyrei/memory/MEMORY.md",
      body: "проект использует sqlite и fts5 для поиска",
      contentHash: "h1",
      updatedAt: nowIso(),
      title: "MEMORY",
    });
    expect((await mem.getDoc("d1"))?.id).toBe("d1");
    expect((await mem.listDocs({ scope: "project" })).length).toBe(1);
    const hits = await mem.search("fts5");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    await mem.removeDoc("d1");
    expect(await mem.getDoc("d1")).toBe(null);
  });
});

describe("SQLite VectorStore (brute-force cosine)", () => {
  it("upsert/query nearest", async () => {
    const { db } = openDb(":memory:");
    const vec = createSqliteVectorStore(db);
    await vec.upsert([
      { ownerType: "doc", ownerId: "a", chunkIndex: 0, model: "m", embedding: new Float32Array([1, 0, 0]), contentHash: "1" },
      { ownerType: "doc", ownerId: "b", chunkIndex: 0, model: "m", embedding: new Float32Array([0, 1, 0]), contentHash: "2" },
    ]);
    const hits = await vec.query(new Float32Array([0.9, 0.1, 0]), { k: 1 });
    expect(hits[0]!.ownerId).toBe("a");
    await vec.deleteByOwner("doc", "a");
    const after = await vec.query(new Float32Array([0.9, 0.1, 0]), { k: 2 });
    expect(after.map((h) => h.ownerId)).not.toContain("a");
  });
});
