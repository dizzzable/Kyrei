import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { redactSensitiveValue } from "./secret-redaction.js";

const DEFAULT_MAX_EVENTS = 512;
const MAX_STRING_CHARS = 8_000;
const MAX_ARRAY_ITEMS = 200;
const MAX_OBJECT_KEYS = 200;

function safeAgentId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 300 || value.includes("\0")) {
    throw new Error("agent_run_id_invalid");
  }
  return value.trim();
}

function terminalState(state) {
  return state === "completed" || state === "partial" || state === "failed" || state === "interrupted";
}

export class AgentRunStore {
  constructor({ dataDir, maxEventsPerRun = DEFAULT_MAX_EVENTS, getSensitiveValues = () => [] }) {
    if (typeof dataDir !== "string" || !dataDir) throw new Error("agent_run_store_dir_required");
    if (typeof getSensitiveValues !== "function") throw new Error("agent_run_store_sensitive_values_invalid");
    this.dir = join(dataDir, "agent-runs");
    this.maxEventsPerRun = Math.max(1, Math.min(20_000, Math.floor(maxEventsPerRun) || DEFAULT_MAX_EVENTS));
    this.getSensitiveValues = getSensitiveValues;
    this.tails = new Map();
  }

  pathFor(agentId) {
    const id = safeAgentId(agentId);
    return join(this.dir, `${createHash("sha256").update(id).digest("hex")}.jsonl`);
  }

  async append(checkpoint) {
    const id = safeAgentId(checkpoint?.agentId);
    const previous = this.tails.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const row = redactSensitiveValue({
        ...checkpoint,
        agentId: id,
        state: typeof checkpoint?.state === "string" ? checkpoint.state.slice(0, 80) : "unknown",
        createdAt: new Date().toISOString(),
      }, this.getSensitiveValues(), {
        maxDepth: 8,
        maxStringChars: MAX_STRING_CHARS,
        maxArrayItems: MAX_ARRAY_ITEMS,
        maxObjectKeys: MAX_OBJECT_KEYS,
      });
      await appendFile(this.pathFor(id), `\n${JSON.stringify(row)}\n`, "utf8");
      return row;
    });
    this.tails.set(id, next.catch(() => undefined));
    return next;
  }

  async read(agentId) {
    const id = safeAgentId(agentId);
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
        if (row?.agentId === id && typeof row.state === "string") rows.push(row);
      } catch {
        // tolerate one crash-truncated line; prior checkpoints remain valid
      }
    }
    return rows.slice(-this.maxEventsPerRun);
  }

  async latest(agentId) {
    const rows = await this.read(agentId);
    return rows.at(-1) ?? null;
  }

  async recoverRecoverable() {
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
      if (!last?.agentId || typeof last.state !== "string" || terminalState(last.state) || last.readOnly === false) continue;
      const recovering = {
        ...last,
        state: "recovering",
        terminalReason: last.terminalReason || "gateway_restart",
        recoveredAt: new Date().toISOString(),
      };
      await this.append(recovering);
      recovered.push(recovering);
    }
    return recovered.sort((left, right) => left.agentId.localeCompare(right.agentId));
  }

  async flush() {
    await Promise.all([...this.tails.values()]);
  }
}
