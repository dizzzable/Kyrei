import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../core/session-store.js";
import { engineSessionToGateway } from "../core/session-engine-primary.js";

describe("session soft-archive", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kyrei-arch-"));
    store = new SessionStore({ runtimeDir: dir });
    await store.load();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("archives without dropping messages", () => {
    store.upsertSession({ id: "sess-1", title: "Keep me", createdAt: new Date().toISOString() });
    store.appendMessage("sess-1", { role: "user", content: "hello hybrid memory" });
    expect(store.listActiveSessions()).toHaveLength(1);

    store.setSessionArchived("sess-1", true);
    expect(store.listActiveSessions()).toHaveLength(0);
    expect(store.listArchivedSessions()).toHaveLength(1);
    expect(store.getMessages("sess-1")).toHaveLength(1);
    expect(store.getSession("sess-1")?.archived).toBe(true);
    expect(store.getSession("sess-1")?.archivedAt).toBeTruthy();
  });

  it("restores archive to active list", () => {
    store.upsertSession({ id: "sess-2", title: "Back", createdAt: new Date().toISOString() });
    store.setSessionArchived("sess-2", true);
    store.setSessionArchived("sess-2", false);
    expect(store.listActiveSessions().map((s) => s.id)).toEqual(["sess-2"]);
    expect(store.getSession("sess-2")?.archived).toBe(false);
    expect(store.getSession("sess-2")?.archivedAt).toBeUndefined();
  });

  it("permanent remove drops messages", () => {
    store.upsertSession({ id: "sess-3", title: "Gone", createdAt: new Date().toISOString() });
    store.appendMessage("sess-3", { role: "user", content: "bye" });
    store.setSessionArchived("sess-3", true);
    store.removeSession("sess-3");
    expect(store.getSession("sess-3")).toBeNull();
    expect(store.getMessages("sess-3")).toEqual([]);
  });

  it("engineSessionToGateway surfaces meta.archived", () => {
    const gw = engineSessionToGateway({
      id: "s1",
      title: "Archived chat",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "active",
      jsonlPath: "x",
      meta: { archived: true, archivedAt: "2026-07-01T12:00:00.000Z", updatedAt: "2026-07-01T12:00:00.000Z" },
    });
    expect(gw?.archived).toBe(true);
    expect(gw?.archivedAt).toBe("2026-07-01T12:00:00.000Z");
  });
});
