/**
 * LTM bridge (Requirements §6.5). Uses the existing `ltm/store/*.jsonl` as the
 * SINGLE ledger — no duplicate journal. Appends events/checkpoints in the
 * documented format with id generation, secret redaction, and a file lock.
 */

import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "./lock.js";
import { redact } from "../security/secrets.js";

export interface LtmEvent {
  filesChanged: string[];
  branch?: string;
  sessionId: string;
  source: "kyrei:apply" | "kyrei:tool" | "kyrei:manual";
  summary?: string;
}
export interface LtmCheckpoint {
  summary: string;
  changedFiles: string[];
  decisions: Array<{ decision: string; rationale: string }>;
  openThreads: string[];
  nextActions: string[];
  sessionId: string;
}

async function countLines(path: string): Promise<number> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function nextId(prefix: string, n: number): string {
  return `${prefix}_${String(n + 1).padStart(6, "0")}`;
}

export function createLtmBridge(ltmDir: string) {
  const storeDir = join(ltmDir, "store");
  const eventsPath = join(storeDir, "events.jsonl");
  const checkpointsPath = join(storeDir, "checkpoints.jsonl");

  async function appendEvent(e: LtmEvent): Promise<string> {
    await mkdir(storeDir, { recursive: true });
    return withFileLock(eventsPath, async () => {
      const id = nextId("evt", await countLines(eventsPath));
      const rec = {
        id,
        ts: new Date().toISOString(),
        type: "file_write",
        summary: redact(e.summary ?? ""),
        files_changed_count: e.filesChanged.length,
        files_sample: e.filesChanged.slice(0, 15).map((f) => redact(f)),
        branch: e.branch ?? "",
        session_id: e.sessionId,
        source: e.source,
        git_status: "ok",
        tags: [],
        redacted: true,
      };
      await appendFile(eventsPath, JSON.stringify(rec) + "\n", "utf8");
      return id;
    });
  }

  async function appendCheckpoint(c: LtmCheckpoint): Promise<string> {
    await mkdir(storeDir, { recursive: true });
    return withFileLock(checkpointsPath, async () => {
      const id = nextId("chk", await countLines(checkpointsPath));
      const rec = {
        id,
        ts: new Date().toISOString(),
        summary: redact(c.summary),
        changed_files: c.changedFiles.map((f) => redact(f)),
        decisions: c.decisions.map((d) => ({ decision: redact(d.decision), rationale: redact(d.rationale) })),
        open_threads: c.openThreads,
        next_actions: c.nextActions.map((a) => redact(a)),
        session_id: c.sessionId,
      };
      await appendFile(checkpointsPath, JSON.stringify(rec) + "\n", "utf8");
      return id;
    });
  }

  async function recall(): Promise<{ activeContext: unknown; lastRecall: string }> {
    const runtime = join(ltmDir, "runtime");
    let activeContext: unknown = null;
    let lastRecall = "";
    try {
      activeContext = JSON.parse(await readFile(join(runtime, "active-context.json"), "utf8"));
    } catch {
      /* none */
    }
    try {
      lastRecall = await readFile(join(runtime, "last-recall.md"), "utf8");
    } catch {
      /* none */
    }
    return { activeContext, lastRecall };
  }

  return { appendEvent, appendCheckpoint, recall };
}
