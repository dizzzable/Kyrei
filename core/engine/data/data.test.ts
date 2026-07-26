import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./sqlite/open.js";
import { createSqliteSessionStore } from "./sqlite/session-store.js";
import { createSqliteMemoryStore } from "./sqlite/memory-store.js";
import { createSqliteVectorStore } from "./sqlite/vector-store.js";
import { createFileStores, createPostgresStores } from "./index.js";
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

      // Multi-word query whose terms are non-adjacent ("отлично" ... "работает"
      // straddle "kyrei"): AND-of-terms must match; a phrase query would not.
      const multi = await s.searchMessages("отлично работает", { sessionId: "s1" });
      expect(multi.length).toBeGreaterThanOrEqual(1);
    });

    it("clearMessages and deleteSession", async () => {
      const s = make();
      await s.createSession({ id: "s2", startedAt: nowIso(), status: "active", jsonlPath: "y", workspace: "/ws" });
      await s.appendMessage({
        sessionId: "s2",
        seq: 1,
        role: "user",
        parts: [{ type: "text", text: "temporary payload" }],
        text: "temporary payload",
        createdAt: nowIso(),
      });
      await s.appendMessage({
        sessionId: "s2",
        seq: 2,
        role: "assistant",
        parts: [{ type: "text", text: "will be cleared" }],
        text: "will be cleared",
        createdAt: nowIso(),
      });
      await s.clearMessages("s2");
      expect(await s.getMessages("s2")).toHaveLength(0);
      expect(await s.getSession("s2")).not.toBeNull();

      await s.appendMessage({
        sessionId: "s2",
        seq: 1,
        role: "user",
        parts: [{ type: "text", text: "fresh after clear" }],
        text: "fresh after clear",
        createdAt: nowIso(),
      });
      expect((await s.getMessages("s2")).map((m) => m.text)).toEqual(["fresh after clear"]);

      await s.deleteSession("s2");
      expect(await s.getSession("s2")).toBeNull();
      expect(await s.getMessages("s2")).toHaveLength(0);
    });

    it("persists provider binding and approval/pending cutover fields", async () => {
      const s = make();
      await s.createSession({
        id: "s3",
        startedAt: nowIso(),
        status: "working",
        jsonlPath: "z",
        workspace: "/ws",
        providerId: "p1",
        modelId: "m1",
        providerAccountId: "a1",
      });
      expect((await s.getSession("s3"))?.providerId).toBe("p1");
      expect((await s.getSession("s3"))?.modelId).toBe("m1");
      await s.appendMessage({
        sessionId: "s3",
        seq: 1,
        role: "assistant",
        parts: [
          {
            type: "approval",
            approvalId: "appr-cutover-1",
            toolCallId: "call-cutover-1",
            name: "write_file",
            reason: "ask",
            status: "pending",
          },
        ],
        text: "[approval:write_file:pending]",
        createdAt: nowIso(),
        clientId: "msg-cutover1",
        pending: true,
        turnStatus: "awaiting_approval",
        approvalModelParams: { effort: "minimal" },
      });
      const msgs = await s.getMessages("s3");
      expect(msgs[0]!.clientId).toBe("msg-cutover1");
      expect(msgs[0]!.pending).toBe(true);
      expect(msgs[0]!.parts[0]).toMatchObject({ type: "approval", status: "pending" });
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

  it("recalls on multi-word queries whose terms are not adjacent (AND-of-terms, not phrase)", async () => {
    const { db } = openDb(":memory:");
    const mem = createSqliteMemoryStore(db);
    await mem.upsertDoc({
      id: "d2",
      scope: "project",
      kind: "memory",
      path: "/ws/.kyrei/memory/MEMORY.md",
      body: "We prefer a local durable sqlite memory store with fts5 and vector cosine dedupe",
      contentHash: "h2",
      updatedAt: nowIso(),
      title: "MEMORY",
    });
    // Terms present but NOT adjacent — a phrase query would return zero rows.
    expect((await mem.search("durable memory store")).length).toBeGreaterThanOrEqual(1);
    expect((await mem.search("vector dedupe")).length).toBeGreaterThanOrEqual(1);
    // A term absent from the doc must still exclude it (AND semantics hold).
    expect((await mem.search("durable postgres")).length).toBe(0);
  });

  it("ranks by bm25 rather than insertion order", async () => {
    // Regression: the query had no ORDER BY, so FTS5 returned rows in rowid
    // order and LIMIT handed back the oldest-inserted matches. The weak match
    // is inserted first here specifically so insertion order would fail.
    const { db } = openDb(":memory:");
    const mem = createSqliteMemoryStore(db);
    const base = { scope: "project", kind: "memory", contentHash: "h", updatedAt: nowIso() } as const;
    await mem.upsertDoc({
      ...base,
      id: "weak",
      path: "/ws/weak.md",
      title: "Unrelated notes",
      body: `deployment checklist mentions rollback once. ${"filler sentence about unrelated topics. ".repeat(40)}`,
    });
    await mem.upsertDoc({
      ...base,
      id: "strong",
      path: "/ws/strong.md",
      title: "Rollback procedure",
      body: "rollback rollback rollback — the rollback procedure for a failed deploy.",
    });

    const hits = await mem.search("rollback");
    expect(hits.map((h) => h.id)).toEqual(["strong", "weak"]);
    expect(hits[0]!.relevance).toBeGreaterThan(hits[1]!.relevance);
  });

  it("reports relevance in (0,1] with 1 for the best hit", async () => {
    const { db } = openDb(":memory:");
    const mem = createSqliteMemoryStore(db);
    await mem.upsertDoc({
      id: "only",
      scope: "project",
      kind: "memory",
      path: "/ws/only.md",
      body: "a single matching document about widgets",
      contentHash: "h",
      updatedAt: nowIso(),
    });
    const [hit] = await mem.search("widgets");
    expect(hit?.relevance).toBe(1);
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

  it("filters by embedding model and never scores mismatched-dimension rows", async () => {
    const { db } = openDb(":memory:");
    const vec = createSqliteVectorStore(db);
    // Simulate an embed-mode switch: old 3-dim lexical rows + new 4-dim rows.
    await vec.upsert([
      { ownerType: "memory_doc", ownerId: "old", chunkIndex: 0, model: "lexical-256", embedding: new Float32Array([1, 0, 0]), contentHash: "o" },
      { ownerType: "memory_doc", ownerId: "new", chunkIndex: 0, model: "http-384", embedding: new Float32Array([1, 0, 0, 0]), contentHash: "n" },
    ]);
    // Querying with the new model + a 4-dim vector must return only the new row.
    const scoped = await vec.query(new Float32Array([0.9, 0.1, 0, 0]), { k: 5, model: "http-384" });
    expect(scoped.map((h) => h.ownerId)).toEqual(["new"]);
    // Without a model filter, the mismatched-dim old row is still safe: the
    // dimension guard scores it 0 similarity (distance 1), never a bogus hit.
    const unscoped = await vec.query(new Float32Array([0.9, 0.1, 0, 0]), { k: 5 });
    const oldHit = unscoped.find((h) => h.ownerId === "old");
    expect(oldHit?.distance).toBe(1);
  });
});

describe("file memory backend persistence", () => {
  it("survives close/reopen so reindex is not lost when SQLite is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kyrei-file-mem-"));
    try {
      const a = createFileStores(dir);
      await a.memory.upsertDoc({
        id: "persist-1",
        scope: "project",
        kind: "memory",
        path: ".kyrei/memory/MEMORY.md",
        workspace: dir,
        title: "MEMORY",
        body: "durable file-backend projection",
        contentHash: "abc",
        updatedAt: nowIso(),
      });
      await a.close();

      const b = createFileStores(dir);
      const doc = await b.memory.getDoc("persist-1");
      expect(doc?.body).toContain("durable file-backend");
      await b.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Postgres backend contract (skip if DATABASE_URL not set)
describe.skipIf(!process.env.DATABASE_URL)("Postgres SessionStore contract", () => {
  it("create/get/list/append/getMessages/search", async () => {
    const stores = await createPostgresStores(process.env.DATABASE_URL!);
    const s = stores.sessions;
    
    const testId = `pg-test-${Date.now()}`;
    await s.createSession({ id: testId, startedAt: nowIso(), status: "active", jsonlPath: "x", workspace: "/ws" });
    expect((await s.getSession(testId))?.id).toBe(testId);

    await s.appendMessage({
      sessionId: testId,
      seq: 1,
      role: "user",
      parts: [{ type: "text", text: "postgres test message" }],
      text: "postgres test message",
      createdAt: nowIso(),
    });

    const msgs = await s.getMessages(testId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("user");

    const found = await s.searchMessages("postgres", { sessionId: testId });
    expect(found.length).toBeGreaterThanOrEqual(1);
    
    await stores.close();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Postgres MemoryStore + FTS", () => {
  it("upsert/get/list/search/remove", async () => {
    const stores = await createPostgresStores(process.env.DATABASE_URL!);
    const mem = stores.memory;
    
    const docId = `pg-doc-${Date.now()}`;
    await mem.upsertDoc({
      id: docId,
      scope: "project",
      kind: "memory",
      path: "/ws/.kyrei/memory/PG.md",
      body: "postgres memory store with full-text search",
      contentHash: "h1",
      updatedAt: nowIso(),
      title: "PG Memory",
    });
    
    expect((await mem.getDoc(docId))?.id).toBe(docId);
    const hits = await mem.search("postgres");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    
    await mem.removeDoc(docId);
    expect(await mem.getDoc(docId)).toBe(null);
    
    await stores.close();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Postgres VectorStore", () => {
  it("upsert/query nearest", async () => {
    const stores = await createPostgresStores(process.env.DATABASE_URL!);
    const vec = stores.vectors;
    
    const ownerId = `pg-vec-${Date.now()}`;
    await vec.upsert([
      { ownerType: "doc", ownerId, chunkIndex: 0, model: "m", embedding: new Float32Array([1, 0, 0]), contentHash: "1" },
      { ownerType: "doc", ownerId: `${ownerId}-b`, chunkIndex: 0, model: "m", embedding: new Float32Array([0, 1, 0]), contentHash: "2" },
    ]);
    
    const hits = await vec.query(new Float32Array([0.9, 0.1, 0]), { k: 1 });
    expect(hits[0]!.ownerId).toBe(ownerId);
    
    await vec.deleteByOwner("doc", ownerId);
    const after = await vec.query(new Float32Array([0.9, 0.1, 0]), { k: 2 });
    expect(after.map((h) => h.ownerId)).not.toContain(ownerId);
    
    await stores.close();
  });
});
