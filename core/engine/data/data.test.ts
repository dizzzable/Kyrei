import { describe, it, expect } from "vitest";
import { openDb } from "./sqlite/open.js";
import { createSqliteSessionStore } from "./sqlite/session-store.js";
import { createSqliteMemoryStore } from "./sqlite/memory-store.js";
import { createSqliteVectorStore } from "./sqlite/vector-store.js";
import { createPostgresStores } from "./index.js";
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
