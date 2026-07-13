import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CronStore,
  matchesCron,
  nextCronRun,
  parseCronExpression,
} from "../core/cron-store.js";
import { CronScheduler } from "../core/cron-scheduler.js";

describe("cron expression parsing", () => {
  it("supports wildcards, steps, lists, ranges and Sunday alias 7", () => {
    const parsed = parseCronExpression("* */2 1,15 1-6/2 1-5,7");

    expect(parsed.expression).toBe("* */2 1,15 1-6/2 1-5,7");
    expect(parsed.minute).toHaveLength(60);
    expect(parsed.hour).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
    expect(parsed.dayOfMonth).toEqual([1, 15]);
    expect(parsed.month).toEqual([1, 3, 5]);
    expect(parsed.dayOfWeek).toEqual([0, 1, 2, 3, 4, 5]);
    expect(parsed.wildcard.minute).toBe(true);
    expect(parsed.wildcard.hour).toBe(false);
  });

  it.each([
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 8",
    "*/0 * * * *",
    "*/61 * * * *",
    "1,,2 * * * *",
    "5-1 * * * *",
    "5/2 * * * *",
    "MON * * * *",
    "0 0 31 2 *",
  ])("rejects invalid or impossible expression %s", expression => {
    expect(() => parseCronExpression(expression)).toThrow();
  });

  it("uses standard OR semantics when both day fields are restricted", () => {
    const expression = "0 0 13 * 1";

    expect(matchesCron(expression, new Date(2025, 1, 13, 0, 0))).toBe(true); // day-of-month
    expect(matchesCron(expression, new Date(2025, 1, 17, 0, 0))).toBe(true); // Monday
    expect(matchesCron(expression, new Date(2025, 1, 18, 0, 0))).toBe(false);
  });

  it("computes the next matching minute across work-week and leap-year boundaries", () => {
    expect(nextCronRun("*/15 9-17 * * 1-5", new Date(2025, 0, 3, 17, 59))).toEqual(
      new Date(2025, 0, 6, 9, 0),
    );
    expect(nextCronRun("0 0 29 2 *", new Date(2025, 0, 1, 0, 0))).toEqual(
      new Date(2028, 1, 29, 0, 0),
    );
  });
});

describe("CronStore", () => {
  let dir: string;
  let now: Date;
  let sequence: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kyrei-cron-"));
    now = new Date(2025, 0, 1, 8, 0, 30);
    sequence = 0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeStore(maxHistory = 3) {
    return new CronStore({
      runtimeDir: dir,
      maxHistory,
      now: () => new Date(now),
      idFactory: () => `id-${++sequence}`,
    });
  }

  it("persists CRUD, pause/resume and computed run metadata atomically", async () => {
    const store = makeStore();
    await store.load();
    const created = await store.create({
      name: "  Morning review  ",
      prompt: "  Review the project  ",
      expression: "0 9 * * 1-5",
    });

    expect(created).toMatchObject({
      id: "id-1",
      name: "Morning review",
      prompt: "Review the project",
      expression: "0 9 * * 1-5",
      enabled: true,
      lastRunAt: null,
      nextRunAt: new Date(2025, 0, 1, 9, 0).toISOString(),
    });

    expect(await store.pause(created.id)).toMatchObject({ enabled: false, nextRunAt: null });
    now = new Date(2025, 0, 1, 10, 0);
    expect(await store.resume(created.id)).toMatchObject({
      enabled: true,
      nextRunAt: new Date(2025, 0, 2, 9, 0).toISOString(),
    });
    expect(await store.update(created.id, { name: "Daily review", expression: "30 10 * * *" })).toMatchObject({
      name: "Daily review",
      nextRunAt: new Date(2025, 0, 1, 10, 30).toISOString(),
    });

    const files = await readdir(dir);
    expect(files).toEqual(["cron-jobs.json"]);

    const reloaded = makeStore();
    await reloaded.load();
    expect(reloaded.get(created.id)).toMatchObject({
      name: "Daily review",
      expression: "30 10 * * *",
      enabled: true,
    });
    expect(await reloaded.delete(created.id)).toBe(true);
    expect(await reloaded.remove(created.id)).toBe(false);

    const finalLoad = makeStore();
    await finalLoad.load();
    expect(finalLoad.list()).toEqual([]);
  });

  it("bounds durable run history and protects returned snapshots from mutation", async () => {
    const store = makeStore(2);
    await store.load();
    const job = await store.create({ name: "Job", prompt: "Run", expression: "* * * * *" });

    await store.recordRun(job.id, { status: "success", result: "one" });
    now = new Date(now.getTime() + 1_000);
    await store.recordRun(job.id, { status: "error", error: "two" });
    now = new Date(now.getTime() + 1_000);
    await store.recordRun(job.id, { status: "success", result: "three" });

    const history = store.history(job.id);
    expect(history).toHaveLength(2);
    expect(history.map(run => run.result ?? run.error)).toEqual(["three", "two"]);
    history[0].status = "error";
    expect(store.history(job.id)[0].status).toBe("success");

    const reloaded = makeStore(2);
    await reloaded.load();
    expect(reloaded.history(job.id).map(run => run.result ?? run.error)).toEqual(["three", "two"]);
  });

  it("recovers persisted running runs as cancelled and reconciles the owning job", async () => {
    const store = makeStore();
    await store.load();
    const job = await store.create({ name: "Recover me", prompt: "Run", expression: "* * * * *" });
    const running = await store.beginRun(job.id, { trigger: "manual" });
    expect(running).toMatchObject({ status: "running" });

    now = new Date(now.getTime() + 7_500);
    const recovered = makeStore();
    await recovered.load();

    const run = recovered.history(job.id)[0];
    expect(run).toMatchObject({
      id: running!.id,
      status: "cancelled",
      finishedAt: now.toISOString(),
      durationMs: 7_500,
      error: "cron-run-interrupted",
    });
    expect(recovered.get(job.id)).toMatchObject({
      lastRunAt: running!.startedAt,
      lastRunStatus: "cancelled",
      updatedAt: now.toISOString(),
    });

    // Recovery is committed during load; a second load must observe the same
    // completed record instead of assigning a new finish time.
    now = new Date(now.getTime() + 10_000);
    const persisted = makeStore();
    await persisted.load();
    expect(persisted.history(job.id)[0]).toEqual(run);
    expect(persisted.get(job.id)?.lastRunStatus).toBe("cancelled");
  });
});

describe("CronScheduler", () => {
  let dir: string;
  let now: Date;
  let sequence: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kyrei-cron-scheduler-"));
    now = new Date(2025, 0, 1, 0, 0, 30);
    sequence = 0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeStore() {
    const store = new CronStore({
      runtimeDir: dir,
      now: () => new Date(now),
      idFactory: () => `id-${++sequence}`,
      maxHistory: 10,
    });
    await store.load();
    return store;
  }

  it("claims each due job at most once per minute and advances before running", async () => {
    const store = await makeStore();
    const job = await store.create({ name: "Every minute", prompt: "Run", expression: "* * * * *" });
    const calls: Array<{ id: string; trigger: string; nextRunAt: string }> = [];
    const scheduler = new CronScheduler({
      store,
      now: () => new Date(now),
      runJob: async (current, context) => {
        calls.push({ id: current.id, trigger: context.trigger, nextRunAt: current.nextRunAt });
        return { sessionId: `session-${calls.length}`, summary: "done" };
      },
    });

    now = new Date(2025, 0, 1, 0, 1, 15);
    await scheduler.tick();
    await scheduler.tick();
    now = new Date(2025, 0, 1, 0, 1, 59);
    await scheduler.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      id: job.id,
      trigger: "scheduled",
      nextRunAt: new Date(2025, 0, 1, 0, 2).toISOString(),
    });

    now = new Date(2025, 0, 1, 0, 2, 5);
    await scheduler.tick();
    expect(calls).toHaveLength(2);
    expect(store.history(job.id).map(run => run.status)).toEqual(["success", "success"]);
    expect(store.get(job.id)).toMatchObject({
      lastRunStatus: "success",
      lastScheduledAt: new Date(2025, 0, 1, 0, 2).toISOString(),
      nextRunAt: new Date(2025, 0, 1, 0, 3).toISOString(),
    });
  });

  it("manual trigger uses the same callback for paused jobs and records failures", async () => {
    const store = await makeStore();
    const job = await store.create({ name: "Paused", prompt: "Run", expression: "0 9 * * *", enabled: false });
    const runJob = vi.fn().mockRejectedValue(new Error("callback failed"));
    const scheduler = new CronScheduler({ store, runJob, now: () => new Date(now) });

    const run = await scheduler.trigger(job.id);

    expect(runJob).toHaveBeenCalledOnce();
    expect(runJob.mock.calls[0][1]).toMatchObject({ trigger: "manual" });
    expect(run).toMatchObject({ trigger: "manual", status: "error", error: "callback failed" });
    expect(store.get(job.id)).toMatchObject({ enabled: false, nextRunAt: null, lastRunStatus: "error" });
  });

  it("prevents concurrent manual/manual and manual/scheduled runs for one job", async () => {
    const store = await makeStore();
    const job = await store.create({ name: "Exclusive", prompt: "Run", expression: "* * * * *" });
    const gate = deferred<{ summary: string }>();
    const runJob = vi.fn()
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValue({ summary: "scheduled" });
    const scheduler = new CronScheduler({ store, runJob, now: () => new Date(now) });

    now = new Date(2025, 0, 1, 0, 1, 15);
    const first = scheduler.trigger(job.id);
    await vi.waitFor(() => expect(runJob).toHaveBeenCalledOnce());

    expect(await scheduler.trigger(job.id)).toBeNull();
    expect(await scheduler.tick()).toEqual([]);
    expect(runJob).toHaveBeenCalledOnce();
    expect(store.history(job.id)).toHaveLength(1);
    expect(store.history(job.id)[0].status).toBe("running");

    gate.resolve({ summary: "manual" });
    await expect(first).resolves.toMatchObject({ status: "success", trigger: "manual" });

    // The due slot was not consumed while the manual run held the lock, so it
    // can run exactly once after the job becomes idle.
    await expect(scheduler.tick()).resolves.toHaveLength(1);
    expect(runJob).toHaveBeenCalledTimes(2);
    expect(store.history(job.id).map(run => run.trigger)).toEqual(["scheduled", "manual"]);
    expect(store.history(job.id).map(run => run.status)).toEqual(["success", "success"]);
  });

  it.each(["cancelled", "interrupted"] as const)("records a %s callback result as cancelled", async status => {
    const store = await makeStore();
    const job = await store.create({ name: status, prompt: "Run", expression: "* * * * *" });
    const scheduler = new CronScheduler({
      store,
      runJob: vi.fn().mockResolvedValue({ status, sessionId: "session-1", message: status }),
      now: () => new Date(now),
    });

    await expect(scheduler.trigger(job.id)).resolves.toMatchObject({
      status: "cancelled",
      sessionId: "session-1",
      error: status,
    });
    expect(store.get(job.id)?.lastRunStatus).toBe("cancelled");
  });

  it("waits for in-flight run persistence when stopped", async () => {
    const store = await makeStore();
    const job = await store.create({ name: "Stopping", prompt: "Run", expression: "* * * * *" });
    const gate = deferred<{ summary: string }>();
    const runJob = vi.fn(() => gate.promise);
    const scheduler = new CronScheduler({ store, runJob, now: () => new Date(now) });
    const runPromise = scheduler.trigger(job.id);
    await vi.waitFor(() => expect(runJob).toHaveBeenCalledOnce());

    let stopped = false;
    const stopPromise = scheduler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(await scheduler.trigger(job.id)).toBeNull();

    gate.resolve({ summary: "persisted" });
    await runPromise;
    await stopPromise;
    expect(stopped).toBe(true);

    const reloaded = await makeStore();
    expect(reloaded.history(job.id)[0]).toMatchObject({ status: "success", result: "persisted" });
  });

  it("cancels a durable claim that completes after shutdown without starting the callback", async () => {
    const claim = deferred<{
      id: string;
      jobId: string;
      trigger: "manual";
      scheduledFor: null;
      dueAt: null;
    }>();
    const job = { id: "job-1", name: "Deferred claim", prompt: "Run" };
    const finishRun = vi.fn(async (
      _jobId: string,
      _runId: string,
      outcome: { status: string; error: string },
    ) => ({
      id: "run-1",
      jobId: job.id,
      trigger: "manual",
      ...outcome,
    }));
    const store = {
      list: vi.fn(() => []),
      get: vi.fn(() => job),
      beginRun: vi.fn(() => claim.promise),
      finishRun,
    };
    const runJob = vi.fn();
    const scheduler = new CronScheduler({ store, runJob, now: () => new Date(now) });

    const execution = scheduler.trigger(job.id);
    await vi.waitFor(() => expect(store.beginRun).toHaveBeenCalledOnce());
    const stopping = scheduler.stop();
    claim.resolve({
      id: "run-1",
      jobId: job.id,
      trigger: "manual",
      scheduledFor: null,
      dueAt: null,
    });

    await expect(execution).resolves.toMatchObject({
      status: "cancelled",
      error: "cron-run-interrupted",
    });
    await stopping;
    expect(runJob).not.toHaveBeenCalled();
    expect(finishRun).toHaveBeenCalledWith(job.id, "run-1", {
      status: "cancelled",
      error: "cron-run-interrupted",
    });
  });

  it("starts and stops through injected timer functions", async () => {
    const store = await makeStore();
    let scheduled: (() => void) | null = null;
    const handle = { unref: vi.fn() };
    const setInterval = vi.fn((callback: () => void) => {
      scheduled = callback;
      return handle;
    });
    const clearInterval = vi.fn();
    const scheduler = new CronScheduler({
      store,
      runJob: vi.fn(),
      now: () => new Date(now),
      intervalMs: 1_000,
      setInterval,
      clearInterval,
    });

    expect(scheduler.start()).toBe(scheduler);
    expect(scheduler.start()).toBe(scheduler);
    expect(setInterval).toHaveBeenCalledOnce();
    expect(handle.unref).toHaveBeenCalledOnce();
    expect(scheduled).toBeTypeOf("function");
    expect(scheduler.running).toBe(true);

    await scheduler.stop();
    await scheduler.stop();
    expect(clearInterval).toHaveBeenCalledOnce();
    expect(clearInterval).toHaveBeenCalledWith(handle);
    expect(scheduler.running).toBe(false);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
