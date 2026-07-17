/**
 * LTM bridge (Requirements §6.5). Uses the existing `ltm/store/*.jsonl` as the
 * SINGLE ledger — no duplicate journal. Appends events/checkpoints in the
 * documented format with id generation, secret redaction, and a file lock.
 *
 * Wave H: pin + confidence/decay ranking, atomic SUPERSEDE with history link
 * (MemoHood-inspired; proposal-first still applies at MEMORY.md layer).
 */

import { mkdir, readFile, appendFile, writeFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withFileLock } from "./lock.js";
import { redact } from "../security/secrets.js";
import {
  effectiveConfidence,
  normalizeDecayConfig,
  type CaptureKind,
  type DecayConfig,
  DEFAULT_DECAY_CONFIG,
} from "./capture-signals.js";
import { jaccardSimilarity } from "./recall-pipeline.js";

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
 *
 * Wave H fields (`pinned`, `confidence`, `kind`, `supersedes`, `lastAccessedAt`)
 * are optional on disk for backward compatibility with older ledger lines.
 */
export interface LtmDecisionRecord {
  id: string;
  decision: string;
  rationale: string;
  validFrom: string;
  validTo: string | null;
  tags: string[];
  sessionId: string;
  /** Never decay in runtime ranking (allergy, hard prefs, explicit pin). */
  pinned: boolean;
  /** Base confidence before decay [0,1]. Default 1. */
  confidence: number;
  /** Taxonomy for decay half-life. */
  kind: CaptureKind;
  /** Id of the decision this one replaced (SUPERSEDE history). */
  supersedes: string | null;
  /** Last time this fact was recalled or written (ISO). */
  lastAccessedAt: string;
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

/** Prefer max(numeric suffix)+1 so sparse / mixed ledgers never collide. */
function nextDecisionId(records: ReadonlyArray<{ id?: unknown } | Record<string, unknown>>): string {
  let max = 0;
  for (const rec of records) {
    const id = String((rec as { id?: unknown })["id"] ?? "");
    const m = /^dec_(\d+)$/i.exec(id);
    if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
  }
  return nextId("dec", max);
}

/** Atomic JSONL rewrite (same-dir temp + rename; Windows-safe fallback). */
async function atomicWriteJsonl(path: string, records: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const body = records.length ? `${records.map((r) => JSON.stringify(r)).join("\n")}\n` : "";
  // Stable tmp name (overwrite) so tests don't accumulate ENOTEMPTY leftovers.
  const tmp = join(dir, `.${basename(path)}.tmp`);
  await writeFile(tmp, body, "utf8");
  try {
    await rename(tmp, path);
  } catch {
    await writeFile(path, body, "utf8");
    try {
      await unlink(tmp);
    } catch {
      /* best effort */
    }
  }
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
    const tags = Array.isArray(rec["tags"]) ? rec["tags"].map(String) : [];
    const pinnedFlag =
      rec["pinned"] === true ||
      tags.some((t) => /^pinned?$/i.test(t)) ||
      tags.includes("pin");
    const confRaw = Number(rec["confidence"]);
    const kindRaw = String(rec["kind"] ?? "decision");
    const kind = (
      [
        "persona",
        "event",
        "preference",
        "decision",
        "correction",
        "fact",
        "instruction",
        "summary",
      ] as CaptureKind[]
    ).includes(kindRaw as CaptureKind)
      ? (kindRaw as CaptureKind)
      : "decision";
    const last =
      typeof rec["last_accessed_at"] === "string" && rec["last_accessed_at"]
        ? String(rec["last_accessed_at"])
        : String(rec["valid_from"] ?? new Date().toISOString());
    return {
      id: String(rec["id"] ?? ""),
      decision: String(rec["decision"] ?? ""),
      rationale: String(rec["rationale"] ?? ""),
      validFrom: String(rec["valid_from"] ?? ""),
      validTo: rec["valid_to"] == null ? null : String(rec["valid_to"]),
      tags,
      sessionId: String(rec["session_id"] ?? ""),
      pinned: pinnedFlag,
      confidence: Number.isFinite(confRaw) ? Math.min(1, Math.max(0, confRaw)) : 1,
      kind,
      supersedes:
        rec["supersedes"] == null || rec["supersedes"] === ""
          ? null
          : String(rec["supersedes"]),
      lastAccessedAt: last,
    };
  }

  async function readDecisions(): Promise<Record<string, unknown>[]> {
    try {
      const raw = await readFile(decisionsPath, "utf8");
      const out: Record<string, unknown>[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // skip_bad — one corrupt line must not wipe the ledger view
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  function writeDecisionRow(input: {
    id: string;
    decision: string;
    rationale: string;
    tags: string[];
    sessionId: string;
    pinned?: boolean;
    confidence?: number;
    kind?: CaptureKind;
    supersedes?: string | null;
    validFrom?: string;
    validTo?: string | null;
    lastAccessedAt?: string;
  }): Record<string, unknown> {
    const now = new Date().toISOString();
    const tags = [...input.tags];
    if (input.pinned && !tags.some((t) => /^pinned?$/i.test(t))) tags.push("pinned");
    return {
      id: input.id,
      decision: redact(input.decision),
      rationale: redact(input.rationale),
      valid_from: input.validFrom ?? now,
      valid_to: input.validTo ?? null,
      tags,
      session_id: input.sessionId,
      pinned: input.pinned === true,
      confidence: input.confidence ?? 1,
      kind: input.kind ?? "decision",
      supersedes: input.supersedes ?? null,
      last_accessed_at: input.lastAccessedAt ?? now,
    };
  }

  /**
   * Record a new architectural decision. Never overwrites or deletes a prior
   * decision — call `invalidateDecision` / `supersedeDecision` to mark an
   * existing one superseded.
   */
  async function addDecision(input: {
    decision: string;
    rationale?: string;
    tags?: string[];
    sessionId: string;
    pinned?: boolean;
    kind?: CaptureKind;
    confidence?: number;
    supersedes?: string | null;
  }): Promise<string> {
    await mkdir(storeDir, { recursive: true });
    return withFileLock(decisionsPath, async () => {
      const existing = await readDecisions();
      const id = nextDecisionId(existing);
      const rec = writeDecisionRow({
        id,
        decision: input.decision,
        rationale: input.rationale ?? "",
        tags: input.tags ?? [],
        sessionId: input.sessionId,
        pinned: input.pinned,
        kind: input.kind,
        confidence: input.confidence,
        supersedes: input.supersedes ?? null,
      });
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
      await atomicWriteJsonl(decisionsPath, records);
      return true;
    });
  }

  /**
   * In-place pin flip without SUPERSEDE (stable id for Settings UI).
   * Returns false when id missing or already superseded.
   */
  async function setPinned(id: string, pinned: boolean): Promise<boolean> {
    return withFileLock(decisionsPath, async () => {
      const records = await readDecisions();
      const target = records.find((r) => r["id"] === id && r["valid_to"] == null);
      if (!target) return false;
      const tags = Array.isArray(target["tags"])
        ? (target["tags"] as unknown[]).map(String).filter((t) => !/^pinned?$/i.test(t))
        : [];
      if (pinned) tags.push("pinned");
      target["pinned"] = pinned === true;
      target["tags"] = tags;
      target["last_accessed_at"] = new Date().toISOString();
      await atomicWriteJsonl(decisionsPath, records);
      return true;
    });
  }

  /**
   * Atomic SUPERSEDE: invalidate `supersedesId` (if active) and append a new
   * decision linked via `supersedes`. Old row stays in the ledger for history
   * (`memohood_fetch`-style: list with includeInvalidated / fetchDecision).
   */
  async function supersedeDecision(input: {
    supersedesId: string;
    decision: string;
    rationale?: string;
    tags?: string[];
    sessionId: string;
    pinned?: boolean;
    kind?: CaptureKind;
  }): Promise<{ newId: string; superseded: boolean }> {
    await mkdir(storeDir, { recursive: true });
    return withFileLock(decisionsPath, async () => {
      const records = await readDecisions();
      let superseded = false;
      const target = records.find((r) => r["id"] === input.supersedesId && r["valid_to"] == null);
      if (target) {
        target["valid_to"] = new Date().toISOString();
        superseded = true;
      }
      const id = nextDecisionId(records);
      const rec = writeDecisionRow({
        id,
        decision: input.decision,
        rationale: input.rationale ?? "",
        tags: input.tags ?? [],
        sessionId: input.sessionId,
        pinned: input.pinned,
        kind: input.kind ?? "decision",
        supersedes: input.supersedesId,
      });
      records.push(rec);
      await atomicWriteJsonl(decisionsPath, records);
      return { newId: id, superseded };
    });
  }

  /**
   * Find the best active decision that is near-duplicate of `text` (Jaccard).
   * Used by curator apply-safe to SUPERSEDE rather than duplicate.
   */
  async function findSimilarActiveDecision(
    text: string,
    threshold = 0.72,
  ): Promise<LtmDecisionRecord | null> {
    const active = await listDecisions({ includeInvalidated: false });
    let best: LtmDecisionRecord | null = null;
    let bestSim = threshold;
    for (const d of active) {
      const sim = jaccardSimilarity(text, `${d.decision} ${d.rationale}`);
      if (sim >= bestSim) {
        bestSim = sim;
        best = d;
      }
    }
    return best;
  }

  /** One decision + optional supersede chain (oldest → newest). */
  async function fetchDecision(
    id: string,
  ): Promise<{ decision: LtmDecisionRecord | null; history: LtmDecisionRecord[] }> {
    const all = (await readDecisions()).map(toDecisionRecord);
    const decision = all.find((d) => d.id === id) ?? null;
    if (!decision) return { decision: null, history: [] };
    const history: LtmDecisionRecord[] = [];
    let cursor: string | null = decision.supersedes;
    const seen = new Set<string>([decision.id]);
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const prev = all.find((d) => d.id === cursor);
      if (!prev) break;
      history.unshift(prev);
      cursor = prev.supersedes;
    }
    return { decision, history };
  }

  /** List decisions. By default only currently-active (`validTo === null`) ones. */
  async function listDecisions(
    opts: {
      includeInvalidated?: boolean;
      /** Sort by pin then effective confidence (Wave H). */
      rankByConfidence?: boolean;
      decay?: DecayConfig;
      now?: Date;
    } = {},
  ): Promise<LtmDecisionRecord[]> {
    let records = (await readDecisions()).map(toDecisionRecord);
    if (!opts.includeInvalidated) records = records.filter((r) => r.validTo === null);
    if (opts.rankByConfidence) {
      const decay = opts.decay ?? DEFAULT_DECAY_CONFIG;
      const now = opts.now ?? new Date();
      records = [...records].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        const ca = effectiveConfidence({
          baseConfidence: a.confidence,
          kind: a.kind,
          pinned: a.pinned,
          lastAccessedAt: a.lastAccessedAt,
          now,
          config: decay,
        });
        const cb = effectiveConfidence({
          baseConfidence: b.confidence,
          kind: b.kind,
          pinned: b.pinned,
          lastAccessedAt: b.lastAccessedAt,
          now,
          config: decay,
        });
        return cb - ca || b.validFrom.localeCompare(a.validFrom);
      });
    }
    return records;
  }

  /** Touch last_accessed_at for ranking boost after successful recall. */
  async function touchDecision(id: string): Promise<boolean> {
    const n = await touchDecisions([id]);
    return n > 0;
  }

  /** Batch touch — single lock + atomic rewrite (used by memory_search). */
  async function touchDecisions(ids: readonly string[]): Promise<number> {
    const want = new Set(ids.filter(Boolean));
    if (!want.size) return 0;
    return withFileLock(decisionsPath, async () => {
      const records = await readDecisions();
      const now = new Date().toISOString();
      let n = 0;
      for (const r of records) {
        if (want.has(String(r["id"] ?? ""))) {
          r["last_accessed_at"] = now;
          n++;
        }
      }
      if (n > 0) await atomicWriteJsonl(decisionsPath, records);
      return n;
    });
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
   *
   * Wave H: rank active decisions by pin + Ebbinghaus confidence; drop those
   * below decay floor from the *recall snapshot* (ledger rows stay intact).
   */
  async function refreshRuntimeSnapshot(opts: { decay?: DecayConfig } = {}): Promise<void> {
    try {
      const runtime = join(ltmDir, "runtime");
      await mkdir(runtime, { recursive: true });
      const decay = normalizeDecayConfig(opts.decay ?? DEFAULT_DECAY_CONFIG);
      const now = new Date();
      const ranked = await listDecisions({ rankByConfidence: true, decay, now });
      const decisions = ranked.filter((d) => {
        if (d.pinned) return true;
        const conf = effectiveConfidence({
          baseConfidence: d.confidence,
          kind: d.kind,
          pinned: d.pinned,
          lastAccessedAt: d.lastAccessedAt,
          now,
          config: decay,
        });
        return conf > decay.floor;
      });
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
          pinned: d.pinned,
          kind: d.kind,
          supersedes: d.supersedes,
        })),
      };

      const recallLines: string[] = ["## Recent LTM snapshot", ""];
      if (decisions.length) {
        recallLines.push("### Active decisions");
        for (const d of decisions.slice(0, 15)) {
          const pin = d.pinned ? " 📌" : "";
          const sup = d.supersedes ? ` (supersedes ${d.supersedes})` : "";
          recallLines.push(
            `- ${d.id}${pin}${sup}: ${d.decision}${d.rationale ? ` — ${d.rationale}` : ""}`,
          );
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
    setPinned,
    supersedeDecision,
    findSimilarActiveDecision,
    fetchDecision,
    listDecisions,
    touchDecision,
    touchDecisions,
    refreshRuntimeSnapshot,
  };
}
