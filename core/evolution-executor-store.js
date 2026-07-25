/**
 * Evolution executor receipt-store (step C) — durable prior-state journal.
 *
 * When a candidate is promoted, the executor MUTATES a real artifact (a skill's
 * SKILL.md or a prompt-profile's systemPrompt). To make `promoted → rolled-back`
 * a real restore (not a state label), the prior artifact bytes must be captured
 * durably BEFORE the mutation. This append-only JSONL journal does that with a
 * two-phase protocol per apply:
 *
 *   1. `begin({candidateId, kind, targetRef, priorState})`  → awaited before mutation
 *   2. …executor mutates the artifact…
 *   3. `commit(candidateId)`                                → after mutation succeeds
 *
 * A crash between (1) and (3) leaves an "apply.begin" row with no matching
 * "apply.commit" — `pendingApplies()` surfaces those so a recovery pass can roll
 * back to the captured prior state. `getPrior(candidateId)` returns the latest
 * captured prior state for an explicit rollback.
 *
 * Separate file/instance from EvolutionStore's events.jsonl — no shared lock.
 */

import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { redactSensitiveValue } from "./secret-redaction.js";

export const EVOLUTION_EXECUTOR_STORE_VERSION = 1;
// A prompt-profile systemPrompt is capped at 20 000 chars upstream; keep prior
// state at full fidelity (evolution-store's 12 000 cap would truncate it).
const MAX_STRING_CHARS = 24_000;
const MAX_ARRAY_ITEMS = 128;
const MAX_OBJECT_KEYS = 128;
const EXEC_KINDS = Object.freeze(["skill_update", "skill_create", "profile_update", "profile_create"]);

function cleanText(value, max = 300) {
  if (typeof value !== "string") return "";
  return value.replace(/\0/g, "").trim().slice(0, max);
}

export class EvolutionExecutorStore {
  constructor({ dataDir, getSensitiveValues = () => [], now = () => Date.now() } = {}) {
    if (typeof dataDir !== "string" || !dataDir.trim()) throw new Error("evolution_executor_store_dir_required");
    this.dir = join(dataDir, "evolution");
    this.path = join(this.dir, "executor.jsonl");
    this.getSensitiveValues = typeof getSensitiveValues === "function" ? getSensitiveValues : () => [];
    this.now = typeof now === "function" ? now : () => Date.now();
    this.tail = Promise.resolve();
  }

  async #append(row) {
    const previous = this.tail;
    const next = previous.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const safe = redactSensitiveValue(row, this.getSensitiveValues(), {
        maxDepth: 8,
        maxStringChars: MAX_STRING_CHARS,
        maxArrayItems: MAX_ARRAY_ITEMS,
        maxObjectKeys: MAX_OBJECT_KEYS,
      });
      await appendFile(this.path, `\n${JSON.stringify(safe)}\n`, "utf8");
      return safe;
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  async #readRows() {
    await this.tail;
    let raw;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const rows = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row === "object") rows.push(row);
      } catch {
        // A crash-truncated tail must not hide earlier valid rows.
      }
    }
    return rows;
  }

  /**
   * Phase 1: durably capture prior state. MUST be awaited before mutating.
   * Returns a receipt id string (pointer stored in the candidate's evidence).
   */
  async begin({ candidateId, kind, targetRef, priorState }) {
    const id = cleanText(candidateId, 120);
    if (!id) throw new Error("evolution_executor_candidate_required");
    if (!EXEC_KINDS.includes(kind)) throw new Error("evolution_executor_kind_invalid");
    const receiptId = `exec:${id}:${this.now().toString(36)}:${randomBytes(3).toString("hex")}`;
    await this.#append({
      version: EVOLUTION_EXECUTOR_STORE_VERSION,
      type: "apply.begin",
      receiptId,
      candidateId: id,
      kind,
      targetRef: cleanText(targetRef, 300),
      // `existed:false` marks a create (rollback = delete the new artifact).
      priorState: {
        existed: priorState?.existed === true,
        ...(typeof priorState?.content === "string" ? { content: priorState.content } : {}),
      },
      at: new Date(this.now()).toISOString(),
    });
    return receiptId;
  }

  /** Phase 2: mark the apply committed. Called after the mutation succeeds. */
  async commit(candidateId) {
    const id = cleanText(candidateId, 120);
    if (!id) throw new Error("evolution_executor_candidate_required");
    await this.#append({
      version: EVOLUTION_EXECUTOR_STORE_VERSION,
      type: "apply.commit",
      candidateId: id,
      at: new Date(this.now()).toISOString(),
    });
  }

  /** Latest captured prior state for a candidate (for explicit rollback). */
  async getPrior(candidateId) {
    const id = cleanText(candidateId, 120);
    const rows = await this.#readRows();
    let prior = null;
    for (const row of rows) {
      if (row?.type === "apply.begin" && row.candidateId === id) {
        prior = { kind: row.kind, targetRef: row.targetRef, priorState: row.priorState, receiptId: row.receiptId };
      }
    }
    return prior;
  }

  /**
   * Candidates whose apply began but never committed — a crash left the artifact
   * in an unknown state. A recovery pass can roll each back to its prior state.
   */
  async pendingApplies() {
    const rows = await this.#readRows();
    /** @type {Map<string, object>} */
    const begins = new Map();
    for (const row of rows) {
      if (row?.type === "apply.begin" && typeof row.candidateId === "string") {
        begins.set(row.candidateId, { candidateId: row.candidateId, kind: row.kind, targetRef: row.targetRef, priorState: row.priorState });
      } else if (row?.type === "apply.commit" && typeof row.candidateId === "string") {
        begins.delete(row.candidateId);
      }
    }
    return [...begins.values()];
  }
}
