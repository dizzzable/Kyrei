/**
 * Durable provider usage ledger (P0 governance foundation).
 *
 * Append-only JSONL outside the workspace jail. No secrets, no prompts —
 * only accounting fields for multi-provider pooling and future access tokens.
 *
 * Future (P2): `accessTokenId` / `principalLabel` on each event for employee
 * chargeback without storing raw API keys.
 */

import { appendFile, chmod, mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_BYTES = 12 * 1024 * 1024;
const MAX_READ_LINES = 50_000;
const MAX_STRING = 200;

/**
 * @typedef {object} UsageLedgerEvent
 * @property {string} id
 * @property {string} ts ISO-8601
 * @property {"chat_turn"|"pipeline_stage"|"delegate"|"team"|"other"} kind
 * @property {string} [sessionId]
 * @property {string} [providerId]
 * @property {string} [accountId]
 * @property {string} [modelId]
 * @property {number} [inputTokens]
 * @property {number} [cachedInputTokens]
 * @property {number} [outputTokens]
 * @property {number} [reasoningTokens]
 * @property {number} [totalTokens]
 * @property {number} [costUsd]
 * @property {string} [status] complete | error | interrupted | …
 * @property {number} [latencyMs]
 * @property {string} [accessTokenId] reserved for P2 employee keys
 * @property {string} [principalLabel] reserved for P2 display name
 */

/**
 * @typedef {object} UsageLedgerSummary
 * @property {number} requestCount
 * @property {number} inputTokens
 * @property {number} cachedInputTokens
 * @property {number} outputTokens
 * @property {number} reasoningTokens
 * @property {number} totalTokens
 * @property {number} costUsd
 * @property {Array<{ key: string, requestCount: number, totalTokens: number, costUsd: number }>} byProvider
 * @property {Array<{ key: string, requestCount: number, totalTokens: number, costUsd: number }>} byModel
 * @property {Array<{ day: string, requestCount: number, totalTokens: number, costUsd: number }>} byDay
 */

function text(value, max = MAX_STRING) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function nonNegInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(n));
}

function nonNegCost(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 1e8) / 1e8;
}

/** Normalize one event; drop unknown / unsafe fields. */
export function normalizeUsageEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const id = text(source.id, 80) ?? `usage_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const ts = text(source.ts, 40) ?? new Date().toISOString();
  const kindRaw = text(source.kind, 32) ?? "other";
  const kind = ["chat_turn", "pipeline_stage", "delegate", "team", "other"].includes(kindRaw)
    ? kindRaw
    : "other";
  const inputTokens = nonNegInt(source.inputTokens);
  const cachedInputTokens = nonNegInt(source.cachedInputTokens);
  const outputTokens = nonNegInt(source.outputTokens);
  const reasoningTokens = nonNegInt(source.reasoningTokens);
  let totalTokens = nonNegInt(source.totalTokens);
  if (totalTokens === undefined && (inputTokens !== undefined || outputTokens !== undefined)) {
    totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
  }
  const event = {
    id,
    ts,
    kind,
    ...(text(source.sessionId, 120) ? { sessionId: text(source.sessionId, 120) } : {}),
    ...(text(source.providerId, 80) ? { providerId: text(source.providerId, 80) } : {}),
    ...(text(source.accountId, 80) ? { accountId: text(source.accountId, 80) } : {}),
    ...(text(source.modelId, 200) ? { modelId: text(source.modelId, 200) } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(nonNegCost(source.costUsd) !== undefined ? { costUsd: nonNegCost(source.costUsd) } : {}),
    ...(text(source.status, 40) ? { status: text(source.status, 40) } : {}),
    ...(nonNegInt(source.latencyMs) !== undefined ? { latencyMs: nonNegInt(source.latencyMs) } : {}),
    ...(text(source.accessTokenId, 80) ? { accessTokenId: text(source.accessTokenId, 80) } : {}),
    ...(text(source.principalLabel, 120) ? { principalLabel: text(source.principalLabel, 120) } : {}),
  };
  // Skip empty noise (no tokens and no cost)
  if (
    event.totalTokens === undefined
    && event.inputTokens === undefined
    && event.outputTokens === undefined
    && event.costUsd === undefined
  ) {
    return null;
  }
  return event;
}

/**
 * Aggregate events into operator-facing summary.
 * @param {UsageLedgerEvent[]} events
 * @param {{ sinceMs?: number }} [opts]
 * @returns {UsageLedgerSummary}
 */
export function summarizeUsageEvents(events, opts = {}) {
  const sinceMs = Number.isFinite(opts.sinceMs) ? opts.sinceMs : 0;
  const byProvider = new Map();
  const byModel = new Map();
  const byDay = new Map();
  let requestCount = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let totalTokens = 0;
  let costUsd = 0;

  const bump = (map, key, tokens, cost) => {
    const row = map.get(key) ?? { key, requestCount: 0, totalTokens: 0, costUsd: 0 };
    row.requestCount += 1;
    row.totalTokens += tokens;
    row.costUsd = Math.round((row.costUsd + cost) * 1e8) / 1e8;
    map.set(key, row);
  };

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const t = Date.parse(event.ts ?? "");
    if (sinceMs > 0 && Number.isFinite(t) && t < sinceMs) continue;
    requestCount += 1;
    const inT = Number(event.inputTokens) || 0;
    const cachedInT = Number(event.cachedInputTokens) || 0;
    const outT = Number(event.outputTokens) || 0;
    const reasoningT = Number(event.reasoningTokens) || 0;
    const tot = Number(event.totalTokens) || inT + outT;
    const cost = Number(event.costUsd) || 0;
    inputTokens += inT;
    cachedInputTokens += cachedInT;
    outputTokens += outT;
    reasoningTokens += reasoningT;
    totalTokens += tot;
    costUsd += cost;
    bump(byProvider, event.providerId || "unknown", tot, cost);
    bump(byModel, event.modelId ? `${event.providerId || "?"} / ${event.modelId}` : "unknown", tot, cost);
    const day = Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "unknown";
    bump(byDay, day, tot, cost);
  }

  const sortRows = (map) => [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens || b.costUsd - a.costUsd);
  return {
    requestCount,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    costUsd: Math.round(costUsd * 1e8) / 1e8,
    byProvider: sortRows(byProvider),
    byModel: sortRows(byModel),
    byDay: [...byDay.values()].sort((a, b) => String(a.key).localeCompare(String(b.key))).map((row) => ({
      day: row.key,
      requestCount: row.requestCount,
      totalTokens: row.totalTokens,
      costUsd: row.costUsd,
    })),
  };
}

/**
 * @param {{ dataDir: string, fileName?: string }} options
 */
export function createUsageLedger(options) {
  const dataDir = options.dataDir;
  const filePath = join(dataDir, options.fileName ?? "usage-ledger.jsonl");
  let writeTail = Promise.resolve();

  async function rotateIfNeeded() {
    try {
      const s = await stat(filePath);
      if (s.size > MAX_BYTES) {
        await rename(filePath, `${filePath}.${Date.now()}.bak`);
      }
    } catch {
      /* first write */
    }
  }

  /**
   * @param {Partial<UsageLedgerEvent>} raw
   * @returns {Promise<UsageLedgerEvent | null>}
   */
  function record(raw) {
    const event = normalizeUsageEvent(raw);
    if (!event) return Promise.resolve(null);
    const line = `${JSON.stringify(event)}\n`;
    const op = writeTail.then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      await rotateIfNeeded();
      await appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
      if (process.platform !== "win32") {
        try { await chmod(filePath, 0o600); } catch { /* best effort */ }
      }
      return event;
    }).catch(() => null);
    writeTail = op.then(() => undefined, () => undefined);
    return op;
  }

  /**
   * @param {{ limit?: number, sinceMs?: number }} [opts]
   * @returns {Promise<UsageLedgerEvent[]>}
   */
  async function readEvents(opts = {}) {
    const limit = Math.min(MAX_READ_LINES, Math.max(1, Number(opts.limit) || 5_000));
    let raw = "";
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return [];
    }
    const lines = raw.split("\n").filter(Boolean);
    const slice = lines.slice(-limit);
    const sinceMs = Number.isFinite(opts.sinceMs) ? opts.sinceMs : 0;
    /** @type {UsageLedgerEvent[]} */
    const events = [];
    for (const line of slice) {
      try {
        const parsed = JSON.parse(line);
        const event = normalizeUsageEvent(parsed);
        if (!event) continue;
        if (sinceMs > 0) {
          const t = Date.parse(event.ts);
          if (Number.isFinite(t) && t < sinceMs) continue;
        }
        events.push(event);
      } catch {
        /* skip corrupt */
      }
    }
    return events;
  }

  /**
   * @param {{ days?: number }} [opts]
   */
  async function summary(opts = {}) {
    const days = Math.min(365, Math.max(1, Number(opts.days) || 30));
    const sinceMs = Date.now() - days * 24 * 60 * 60_000;
    const events = await readEvents({ limit: MAX_READ_LINES, sinceMs });
    return summarizeUsageEvents(events, { sinceMs });
  }

  return {
    path: filePath,
    record,
    readEvents,
    summary,
  };
}
