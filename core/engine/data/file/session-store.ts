/**
 * File-based SessionStore (Phase 5 default backend).
 * JSONL transcript per session is the source of truth; a JSON index gives fast
 * listing. Zero native deps → works on every OS and inside Electron's Node.
 * SQLite (better-sqlite3 / node:sqlite) is a future backend behind this same port.
 * Requirements §10.1–§10.3.
 */

import { mkdir, open, readFile, rename, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SessionStore, SessionRecord, StoredMessage } from "../ports.js";

export function createFileSessionStore(baseDir: string): SessionStore {
  const transcriptsDir = join(baseDir, "transcripts");
  const indexPath = join(baseDir, "sessions.json");

  async function ensure(): Promise<void> {
    await mkdir(transcriptsDir, { recursive: true });
  }
  async function loadIndex(): Promise<Record<string, SessionRecord>> {
    let raw: string;
    try {
      raw = await readFile(indexPath, "utf8");
    } catch {
      return {}; // no index yet — fresh store
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, SessionRecord>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      // The index exists but is unparseable. Returning {} and letting the next
      // saveIndex write over it destroyed the session list outright, so keep
      // the bytes: the transcripts are still on disk and recoverable from them.
      const quarantine = `${indexPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await rename(indexPath, quarantine).catch(() => {});
      console.error(
        `[kyrei file-store] ${indexPath} is corrupt; moved to ${quarantine}. `
        + `Transcripts under ${transcriptsDir} are intact.`,
      );
      return {};
    }
  }
  async function saveIndex(idx: Record<string, SessionRecord>): Promise<void> {
    await ensure();
    // Atomic: a plain writeFile truncates in place, so a crash mid-write left a
    // half-written index that loadIndex then had to quarantine.
    const tmp = `${indexPath}.${process.pid}-${Date.now().toString(36)}.tmp`;
    let handle;
    try {
      handle = await open(tmp, "wx");
      await handle.writeFile(JSON.stringify(idx, null, 2), "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(tmp, indexPath);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await rm(tmp, { force: true }).catch(() => {});
    }
  }
  const transcriptPath = (id: string) => join(transcriptsDir, `${encodeURIComponent(id)}.jsonl`);

  return {
    async createSession(rec: SessionRecord): Promise<void> {
      const idx = await loadIndex();
      idx[rec.id] = { ...rec, jsonlPath: transcriptPath(rec.id) };
      await saveIndex(idx);
      await ensure();
      await writeFile(transcriptPath(rec.id), "", { flag: "a" });
    },

    async updateSession(id: string, patch: Partial<SessionRecord>): Promise<void> {
      const idx = await loadIndex();
      const cur = idx[id];
      if (!cur) return;
      idx[id] = { ...cur, ...patch, id };
      await saveIndex(idx);
    },

    async getSession(id: string): Promise<SessionRecord | null> {
      const idx = await loadIndex();
      return idx[id] ?? null;
    },

    async listSessions(opts): Promise<SessionRecord[]> {
      const idx = await loadIndex();
      let list = Object.values(idx);
      if (opts?.workspace) list = list.filter((s) => s.workspace === opts.workspace);
      list.sort((a, b) => (b.startedAt < a.startedAt ? -1 : 1));
      return opts?.limit ? list.slice(0, opts.limit) : list;
    },

    async deleteSession(id: string): Promise<void> {
      const idx = await loadIndex();
      delete idx[id];
      await saveIndex(idx);
      try {
        await rm(transcriptPath(id), { force: true });
      } catch {
        /* missing transcript is fine */
      }
    },

    async clearMessages(sessionId: string): Promise<void> {
      await ensure();
      await writeFile(transcriptPath(sessionId), "", "utf8");
    },

    async appendMessage(msg: StoredMessage): Promise<number> {
      await ensure();
      await appendFile(transcriptPath(msg.sessionId), JSON.stringify(msg) + "\n", "utf8");
      return msg.seq;
    },

    async getMessages(sessionId: string, opts): Promise<StoredMessage[]> {
      let raw: string;
      try {
        raw = await readFile(transcriptPath(sessionId), "utf8");
      } catch {
        return [];
      }
      // Per-line tolerance, matching every other JSONL reader in the codebase.
      // A bare `.map(JSON.parse)` meant one crash-truncated tail line threw
      // away the whole transcript — and because searchMessages iterates every
      // session, a single corrupt file also took global search down with it.
      // This is the FALLBACK backend, used when better-sqlite3 fails to load,
      // so it has to be the most forgiving reader, not the least.
      const msgs: StoredMessage[] = [];
      let dropped = 0;
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          msgs.push(JSON.parse(line) as StoredMessage);
        } catch {
          dropped += 1;
        }
      }
      if (dropped > 0) {
        console.warn(
          `[kyrei file-store] skipped ${dropped} unreadable line(s) in the transcript for ${sessionId}; `
          + `${msgs.length} message(s) recovered.`,
        );
      }
      return opts?.fromSeq != null ? msgs.filter((m) => m.seq >= opts.fromSeq!) : msgs;
    },

    async markCompacted(sessionId: string, seqRange: [number, number], ccrHash: string): Promise<void> {
      const msgs = await this.getMessages(sessionId);
      let changed = false;
      for (const m of msgs) {
        if (m.seq >= seqRange[0] && m.seq <= seqRange[1]) {
          m.compacted = true;
          m.ccrHash = ccrHash;
          changed = true;
        }
      }
      if (changed) {
        await writeFile(transcriptPath(sessionId), msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf8");
      }
    },

    async searchMessages(query: string, opts): Promise<StoredMessage[]> {
      const q = query.toLowerCase();
      const limit = opts?.limit ?? 50;
      const hits: StoredMessage[] = [];
      const ids = opts?.sessionId ? [opts.sessionId] : await this.listSessions().then((s) => s.map((x) => x.id));
      for (const id of ids) {
        for (const m of await this.getMessages(id)) {
          if ((m.text ?? "").toLowerCase().includes(q)) {
            hits.push(m);
            if (hits.length >= limit) return hits;
          }
        }
      }
      return hits;
    },
  };
}

/** Utility: derive plain text from message parts for the `text` index field. */
export function partsText(parts: StoredMessage["parts"]): string {
  return parts
    .map((p) => (p.type === "text" || p.type === "reasoning" ? p.text : p.type === "tool" ? (p.result ?? "") : ""))
    .join("\n")
    .trim();
}
