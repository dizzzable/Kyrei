import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const SCHEMA_VERSION = 1;
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_NAME_LENGTH = 160;
const MAX_PROMPT_LENGTH = 100_000;
const MAX_RUN_TEXT_LENGTH = 4_000;
const NEXT_RUN_SEARCH_YEARS = 8;

const CRON_FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 7, normalize: value => value === 7 ? 0 : value },
];

/**
 * Parse a numeric, standard five-field cron expression.
 *
 * Supported field forms are `*`, values, lists, ranges and steps on a
 * wildcard or range. Names, aliases, seconds and wrapping ranges are rejected
 * deliberately so stored schedules have one portable interpretation.
 */
export function parseCronExpression(expression) {
  if (typeof expression !== "string") throw cronError("cron-expression-required");
  const source = expression.trim();
  const rawFields = source ? source.split(/\s+/) : [];
  if (rawFields.length !== CRON_FIELDS.length) throw cronError("cron-five-fields-required");

  const fields = {};
  const wildcard = {};
  for (let index = 0; index < CRON_FIELDS.length; index += 1) {
    const definition = CRON_FIELDS[index];
    const parsed = parseField(rawFields[index], definition);
    fields[definition.name] = parsed.values;
    wildcard[definition.name] = parsed.wildcard;
  }

  const parsed = {
    expression: rawFields.join(" "),
    fields,
    wildcard,
    minute: fields.minute,
    hour: fields.hour,
    dayOfMonth: fields.dayOfMonth,
    month: fields.month,
    dayOfWeek: fields.dayOfWeek,
  };
  assertCalendarCanMatch(parsed);
  return parsed;
}

/** Match a Date using the traditional cron day-of-month/day-of-week rule. */
export function matchesCron(expression, date) {
  const parsed = asParsedExpression(expression);
  const candidate = toDate(date, "cron-date-invalid");
  const { fields, wildcard } = parsed;
  if (!fields.minute.includes(candidate.getMinutes())) return false;
  if (!fields.hour.includes(candidate.getHours())) return false;
  if (!fields.month.includes(candidate.getMonth() + 1)) return false;

  const dayOfMonthMatches = fields.dayOfMonth.includes(candidate.getDate());
  const dayOfWeekMatches = fields.dayOfWeek.includes(candidate.getDay());
  if (wildcard.dayOfMonth && wildcard.dayOfWeek) return true;
  if (wildcard.dayOfMonth) return dayOfWeekMatches;
  if (wildcard.dayOfWeek) return dayOfMonthMatches;
  return dayOfMonthMatches || dayOfWeekMatches;
}

/** Return the first matching minute strictly after `from`. */
export function nextCronRun(expression, from = new Date()) {
  const parsed = asParsedExpression(expression);
  const start = toDate(from, "cron-start-invalid");
  const candidate = new Date(start.getTime());
  candidate.setSeconds(0, 0);
  if (candidate.getTime() <= start.getTime()) candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);

  const lastYear = start.getFullYear() + NEXT_RUN_SEARCH_YEARS;
  while (candidate.getFullYear() <= lastYear) {
    if (!parsed.fields.month.includes(candidate.getMonth() + 1)) {
      candidate.setDate(1);
      candidate.setMonth(candidate.getMonth() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(parsed, candidate)) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }
    if (!parsed.fields.hour.includes(candidate.getHours())) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!parsed.fields.minute.includes(candidate.getMinutes())) {
      candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);
      continue;
    }
    return candidate;
  }
  throw cronError("cron-no-next-run");
}

/**
 * Atomic JSON-backed cron registry. Mutations are serialized and are only
 * reported as successful after their temp-file + rename commit completes.
 */
export class CronStore {
  constructor({
    runtimeDir,
    dataDir,
    file,
    now = () => new Date(),
    idFactory = randomUUID,
    maxHistory = DEFAULT_HISTORY_LIMIT,
  } = {}) {
    const root = runtimeDir ?? dataDir;
    if (!file && (!root || typeof root !== "string")) throw new TypeError("cron-runtime-dir-required");
    if (typeof now !== "function") throw new TypeError("cron-clock-required");
    if (typeof idFactory !== "function") throw new TypeError("cron-id-factory-required");
    if (!Number.isInteger(maxHistory) || maxHistory < 1 || maxHistory > 10_000) {
      throw new RangeError("cron-history-limit-invalid");
    }

    this.file = file ?? join(root, "cron-jobs.json");
    this.now = now;
    this.idFactory = idFactory;
    this.maxHistory = maxHistory;
    this.operationChain = Promise.resolve();
    this.tempCounter = 0;
    this.state = emptyState(this.nowDate().toISOString());
  }

  async load() {
    await this.operationChain;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      const normalized = normalizeState(parsed, this.nowDate(), this.maxHistory);
      this.state = normalized.state;
      // A process cannot resume an in-memory callback after restart. Persist
      // the interrupted outcome during load so later restarts do not keep
      // presenting the run (and its owning job) as perpetually running.
      if (normalized.recoveredRuns > 0) await this.writeState(this.state);
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      this.state = emptyState(this.nowDate().toISOString());
    }
    return this.snapshot();
  }

  list() {
    return clone(this.state.jobs);
  }

  get(id) {
    const job = this.state.jobs.find(entry => entry.id === id);
    return job ? clone(job) : null;
  }

  snapshot() {
    return clone(this.state);
  }

  async create(input) {
    const value = normalizeCreateInput(input);
    return this.commit(state => {
      const timestamp = this.nowDate();
      const id = this.uniqueId(state.jobs.map(job => job.id));
      const enabled = value.enabled ?? true;
      const job = {
        id,
        name: value.name,
        prompt: value.prompt,
        expression: value.expression,
        enabled,
        createdAt: timestamp.toISOString(),
        updatedAt: timestamp.toISOString(),
        lastRunAt: null,
        lastRunStatus: null,
        lastScheduledAt: null,
        nextRunAt: enabled ? nextCronRun(value.expression, timestamp).toISOString() : null,
      };
      state.jobs.push(job);
      state.runs[id] = [];
      return job;
    });
  }

  async update(id, patch) {
    assertId(id);
    const value = normalizeUpdateInput(patch);
    return this.commit(state => {
      const job = requireJob(state, id);
      const timestamp = this.nowDate();
      const expressionChanged = value.expression !== undefined && value.expression !== job.expression;
      const enabledChanged = value.enabled !== undefined && value.enabled !== job.enabled;

      if (value.name !== undefined) job.name = value.name;
      if (value.prompt !== undefined) job.prompt = value.prompt;
      if (value.expression !== undefined) job.expression = value.expression;
      if (value.enabled !== undefined) job.enabled = value.enabled;
      if (!job.enabled) job.nextRunAt = null;
      else if (expressionChanged || enabledChanged || !validIso(job.nextRunAt)) {
        job.nextRunAt = nextCronRun(job.expression, timestamp).toISOString();
      }
      job.updatedAt = timestamp.toISOString();
      return job;
    });
  }

  async remove(id) {
    assertId(id);
    return this.commit(state => {
      const index = state.jobs.findIndex(job => job.id === id);
      if (index === -1) return false;
      state.jobs.splice(index, 1);
      delete state.runs[id];
      return true;
    });
  }

  async delete(id) {
    return this.remove(id);
  }

  async pause(id) {
    return this.update(id, { enabled: false });
  }

  async resume(id) {
    return this.update(id, { enabled: true });
  }

  history(id, limit = this.maxHistory) {
    assertId(id);
    const count = normalizeHistoryLimit(limit, this.maxHistory);
    return clone((this.state.runs[id] ?? []).slice(0, count));
  }

  getRunHistory(id, limit) {
    return this.history(id, limit);
  }

  /** Atomically claim and persist a run before its callback starts. */
  async beginRun(id, options = {}) {
    assertId(id);
    const trigger = normalizeTrigger(options.trigger);
    return this.commit(state => {
      const job = requireJob(state, id);
      const runs = state.runs[id] ?? (state.runs[id] = []);
      // This durable claim guard complements the scheduler's in-memory lock.
      // It also protects callers that share a store through separate runner
      // instances: the serialized commit permits only one running record.
      if (runs.some(entry => entry.status === "running")) return null;
      const started = this.nowDate();
      const scheduledFor = trigger === "scheduled"
        ? floorToMinute(options.scheduledFor ?? started).toISOString()
        : null;

      if (trigger === "scheduled") {
        if (!job.enabled || job.lastScheduledAt === scheduledFor) return null;
        job.lastScheduledAt = scheduledFor;
        const nextFrom = toDate(options.nextFrom ?? scheduledFor, "cron-next-start-invalid");
        job.nextRunAt = nextCronRun(job.expression, nextFrom).toISOString();
      }

      const run = {
        id: this.uniqueId((state.runs[id] ?? []).map(entry => entry.id)),
        jobId: id,
        trigger,
        status: "running",
        scheduledFor,
        dueAt: trigger === "scheduled" && validIso(options.dueAt) ? new Date(options.dueAt).toISOString() : null,
        startedAt: started.toISOString(),
        finishedAt: null,
        durationMs: null,
        sessionId: null,
        result: null,
        error: null,
      };
      runs.unshift(run);
      trimHistory(runs, this.maxHistory);
      job.lastRunAt = run.startedAt;
      job.lastRunStatus = run.status;
      job.updatedAt = run.startedAt;
      return run;
    });
  }

  async finishRun(id, runId, outcome = {}) {
    assertId(id);
    assertId(runId);
    const status = normalizeFinalStatus(outcome.status);
    return this.commit(state => {
      const job = requireJob(state, id);
      const run = (state.runs[id] ?? []).find(entry => entry.id === runId);
      if (!run) throw notFound("cron-run-not-found");
      const finished = this.nowDate();
      run.status = status;
      run.finishedAt = finished.toISOString();
      run.durationMs = Math.max(0, finished.getTime() - new Date(run.startedAt).getTime());
      run.sessionId = optionalText(outcome.sessionId, 256);
      run.result = optionalText(outcome.result, MAX_RUN_TEXT_LENGTH);
      run.error = optionalText(outcome.error, MAX_RUN_TEXT_LENGTH);
      job.lastRunStatus = status;
      job.updatedAt = run.finishedAt;
      return run;
    });
  }

  /** Add an already-completed external run while keeping the same bounded log. */
  async recordRun(id, record = {}) {
    assertId(id);
    const status = normalizeFinalStatus(record.status);
    const trigger = normalizeTrigger(record.trigger ?? "manual");
    return this.commit(state => {
      const job = requireJob(state, id);
      const now = this.nowDate();
      const started = record.startedAt == null ? now : toDate(record.startedAt, "cron-run-start-invalid");
      const finished = record.finishedAt == null ? now : toDate(record.finishedAt, "cron-run-finish-invalid");
      if (finished.getTime() < started.getTime()) throw new RangeError("cron-run-time-invalid");
      const run = {
        id: record.id ? validatedId(record.id) : this.uniqueId((state.runs[id] ?? []).map(entry => entry.id)),
        jobId: id,
        trigger,
        status,
        scheduledFor: trigger === "scheduled" && record.scheduledFor != null
          ? floorToMinute(record.scheduledFor).toISOString()
          : null,
        dueAt: validIso(record.dueAt) ? new Date(record.dueAt).toISOString() : null,
        startedAt: started.toISOString(),
        finishedAt: finished.toISOString(),
        durationMs: Math.max(0, finished.getTime() - started.getTime()),
        sessionId: optionalText(record.sessionId, 256),
        result: optionalText(record.result, MAX_RUN_TEXT_LENGTH),
        error: optionalText(record.error, MAX_RUN_TEXT_LENGTH),
      };
      const runs = state.runs[id] ?? (state.runs[id] = []);
      if (runs.some(entry => entry.id === run.id)) throw new Error("cron-run-id-conflict");
      runs.unshift(run);
      trimHistory(runs, this.maxHistory);
      job.lastRunAt = run.startedAt;
      job.lastRunStatus = run.status;
      job.updatedAt = now.toISOString();
      return run;
    });
  }

  nowDate() {
    return toDate(this.now(), "cron-clock-invalid");
  }

  uniqueId(existing) {
    const used = new Set(existing);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = validatedId(String(this.idFactory()));
      if (!used.has(id)) return id;
    }
    throw new Error("cron-id-conflict");
  }

  async commit(mutator) {
    const operation = this.operationChain.then(async () => {
      const previous = clone(this.state);
      try {
        const result = mutator(this.state);
        this.state.schemaVersion = SCHEMA_VERSION;
        this.state.updatedAt = this.nowDate().toISOString();
        await this.writeState(this.state);
        return clone(result);
      } catch (error) {
        this.state = previous;
        throw error;
      }
    });
    this.operationChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async writeState(state) {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp-${process.pid}-${++this.tempCounter}`;
    let handle;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(JSON.stringify(state, null, 2), "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temp, this.file);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await rm(temp, { force: true }).catch(() => {});
    }
  }
}

function parseField(raw, definition) {
  if (!raw || !/^[0-9*/,\-]+$/.test(raw)) throw cronError(`cron-${definition.name}-invalid`);
  const values = new Set();
  const parts = raw.split(",");
  if (parts.some(part => !part)) throw cronError(`cron-${definition.name}-invalid`);

  for (const part of parts) {
    const stepParts = part.split("/");
    if (stepParts.length > 2 || !stepParts[0] || (stepParts.length === 2 && !stepParts[1])) {
      throw cronError(`cron-${definition.name}-invalid`);
    }
    const base = stepParts[0];
    const step = stepParts.length === 2 ? parseInteger(stepParts[1], definition.name) : 1;
    let start;
    let end;

    if (base === "*") {
      start = definition.min;
      end = definition.max;
    } else if (base.includes("-")) {
      const bounds = base.split("-");
      if (bounds.length !== 2 || !bounds[0] || !bounds[1]) throw cronError(`cron-${definition.name}-invalid`);
      start = parseInteger(bounds[0], definition.name);
      end = parseInteger(bounds[1], definition.name);
    } else {
      if (stepParts.length === 2) throw cronError(`cron-${definition.name}-step-requires-range`);
      start = parseInteger(base, definition.name);
      end = start;
    }

    if (start < definition.min || end > definition.max || start > end) {
      throw cronError(`cron-${definition.name}-range-invalid`);
    }
    const width = end - start + 1;
    if (step < 1 || step > width) throw cronError(`cron-${definition.name}-step-invalid`);
    for (let value = start; value <= end; value += step) {
      values.add(definition.normalize ? definition.normalize(value) : value);
    }
  }

  if (values.size === 0) throw cronError(`cron-${definition.name}-empty`);
  return { values: [...values].sort((left, right) => left - right), wildcard: raw === "*" };
}

function parseInteger(raw, field) {
  if (!/^\d+$/.test(raw)) throw cronError(`cron-${field}-invalid`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw cronError(`cron-${field}-invalid`);
  return value;
}

function assertCalendarCanMatch(parsed) {
  if (!parsed.wildcard.dayOfWeek || parsed.wildcard.dayOfMonth) return;
  const possible = parsed.fields.month.some(month => {
    const maxDay = month === 2 ? 29 : [4, 6, 9, 11].includes(month) ? 30 : 31;
    return parsed.fields.dayOfMonth.some(day => day <= maxDay);
  });
  if (!possible) throw cronError("cron-calendar-impossible");
}

function dayMatches(parsed, date) {
  const dayOfMonthMatches = parsed.fields.dayOfMonth.includes(date.getDate());
  const dayOfWeekMatches = parsed.fields.dayOfWeek.includes(date.getDay());
  if (parsed.wildcard.dayOfMonth && parsed.wildcard.dayOfWeek) return true;
  if (parsed.wildcard.dayOfMonth) return dayOfWeekMatches;
  if (parsed.wildcard.dayOfWeek) return dayOfMonthMatches;
  return dayOfMonthMatches || dayOfWeekMatches;
}

function asParsedExpression(expression) {
  if (typeof expression === "string") return parseCronExpression(expression);
  if (expression && typeof expression === "object" && expression.fields && expression.wildcard) return expression;
  throw cronError("cron-expression-invalid");
}

function emptyState(timestamp) {
  return { schemaVersion: SCHEMA_VERSION, jobs: [], runs: {}, updatedAt: timestamp };
}

function normalizeState(value, now, maxHistory) {
  if (!value || typeof value !== "object") {
    return { state: emptyState(now.toISOString()), recoveredRuns: 0 };
  }
  const jobs = [];
  const runs = {};
  let recoveredRuns = 0;
  for (const raw of Array.isArray(value.jobs) ? value.jobs : []) {
    try {
      const id = validatedId(raw.id);
      const expression = parseCronExpression(raw.expression).expression;
      const enabled = raw.enabled !== false;
      const createdAt = validIso(raw.createdAt) ? new Date(raw.createdAt).toISOString() : now.toISOString();
      const updatedAt = validIso(raw.updatedAt) ? new Date(raw.updatedAt).toISOString() : createdAt;
      const job = {
        id,
        name: requiredText(raw.name, "cron-name-required", MAX_NAME_LENGTH),
        prompt: requiredText(raw.prompt, "cron-prompt-required", MAX_PROMPT_LENGTH),
        expression,
        enabled,
        createdAt,
        updatedAt,
        lastRunAt: validIso(raw.lastRunAt) ? new Date(raw.lastRunAt).toISOString() : null,
        lastRunStatus: typeof raw.lastRunStatus === "string" ? raw.lastRunStatus : null,
        lastScheduledAt: validIso(raw.lastScheduledAt) ? floorToMinute(raw.lastScheduledAt).toISOString() : null,
        nextRunAt: enabled
          ? validIso(raw.nextRunAt) ? new Date(raw.nextRunAt).toISOString() : nextCronRun(expression, now).toISOString()
          : null,
      };
      const normalized = normalizeRuns(value.runs?.[id], id, maxHistory, now);
      runs[id] = normalized.runs;
      recoveredRuns += normalized.recoveredRuns;
      const latestRun = normalized.runs[0];
      if (latestRun) {
        job.lastRunAt = latestRun.startedAt;
        job.lastRunStatus = latestRun.status;
      }
      if (normalized.recoveredRuns > 0) job.updatedAt = now.toISOString();
      jobs.push(job);
    } catch {
      // A malformed entry cannot be scheduled safely; keep loading valid jobs.
    }
  }
  return {
    state: {
      schemaVersion: SCHEMA_VERSION,
      jobs,
      runs,
      updatedAt: recoveredRuns > 0
        ? now.toISOString()
        : validIso(value.updatedAt) ? new Date(value.updatedAt).toISOString() : now.toISOString(),
    },
    recoveredRuns,
  };
}

function normalizeRuns(value, jobId, maxHistory, now) {
  if (!Array.isArray(value)) return { runs: [], recoveredRuns: 0 };
  const runs = [];
  let recoveredRuns = 0;
  for (const raw of value) {
    try {
      const startedAt = toDate(raw.startedAt, "cron-run-start-invalid");
      const interrupted = raw.status === "running";
      const finishedAt = interrupted
        ? new Date(now)
        : validIso(raw.finishedAt) ? new Date(raw.finishedAt) : null;
      if (interrupted) recoveredRuns += 1;
      runs.push({
        id: validatedId(raw.id),
        jobId,
        trigger: normalizeTrigger(raw.trigger),
        status: interrupted ? "cancelled" : normalizeFinalStatus(raw.status),
        scheduledFor: validIso(raw.scheduledFor) ? floorToMinute(raw.scheduledFor).toISOString() : null,
        dueAt: validIso(raw.dueAt) ? new Date(raw.dueAt).toISOString() : null,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt?.toISOString() ?? null,
        durationMs: finishedAt ? Math.max(0, finishedAt.getTime() - startedAt.getTime()) : null,
        sessionId: optionalText(raw.sessionId, 256),
        result: optionalText(raw.result, MAX_RUN_TEXT_LENGTH),
        error: optionalText(raw.error, MAX_RUN_TEXT_LENGTH)
          ?? (interrupted ? "cron-run-interrupted" : null),
      });
    } catch {
      // Invalid history must not prevent the owning job from loading.
    }
  }
  runs.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
  trimHistory(runs, maxHistory);
  return { runs, recoveredRuns };
}

function normalizeCreateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("cron-job-required");
  return {
    name: requiredText(input.name, "cron-name-required", MAX_NAME_LENGTH),
    prompt: requiredText(input.prompt, "cron-prompt-required", MAX_PROMPT_LENGTH),
    expression: parseCronExpression(input.expression).expression,
    enabled: input.enabled === undefined ? undefined : requiredBoolean(input.enabled),
  };
}

function normalizeUpdateInput(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("cron-patch-required");
  const allowed = new Set(["name", "prompt", "expression", "enabled"]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new TypeError(`cron-patch-field-unsupported:${key}`);
  }
  return {
    ...(patch.name !== undefined ? { name: requiredText(patch.name, "cron-name-required", MAX_NAME_LENGTH) } : {}),
    ...(patch.prompt !== undefined ? { prompt: requiredText(patch.prompt, "cron-prompt-required", MAX_PROMPT_LENGTH) } : {}),
    ...(patch.expression !== undefined ? { expression: parseCronExpression(patch.expression).expression } : {}),
    ...(patch.enabled !== undefined ? { enabled: requiredBoolean(patch.enabled) } : {}),
  };
}

function requireJob(state, id) {
  const job = state.jobs.find(entry => entry.id === id);
  if (!job) throw notFound("cron-job-not-found");
  return job;
}

function normalizeTrigger(value) {
  if (value === "scheduled" || value === "manual") return value;
  throw new TypeError("cron-trigger-invalid");
}

function normalizeFinalStatus(value) {
  if (value === undefined || value === "success") return "success";
  if (value === "error" || value === "cancelled") return value;
  throw new TypeError("cron-run-status-invalid");
}

function normalizeHistoryLimit(value, maximum) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError("cron-history-request-invalid");
  return Math.min(limit, maximum);
}

function requiredBoolean(value) {
  if (typeof value !== "boolean") throw new TypeError("cron-enabled-invalid");
  return value;
}

function requiredText(value, code, maxLength) {
  if (typeof value !== "string") throw new TypeError(code);
  const text = value.trim();
  if (!text || text.length > maxLength) throw new TypeError(code);
  return text;
}

function optionalText(value, maxLength) {
  if (value == null || value === "") return null;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const text = typeof serialized === "string" ? serialized : String(value);
  return text.slice(0, maxLength);
}

function assertId(id) {
  validatedId(id);
}

function validatedId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new TypeError("cron-id-invalid");
  }
  return id;
}

function validIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function toDate(value, code) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError(code);
  return date;
}

function floorToMinute(value) {
  const date = toDate(value, "cron-minute-invalid");
  date.setSeconds(0, 0);
  return date;
}

function trimHistory(runs, maximum) {
  if (runs.length > maximum) runs.splice(maximum);
}

function clone(value) {
  return structuredClone(value);
}

function cronError(code) {
  const error = new RangeError(code);
  error.code = code;
  return error;
}

function notFound(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
