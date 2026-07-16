/**
 * LTM bridge (Requirements §6.5). Uses the existing `ltm/store/*.jsonl` as the
 * SINGLE ledger — no duplicate journal. Appends events/checkpoints in the
 * documented format with id generation, secret redaction, and a file lock.
 */

import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
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

/**
 * Bi-temporal architectural decision record (inspired by Zep/Graphiti's
 * approach to fact invalidation). A decision is never physically deleted:
 * superseding it sets `validTo`, preserving "what was true then" alongside
 * "what is true now". Mirrors the Python `ltm.py decision add/invalidate`
 * contract so both writers stay compatible on the same ledger.
 */
export interface LtmDecisionRecord {
  id: string;
  decision: string;
  rationale: string;
  validFrom: string;
  validTo: string | null;
  tags: string[];
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
  const decisionsPath = join(storeDir, "decisions.jsonl");

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

  function toDecisionRecord(rec: Record<string, unknown>): LtmDecisionRecord {
    return {
      id: String(rec["id"] ?? ""),
      decision: String(rec["decision"] ?? ""),
      rationale: String(rec["rationale"] ?? ""),
      validFrom: String(rec["valid_from"] ?? ""),
      validTo: rec["valid_to"] == null ? null : String(rec["valid_to"]),
      tags: Array.isArray(rec["tags"]) ? rec["tags"].map(String) : [],
      sessionId: String(rec["session_id"] ?? ""),
    };
  }

  async function readDecisions(): Promise<Record<string, unknown>[]> {
    try {
      const raw = await readFile(decisionsPath, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  /**
   * Record a new architectural decision. Never overwrites or deletes a prior
   * decision — call `invalidateDecision` to mark an existing one superseded.
   */
  async function addDecision(input: {
    decision: string;
    rationale?: string;
    tags?: string[];
    sessionId: string;
  }): Promise<string> {
    await mkdir(storeDir, { recursive: true });
    return withFileLock(decisionsPath, async () => {
      const id = nextId("dec", await countLines(decisionsPath));
      const rec = {
        id,
        decision: redact(input.decision),
        rationale: redact(input.rationale ?? ""),
        valid_from: new Date().toISOString(),
        valid_to: null,
        tags: input.tags ?? [],
        session_id: input.sessionId,
      };
      await appendFile(decisionsPath, JSON.stringify(rec) + "\n", "utf8");
      return id;
    });
  }

  /**
   * Mark a previously recorded decision as no longer active by setting
   * `valid_to`. The record itself is preserved (rewrite, not delete) so a
   * later query can still answer "what was true then".
   */
  async function invalidateDecision(id: string): Promise<boolean> {
    return withFileLock(decisionsPath, async () => {
      const records = await readDecisions();
      const target = records.find((r) => r["id"] === id && r["valid_to"] == null);
      if (!target) return false;
      target["valid_to"] = new Date().toISOString();
      await writeFile(decisionsPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
      return true;
    });
  }

  /** List decisions. By default only currently-active (`validTo === null`) ones. */
  async function listDecisions(opts: { includeInvalidated?: boolean } = {}): Promise<LtmDecisionRecord[]> {
    const records = (await readDecisions()).map(toDecisionRecord);
    return opts.includeInvalidated ? records : records.filter((r) => r.validTo === null);
  }

  async function readJsonlTail(path: string, maxLines: number): Promise<Record<string, unknown>[]> {
    try {
      const raw = await readFile(path, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      return lines.slice(Math.max(0, lines.length - maxLines)).map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  /**
   * Best-effort TypeScript regenerate of `ltm/runtime/*` from the ledger.
   * Does not require Python `ltm.py`. Fail-open; never throws past this API.
   * Keeps LTM_RECALL layer useful without a dream-cycle scheduler.
   */
  async function refreshRuntimeSnapshot(): Promise<void> {
    try {
      const runtime = join(ltmDir, "runtime");
      await mkdir(runtime, { recursive: true });
      const decisions = await listDecisions();
      const events = await readJsonlTail(eventsPath, 12);
      const checkpoints = await readJsonlTail(checkpointsPath, 6);

      const nextActions: string[] = [];
      const openThreads: string[] = [];
      for (const chk of checkpoints) {
        if (Array.isArray(chk["next_actions"])) {
          for (const a of chk["next_actions"] as unknown[]) {
            const s = String(a ?? "").trim();
            if (s && !nextActions.includes(s)) nextActions.push(s);
          }
        }
        if (Array.isArray(chk["open_threads"])) {
          for (const t of chk["open_threads"] as unknown[]) {
            const s = String(t ?? "").trim();
            if (s && !openThreads.includes(s)) openThreads.push(s);
          }
        }
      }

      const activeContext = {
        regenerated_at: new Date().toISOString(),
        source: "kyrei:ltm-bridge",
        open_threads: openThreads.slice(0, 10).map((summary, i) => ({ id: `t${i + 1}`, summary })),
        next_actions: nextActions.slice(0, 8),
        active_decisions: decisions.slice(0, 20).map((d) => ({
          id: d.id,
          decision: d.decision,
          tags: d.tags,
        })),
      };

      const recallLines: string[] = ["## Recent LTM snapshot", ""];
      if (decisions.length) {
        recallLines.push("### Active decisions");
        for (const d of decisions.slice(0, 15)) {
          recallLines.push(`- ${d.id}: ${d.decision}${d.rationale ? ` — ${d.rationale}` : ""}`);
        }
        recallLines.push("");
      }
      if (checkpoints.length) {
        recallLines.push("### Recent checkpoints");
        for (const c of checkpoints.slice(-5)) {
          const summary = String(c["summary"] ?? "").trim();
          if (summary) recallLines.push(`- ${summary}`);
        }
        recallLines.push("");
      }
      if (events.length) {
        recallLines.push("### Recent file events");
        for (const e of events.slice(-8)) {
          const summary = String(e["summary"] ?? "").trim();
          const sample = Array.isArray(e["files_sample"])
            ? (e["files_sample"] as unknown[]).map(String).slice(0, 4).join(", ")
            : "";
          if (summary || sample) recallLines.push(`- ${summary || "files"}${sample ? ` (${sample})` : ""}`);
        }
        recallLines.push("");
      }
      if (nextActions.length) {
        recallLines.push("### Next actions");
        for (const a of nextActions.slice(0, 5)) recallLines.push(`- ${a}`);
      }

      // Re-ensure runtime dir immediately before writes (TOCTOU-safe on Windows).
      await mkdir(runtime, { recursive: true });
      await writeFile(
        join(runtime, "active-context.json"),
        JSON.stringify(activeContext, null, 2) + "\n",
        "utf8",
      );
      await writeFile(join(runtime, "last-recall.md"), recallLines.join("\n").trim() + "\n", "utf8");
    } catch {
      // Fail-open: recall stays stale rather than breaking the turn.
    }
  }

  return {
    appendEvent,
    appendCheckpoint,
    recall,
    addDecision,
    invalidateDecision,
    listDecisions,
    refreshRuntimeSnapshot,
  };
}
