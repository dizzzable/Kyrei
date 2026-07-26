import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFileSessionStore } from "./session-store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kyrei-file-store-"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const transcript = (id: string) => join(dir, "transcripts", `${encodeURIComponent(id)}.jsonl`);

const message = (sessionId: string, seq: number, text: string) => ({
  sessionId,
  seq,
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
  text,
  createdAt: new Date().toISOString(),
});

async function seeded(count = 4) {
  const store = createFileSessionStore(dir);
  await store.createSession({ id: "s1", startedAt: new Date().toISOString() } as never);
  for (let seq = 0; seq < count; seq += 1) {
    await store.appendMessage(message("s1", seq, `message ${seq}`));
  }
  return store;
}

describe("file SessionStore — corruption tolerance", () => {
  it("round-trips messages", async () => {
    const store = await seeded();
    expect(await store.getMessages("s1")).toHaveLength(4);
  });

  it("recovers the intact lines when the tail is truncated", async () => {
    // Regression: `.map(JSON.parse)` with no per-line guard threw, so one
    // crash-truncated line discarded the entire transcript. This is the
    // fallback backend used when better-sqlite3 fails to load.
    const store = await seeded();
    const raw = await readFile(transcript("s1"), "utf8");
    await writeFile(transcript("s1"), `${raw}{"seq":4,"role":"user","te`, "utf8");

    const msgs = await store.getMessages("s1");
    expect(msgs).toHaveLength(4);
    expect(msgs.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
  });

  it("skips an interior bad line instead of losing everything after it", async () => {
    const store = await seeded();
    const lines = (await readFile(transcript("s1"), "utf8")).split("\n").filter(Boolean);
    lines.splice(2, 0, "{ not json");
    await writeFile(transcript("s1"), `${lines.join("\n")}\n`, "utf8");

    expect((await store.getMessages("s1")).map((m) => m.seq)).toEqual([0, 1, 2, 3]);
  });

  it("keeps global search working when one transcript is corrupt", async () => {
    const store = await seeded();
    await store.createSession({ id: "s2", startedAt: new Date().toISOString() } as never);
    await store.appendMessage(message("s2", 0, "findable"));
    await writeFile(transcript("s1"), "{ broken", "utf8");

    // searchMessages iterates every session; a throw here used to take the
    // whole search down for every session, not just the damaged one.
    const hits = await store.searchMessages("findable", {});
    expect(hits.map((m) => m.text)).toEqual(["findable"]);
  });

  it("quarantines a corrupt index instead of overwriting it", async () => {
    const store = await seeded();
    await writeFile(join(dir, "sessions.json"), "{ truncated", "utf8");

    expect(await store.listSessions({})).toHaveLength(0);
    await store.createSession({ id: "s3", startedAt: new Date().toISOString() } as never);

    const quarantined = (await readdir(dir)).filter((f) => f.includes("sessions.json.corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(await readFile(join(dir, quarantined[0]!), "utf8")).toBe("{ truncated");
    // Transcripts are untouched, so the lost sessions remain recoverable.
    expect(await readdir(join(dir, "transcripts"))).toContain("s1.jsonl");
  });

  it("leaves no temp file behind when saving the index", async () => {
    await seeded();
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });
});
