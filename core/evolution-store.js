import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { redactSensitiveValue } from "./secret-redaction.js";

export const EVOLUTION_STORE_VERSION = 1;
export const EVOLUTION_TARGET_KINDS = Object.freeze([
  "skill",
  "prompt-profile",
  "memory-ranking",
  "reliability-hint",
]);
export const EVOLUTION_STATUSES = Object.freeze([
  "pending",
  "evaluating",
  "approved",
  "rejected",
  "canary",
  "promoted",
  "rolled-back",
  "failed",
]);

const MAX_ROWS = 10_000;
const MAX_STRING_CHARS = 12_000;
const MAX_ARRAY_ITEMS = 128;
const MAX_OBJECT_KEYS = 128;
const TERMINAL = new Set(["rejected", "promoted", "rolled-back", "failed"]);
const TRANSITIONS = Object.freeze({
  pending: new Set(["evaluating", "rejected", "failed"]),
  evaluating: new Set(["approved", "rejected", "failed"]),
  approved: new Set(["canary", "promoted", "rejected", "failed"]),
  canary: new Set(["promoted", "rolled-back", "failed"]),
  promoted: new Set(["rolled-back"]),
  rejected: new Set(),
  "rolled-back": new Set(),
  failed: new Set(),
});

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value, max = 500) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\0/g, "").trim();
  return normalized.slice(0, max);
}

function candidateId(value) {
  const id = cleanText(value, 120);
  if (!/^evo_[a-z0-9_-]{8,110}$/i.test(id)) throw new Error("evolution_candidate_id_invalid");
  return id;
}

function targetKind(value) {
  if (!EVOLUTION_TARGET_KINDS.includes(value)) throw new Error("evolution_target_not_allowlisted");
  return value;
}

function status(value) {
  if (!EVOLUTION_STATUSES.includes(value)) throw new Error("evolution_status_invalid");
  return value;
}

function risk(value) {
  return value === "medium" || value === "high" ? value : "low";
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function makeId(now) {
  return `evo_${now.toString(36)}_${randomBytes(6).toString("hex")}`;
}

function normalizeEvidence(value) {
  const source = object(value);
  return {
    tests: Array.isArray(source.tests) ? source.tests.map((item) => cleanText(item, 500)).filter(Boolean).slice(0, 50) : [],
    receipts: Array.isArray(source.receipts) ? source.receipts.map((item) => cleanText(item, 200)).filter(Boolean).slice(0, 50) : [],
    metrics: object(source.metrics),
    notes: cleanText(source.notes, 4_000),
  };
}

function projectionFromRows(rows) {
  const candidates = new Map();
  for (const row of rows) {
    if (row?.version !== EVOLUTION_STORE_VERSION || typeof row?.candidateId !== "string") continue;
    if (row.type === "candidate.created" && row.candidate) {
      candidates.set(row.candidateId, { ...row.candidate });
      continue;
    }
    const current = candidates.get(row.candidateId);
    if (!current || row.type !== "candidate.transition") continue;
    if (row.revision !== current.revision + 1 || row.previousStatus !== current.status) continue;
    candidates.set(row.candidateId, {
      ...current,
      status: row.status,
      revision: row.revision,
      updatedAt: row.createdAt,
      evidence: row.evidence,
      ...(row.reason ? { reason: row.reason } : {}),
    });
  }
  return candidates;
}

/**
 * Durable, proposal-first evolution journal. It stores redacted candidate metadata and
 * verifier receipts; it never applies a workspace/config mutation itself.
 */
export class EvolutionStore {
  constructor({ dataDir, getSensitiveValues = () => [], now = () => Date.now(), maxRows = MAX_ROWS }) {
    if (typeof dataDir !== "string" || !dataDir.trim()) throw new Error("evolution_store_dir_required");
    if (typeof getSensitiveValues !== "function") throw new Error("evolution_store_sensitive_values_invalid");
    if (typeof now !== "function") throw new Error("evolution_store_clock_invalid");
    this.dir = join(dataDir, "evolution");
    this.path = join(this.dir, "events.jsonl");
    this.getSensitiveValues = getSensitiveValues;
    this.now = now;
    this.maxRows = Math.max(100, Math.min(MAX_ROWS, Math.floor(maxRows) || MAX_ROWS));
    this.tail = Promise.resolve();
  }

  async readRows() {
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
        // A crash-truncated tail must not hide earlier valid events.
      }
    }
    return rows.slice(-this.maxRows);
  }

  async append(row) {
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

  async list({ status: statusFilter, limit = 100 } = {}) {
    const candidates = [...projectionFromRows(await this.readRows()).values()]
      .filter((candidate) => !statusFilter || candidate.status === statusFilter)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return candidates.slice(0, Math.max(1, Math.min(500, Math.floor(limit) || 100)));
  }

  async get(id) {
    return projectionFromRows(await this.readRows()).get(candidateId(id)) ?? null;
  }

  async create(input) {
    const source = object(input);
    const createdAt = new Date(this.now()).toISOString();
    const id = source.id ? candidateId(source.id) : makeId(this.now());
    if (await this.get(id)) throw new Error("evolution_candidate_exists");
    const proposal = object(source.proposal);
    const candidate = {
      id,
      version: EVOLUTION_STORE_VERSION,
      target: {
        kind: targetKind(object(source.target).kind),
        id: cleanText(object(source.target).id, 300),
      },
      title: cleanText(source.title, 300),
      summary: cleanText(source.summary, 4_000),
      risk: risk(source.risk),
      status: "pending",
      revision: 1,
      proposal,
      proposalDigest: digest(proposal),
      provenance: object(source.provenance),
      createdAt,
      updatedAt: createdAt,
      evidence: normalizeEvidence(source.evidence),
    };
    if (!candidate.target.id || !candidate.title || !candidate.summary) {
      throw new Error("evolution_candidate_invalid");
    }
    const row = await this.append({
      version: EVOLUTION_STORE_VERSION,
      type: "candidate.created",
      candidateId: id,
      createdAt,
      candidate,
    });
    return row.candidate;
  }

  async transition(id, input = {}) {
    const normalizedId = candidateId(id);
    const current = await this.get(normalizedId);
    if (!current) throw new Error("evolution_candidate_not_found");
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== current.revision) {
      throw new Error("evolution_candidate_revision_conflict");
    }
    const nextStatus = status(input.status);
    if (!TRANSITIONS[current.status]?.has(nextStatus)) throw new Error("evolution_transition_invalid");
    if ((nextStatus === "approved" || nextStatus === "canary" || nextStatus === "promoted")
      && !Array.isArray(input.evidence?.receipts)) {
      throw new Error("evolution_verifier_receipt_required");
    }
    const evidence = normalizeEvidence(input.evidence);
    if ((nextStatus === "approved" || nextStatus === "canary" || nextStatus === "promoted") && !evidence.receipts.length) {
      throw new Error("evolution_verifier_receipt_required");
    }
    const createdAt = new Date(this.now()).toISOString();
    const row = await this.append({
      version: EVOLUTION_STORE_VERSION,
      type: "candidate.transition",
      candidateId: normalizedId,
      previousStatus: current.status,
      status: nextStatus,
      revision: current.revision + 1,
      createdAt,
      evidence,
      reason: cleanText(input.reason, 2_000),
      terminal: TERMINAL.has(nextStatus),
    });
    return {
      ...current,
      status: row.status,
      revision: row.revision,
      updatedAt: row.createdAt,
      evidence: row.evidence,
      ...(row.reason ? { reason: row.reason } : {}),
    };
  }

  async flush() {
    await this.tail;
  }
}
