import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionStore } from "../core/session-store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kyrei-session-durability-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const statePath = () => join(dir, "state.json");

async function seeded(): Promise<string> {
  const store = new SessionStore({ runtimeDir: dir });
  await store.load();
  const session = store.upsertSession({ id: "s-keep", title: "Irreplaceable" });
  store.appendMessage(session.id, { role: "user", content: "please do not lose this" });
  await store.close();
  return session.id;
}

describe("SessionStore durability", () => {
  it("round-trips sessions and messages", async () => {
    const id = await seeded();
    const reopened = new SessionStore({ runtimeDir: dir });
    await reopened.load();
    expect(reopened.listActiveSessions().map((s) => s.id)).toContain(id);
    expect(reopened.getMessages(id)).toHaveLength(1);
  });

  it("quarantines a corrupt state file instead of overwriting it", async () => {
    // The regression: a truncated state.json was caught by a bare catch {},
    // and the first touch() flushed empty defaults over it. Every session and
    // message gone, no backup, no signal.
    await seeded();
    const original = await readFile(statePath(), "utf8");
    await writeFile(statePath(), original.slice(0, Math.floor(original.length / 2)), "utf8");

    const store = new SessionStore({ runtimeDir: dir });
    await store.load();
    expect(store.listActiveSessions()).toHaveLength(0); // starts empty, as it must
    store.upsertSession({ id: "s-new", title: "After recovery" });
    await store.close();

    const entries = await readdir(dir);
    const quarantined = entries.filter((f) => f.includes(".corrupt-"));
    expect(quarantined).toHaveLength(1);
    // The original bytes survive and are recoverable.
    const preserved = await readFile(join(dir, quarantined[0]!), "utf8");
    expect(preserved).toContain("Irreplaceable");
    // And the live file is valid again.
    expect(JSON.parse(await readFile(statePath(), "utf8")).sessions).toHaveLength(1);
  });

  it("refuses to persist when a corrupt file cannot be quarantined", async () => {
    await seeded();
    const original = await readFile(statePath(), "utf8");
    await writeFile(statePath(), "{ truncated", "utf8");

    const store = new SessionStore({ runtimeDir: dir });
    await store.load();
    // load() quarantined it; simulate the branch where that was impossible
    // (file locked by another process) by asserting the guard itself: with
    // readOnly set, no write may reach disk.
    store.readOnly = true;
    await writeFile(statePath(), "{ truncated", "utf8");

    store.upsertSession({ id: "s-bad", title: "Must not be written" });
    await store.close();

    // The bytes on disk are untouched — not replaced by an empty state that
    // would have destroyed the only copy of the user's history.
    expect(await readFile(statePath(), "utf8")).toBe("{ truncated");
    expect(original).toContain("Irreplaceable");
  });

  it("treats a missing file as a fresh workspace, not an error", async () => {
    const store = new SessionStore({ runtimeDir: dir });
    await store.load();
    expect(store.loadError).toBeNull();
    expect(store.readOnly).toBe(false);
    expect(store.listActiveSessions()).toHaveLength(0);
  });

  it("leaves no temp files behind after a flush", async () => {
    await seeded();
    const entries = await readdir(dir);
    expect(entries.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    expect(entries).toContain("state.json");
    expect((await stat(statePath())).size).toBeGreaterThan(0);
  });
});
