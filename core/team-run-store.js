import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { redactSensitiveValue } from "./secret-redaction.js";

const DEFAULT_MAX_EVENTS = 2_000;
const MAX_STRING_CHARS = 8_000;
const MAX_ARRAY_ITEMS = 200;
const MAX_OBJECT_KEYS = 200;
function safeRunId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 300 || value.includes("\0")) {
    throw new Error("team_run_id_invalid");
  }
  return value.trim();
}

function terminalType(type) {
  return type === "team.complete" || type === "team.failed" || type === "team.interrupted" || type === "team.cancelled" || type === "team.partial";
}

function checkpointManifest(runId, payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const list = (value) => Array.isArray(value)
    ? value
      .slice(0, 256)
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim().slice(0, 120))
    : [];
  const state = typeof source.state === "string" && source.state.trim()
    ? source.state.trim().slice(0, 40)
    : "recovering";
  return {
    version: 1,
    runId,
    state,
    recoverable: source.recoverable !== false,
    ...(typeof source.reason === "string" && source.reason.trim() ? { reason: source.reason.trim().slice(0, 200) } : {}),
    startedTaskIds: list(source.startedTaskIds),
    completedTaskIds: list(source.completedTaskIds),
    failedTaskIds: list(source.failedTaskIds),
  };
}

export class TeamRunStore {
  constructor({ dataDir, maxEventsPerRun = DEFAULT_MAX_EVENTS, getSensitiveValues = () => [] }) {
    if (typeof dataDir !== "string" || !dataDir) throw new Error("team_run_store_dir_required");
    if (typeof getSensitiveValues !== "function") throw new Error("team_run_store_sensitive_values_invalid");
    this.dir = join(dataDir, "team-runs");
    this.maxEventsPerRun = Math.max(1, Math.min(20_000, Math.floor(maxEventsPerRun) || DEFAULT_MAX_EVENTS));
    this.getSensitiveValues = getSensitiveValues;
    this.tails = new Map();
  }

  pathFor(runId) {
    const id = safeRunId(runId);
    return join(this.dir, `${createHash("sha256").update(id).digest("hex")}.jsonl`);
  }

  async append(runId, event) {
    const id = safeRunId(runId);
    const previous = this.tails.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const row = redactSensitiveValue({
        runId: id,
        type: typeof event?.type === "string" ? event.type.slice(0, 120) : "unknown",
        payload: event?.payload && typeof event.payload === "object" ? event.payload : {},
        createdAt: new Date().toISOString(),
      }, this.getSensitiveValues(), {
        maxDepth: 8,
        maxStringChars: MAX_STRING_CHARS,
        maxArrayItems: MAX_ARRAY_ITEMS,
        maxObjectKeys: MAX_OBJECT_KEYS,
      });
      // Leading newline also isolates a valid row from a crash-truncated tail.
      await appendFile(this.pathFor(id), `\n${JSON.stringify(row)}\n`, "utf8");
      return row;
    });
    this.tails.set(id, next.catch(() => undefined));
    return next;
  }

  async read(runId) {
    const id = safeRunId(runId);
    await (this.tails.get(id) ?? Promise.resolve());
    let raw;
    try {
      raw = await readFile(this.pathFor(id), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const rows = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row?.runId === id && typeof row.type === "string") rows.push(row);
      } catch {
        // A crash may leave one incomplete trailing line; prior events remain valid.
      }
    }
    return rows.slice(-this.maxEventsPerRun);
  }

  async latest(runId) {
    const rows = await this.read(runId);
    return rows.at(-1) ?? null;
  }

  async appendCheckpoint(runId, manifest) {
    const id = safeRunId(runId);
    const normalized = checkpointManifest(id, manifest);
    return this.append(id, { type: "team.checkpoint", payload: { checkpoint_manifest: normalized } });
  }

  async recoverInterrupted() {
    await mkdir(this.dir, { recursive: true });
    const recovered = [];
    for (const name of await readdir(this.dir)) {
      if (!/^[a-f0-9]{64}\.jsonl$/.test(name)) continue;
      let rows = [];
      try {
        const raw = await readFile(join(this.dir, name), "utf8");
        rows = raw.split("\n").filter(Boolean).flatMap((line) => {
          try { return [JSON.parse(line)]; } catch { return []; }
        });
      } catch {
        continue;
      }
      const last = rows.at(-1);
      const started = rows.some((row) => row?.type === "team.start");
      if (!started || !last?.runId || terminalType(last.type)) continue;
      const startedTaskIds = rows
        .filter((row) => row?.type === "subagent.start" && typeof row?.payload?.task_id === "string")
        .map((row) => row.payload.task_id);
      const completedTaskIds = rows
        .filter((row) => row?.type === "subagent.complete" && typeof row?.payload?.task_id === "string")
        .map((row) => row.payload.task_id);
      const failedTaskIds = rows
        .filter((row) => row?.type === "subagent.failed" && typeof row?.payload?.task_id === "string")
        .map((row) => row.payload.task_id);
      const manifest = checkpointManifest(last.runId, {
        state: "recovering",
        recoverable: true,
        reason: "gateway_restart",
        startedTaskIds,
        completedTaskIds,
        failedTaskIds,
      });
      await this.appendCheckpoint(last.runId, manifest);
      await this.append(last.runId, {
        type: "team.interrupted",
        payload: {
          reason: "gateway_restart",
          next_status: "recovering",
          checkpoint_manifest: manifest,
        },
      });
      recovered.push(last.runId);
    }
    return recovered.sort();
  }

  async flush() {
    await Promise.all([...this.tails.values()]);
  }
}
