import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_OUTPUT_CHARS,
  MAX_TERMINALS_PER_OWNER,
  MAX_TERMINALS_PER_RENDERER,
  sanitizeAgentEnvironment,
  sanitizeTerminalEnvironment,
  TerminalSessionManager,
} from "../electron/terminal-session-manager.js";

function childProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { writable: boolean; write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { writable: true, write: vi.fn(), end: vi.fn() };
  child.kill = vi.fn(() => true);
  return child;
}

describe("desktop terminal session manager", () => {
  it("owns a real shell process per renderer and exposes stdout, stderr and exit state", async () => {
    const child = childProcess();
    const spawnImpl = vi.fn(() => child);
    const events: unknown[] = [];
    const manager = new TerminalSessionManager({
      spawnImpl,
      platform: "linux",
      environment: { SHELL: "/bin/bash", PATH: "/bin", SERVICE_TOKEN: "secret" },
      defaultCwd: "/home/user",
      createId: () => "terminal-a",
      clock: () => "2026-07-14T00:00:00.000Z",
    });
    manager.onEvent((event: unknown) => events.push(event));

    const created = manager.create({ rendererId: 4, ownerId: "chat-a", title: "Agent 1", cwd: "/work" });
    expect(created).toMatchObject({ id: "terminal-a", ownerId: "chat-a", kind: "manual", cwd: "/work", status: "running" });
    expect(spawnImpl).toHaveBeenCalledWith("/bin/bash", [], expect.objectContaining({ shell: false, cwd: "/work" }));
    expect(spawnImpl.mock.calls[0][2].env).not.toHaveProperty("SERVICE_TOKEN");

    manager.write(4, "terminal-a", "npm test\n");
    expect(child.stdin.write).toHaveBeenCalledWith("npm test\n");
    child.stdout.emit("data", Buffer.from("ok\n"));
    child.stderr.emit("data", Buffer.from("warning\n"));
    child.emit("exit", 2, null);

    expect(manager.list(4, "chat-a")[0]).toMatchObject({ status: "exited", exitCode: 2 });
    expect(manager.list(4, "chat-a")[0].output).toEqual([
      { stream: "stdout", text: "ok\n" },
      { stream: "stderr", text: "warning\n" },
    ]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "created", rendererId: 4 }),
      expect.objectContaining({ type: "output", stream: "stdout", text: "ok\n" }),
      expect.objectContaining({ type: "exited" }),
    ]));
  });

  it("prevents one window from reading or controlling another window's sessions", () => {
    const manager = new TerminalSessionManager({
      spawnImpl: () => childProcess(),
      platform: "linux",
      defaultCwd: "/home/user",
      createId: () => "private-terminal",
    });
    manager.create({ rendererId: 1, ownerId: "chat", title: "Private" });
    expect(manager.list(2, "chat")).toEqual([]);
    expect(() => manager.write(2, "private-terminal", "pwd\n")).toThrow("terminal_session_not_found");
  });

  it("keeps the finished agent tab when a reuse spawn fails synchronously", async () => {
    const firstChild = childProcess();
    const spawnImpl = vi.fn()
      .mockImplementationOnce(() => firstChild)
      .mockImplementationOnce(() => {
        throw new Error("simulated spawn failure");
      });
    const manager = new TerminalSessionManager({
      spawnImpl,
      platform: "linux",
      defaultCwd: "/home/user",
      createId: () => "agent-keep",
    });

    const first = manager.runAgentCommand({
      rendererId: 1,
      ownerId: "chat",
      actorId: "main",
      toolCallId: "tool-1",
      command: "echo first",
      cwd: "/work",
      timeoutMs: 60_000,
    });
    firstChild.stdout.emit("data", Buffer.from("prior output\n"));
    firstChild.emit("exit", 0, null);
    firstChild.emit("close", 0, null);
    await first;

    await expect(manager.runAgentCommand({
      rendererId: 1,
      ownerId: "chat",
      actorId: "main",
      toolCallId: "tool-2",
      command: "echo second",
      cwd: "/work",
      timeoutMs: 60_000,
    })).rejects.toThrow("Command failed to start: simulated spawn failure");

    expect(manager.list(1, "chat")).toHaveLength(1);
    expect(manager.list(1, "chat")[0]).toMatchObject({
      id: "agent-keep",
      kind: "agent",
      actorId: "main",
      toolCallId: "tool-1",
      status: "exited",
      output: [{ stream: "stdout", text: "prior output\n" }],
    });
  });

  it("reuses a finished agent terminal for the next sequential command of the same actor", async () => {
    const firstChild = childProcess();
    const secondChild = childProcess();
    const spawnImpl = vi.fn()
      .mockImplementationOnce(() => firstChild)
      .mockImplementationOnce(() => secondChild);
    const events: Array<Record<string, unknown>> = [];
    const manager = new TerminalSessionManager({
      spawnImpl,
      platform: "linux",
      defaultCwd: "/home/user",
      createId: () => "must-not-create-second-id",
      clock: (() => {
        let tick = 0;
        return () => `2026-07-14T00:00:0${tick++}.000Z`;
      })(),
    });
    manager.onEvent((event: Record<string, unknown>) => events.push(event));

    const first = manager.runAgentCommand({
      rendererId: 1,
      ownerId: "chat",
      actorId: "main",
      toolCallId: "tool-1",
      command: "npm test",
      cwd: "/work",
      timeoutMs: 60_000,
    });
    firstChild.stdout.emit("data", Buffer.from("first\n"));
    firstChild.emit("exit", 0, null);
    firstChild.emit("close", 0, null);
    await first;

    const second = manager.runAgentCommand({
      rendererId: 1,
      ownerId: "chat",
      actorId: "main",
      toolCallId: "tool-2",
      command: "npm run build",
      cwd: "/work",
      timeoutMs: 60_000,
    });

    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(manager.list(1, "chat")).toHaveLength(1);
    expect(manager.list(1, "chat")[0]).toMatchObject({
      id: expect.any(String),
      kind: "agent",
      actorId: "main",
      toolCallId: "tool-2",
      status: "running",
      output: [],
    });
    const reusedId = manager.list(1, "chat")[0].id;

    secondChild.stdout.emit("data", Buffer.from("second\n"));
    secondChild.emit("exit", 0, null);
    secondChild.emit("close", 0, null);
    await second;

    expect(manager.list(1, "chat")).toHaveLength(1);
    expect(manager.list(1, "chat")[0]).toMatchObject({
      id: reusedId,
      toolCallId: "tool-2",
      status: "exited",
      output: [{ stream: "stdout", text: "second\n" }],
    });
    expect(events.filter((event) => event.type === "closed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "created")).toHaveLength(2);
  });

  it("keeps concurrent agent commands on separate tabs and reclaims finished ones for capacity", async () => {
    let nextId = 0;
    const queue: ReturnType<typeof childProcess>[] = [];
    const spawnImpl = vi.fn(() => queue.shift() ?? childProcess());
    const manager = new TerminalSessionManager({
      spawnImpl,
      platform: "linux",
      defaultCwd: "/home/user",
      createId: () => `agent-${++nextId}`,
    });

    const firstChild = childProcess();
    const secondChild = childProcess();
    queue.push(firstChild, secondChild);
    const first = manager.runAgentCommand({
      rendererId: 1,
      ownerId: "chat",
      actorId: "main",
      toolCallId: "parallel-0",
      command: "cmd-0",
      cwd: "/work",
      timeoutMs: 60_000,
    });
    const second = manager.runAgentCommand({
      rendererId: 1,
      ownerId: "chat",
      actorId: "main",
      toolCallId: "parallel-1",
      command: "cmd-1",
      cwd: "/work",
      timeoutMs: 60_000,
    });
    expect(manager.list(1, "chat")).toHaveLength(2);
    expect(manager.list(1, "chat").every((session) => session.status === "running")).toBe(true);

    firstChild.emit("exit", 0, null);
    firstChild.emit("close", 0, null);
    secondChild.emit("exit", 0, null);
    secondChild.emit("close", 0, null);
    await Promise.all([first, second]);
    // Same-actor free pool compacts to one finished tab after concurrent waves.
    expect(manager.list(1, "chat")).toHaveLength(1);

    // Fill the owner limit with finished agent tabs for distinct actors, then force reclaim.
    for (let index = 1; index < MAX_TERMINALS_PER_OWNER; index += 1) {
      const child = childProcess();
      queue.push(child);
      const pending = manager.runAgentCommand({
        rendererId: 1,
        ownerId: "chat",
        actorId: `worker-${index}`,
        toolCallId: `fill-${index}`,
        command: `fill-${index}`,
        cwd: "/work",
        timeoutMs: 60_000,
      });
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
      await pending;
    }
    expect(manager.list(1, "chat")).toHaveLength(MAX_TERMINALS_PER_OWNER);

    const nextChild = childProcess();
    queue.push(nextChild);
    const next = manager.runAgentCommand({
      rendererId: 1,
      ownerId: "chat",
      actorId: "fresh-actor",
      toolCallId: "after-full",
      command: "echo ok",
      cwd: "/work",
      timeoutMs: 60_000,
    });
    expect(manager.list(1, "chat").length).toBeLessThanOrEqual(MAX_TERMINALS_PER_OWNER);
    expect(manager.list(1, "chat").some((session) => session.actorId === "fresh-actor")).toBe(true);
    nextChild.emit("exit", 0, null);
    nextChild.emit("close", 0, null);
    await next;
  });

  it("does not reuse a finished agent tab across different actors or owners", async () => {
    let nextId = 0;
    const queue: ReturnType<typeof childProcess>[] = [];
    const manager = new TerminalSessionManager({
      spawnImpl: () => queue.shift() ?? childProcess(),
      platform: "linux",
      defaultCwd: "/home/user",
      createId: () => `agent-${++nextId}`,
    });

    const firstChild = childProcess();
    queue.push(firstChild);
    const first = manager.runAgentCommand({
      rendererId: 1,
      ownerId: "chat-a",
      actorId: "main",
      toolCallId: "a1",
      command: "pwd",
      cwd: "/work",
      timeoutMs: 60_000,
    });
    firstChild.emit("exit", 0, null);
    firstChild.emit("close", 0, null);
    await first;

    const subChild = childProcess();
    queue.push(subChild);
    const sub = manager.runAgentCommand({
      rendererId: 1,
      ownerId: "chat-a",
      actorId: "subagent-1",
      toolCallId: "s1",
      command: "pwd",
      cwd: "/work",
      timeoutMs: 60_000,
    });
    expect(manager.list(1, "chat-a")).toHaveLength(2);
    subChild.emit("exit", 0, null);
    subChild.emit("close", 0, null);
    await sub;

    const otherOwnerChild = childProcess();
    queue.push(otherOwnerChild);
    const other = manager.runAgentCommand({
      rendererId: 1,
      ownerId: "chat-b",
      actorId: "main",
      toolCallId: "b1",
      command: "pwd",
      cwd: "/work",
      timeoutMs: 60_000,
    });
    expect(manager.list(1, "chat-a")).toHaveLength(2);
    expect(manager.list(1, "chat-b")).toHaveLength(1);
    otherOwnerChild.emit("exit", 0, null);
    otherOwnerChild.emit("close", 0, null);
    await other;
  });

  it("runs an agent command exactly once and streams redacted stdout/stderr before close", async () => {
    const child = childProcess();
    const spawnImpl = vi.fn(() => child);
    const events: Array<Record<string, unknown>> = [];
    const manager = new TerminalSessionManager({
      spawnImpl,
      platform: "linux",
      environment: { PATH: "/bin", DATABASE_URL: "private", SERVICE_TOKEN: "secret" },
      defaultCwd: "/home/user",
      createId: () => "agent-command",
      clock: () => "2026-07-14T00:00:00.000Z",
    });
    manager.onEvent((event: Record<string, unknown>) => events.push(event));

    const pending = manager.runAgentCommand({
      rendererId: 7,
      ownerId: "chat-agent",
      actorId: "main",
      toolCallId: "tool-1",
      command: "npm test -- --run",
      cwd: "/work",
      timeoutMs: 60_000,
      sensitiveValues: ["split-secret-value"],
    });

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith("npm test -- --run", expect.objectContaining({
      cwd: "/work",
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    }));
    expect(spawnImpl.mock.calls[0][1].env).not.toHaveProperty("DATABASE_URL");
    expect(manager.list(7, "chat-agent")[0]).toMatchObject({
      kind: "agent",
      actorId: "main",
      toolCallId: "tool-1",
      status: "running",
    });

    child.stdout.emit("data", Buffer.from("before split-"));
    expect(events.filter((event) => event.type === "output")).toHaveLength(0);
    child.stdout.emit("data", Buffer.from("secret-value after\n"));
    child.stderr.emit("data", Buffer.from("warning\n"));
    const liveOutput = events.filter((event) => event.type === "output");
    expect(liveOutput).toEqual([
      expect.objectContaining({ stream: "stdout", text: "before [REDACTED] after\n" }),
      expect.objectContaining({ stream: "stderr", text: "warning\n" }),
    ]);
    expect(JSON.stringify(liveOutput)).not.toContain("split-secret-value");

    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    await expect(pending).resolves.toContain("before [REDACTED] after\nwarning");
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps agent sessions renderer-owned and read-only", async () => {
    const child = childProcess();
    const manager = new TerminalSessionManager({
      spawnImpl: () => child,
      platform: "linux",
      defaultCwd: "/home/user",
      createId: () => "private-agent",
    });
    const pending = manager.runAgentCommand({
      rendererId: 1,
      ownerId: "chat",
      actorId: "main",
      toolCallId: "tool-private",
      command: "pwd",
      cwd: "/work",
      timeoutMs: 60_000,
    });
    expect(manager.list(2, "chat")).toEqual([]);
    expect(() => manager.write(1, "private-agent", "whoami\n")).toThrow("terminal_read_only");
    expect(() => manager.rename(2, "private-agent", "stolen")).toThrow("terminal_session_not_found");
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    await pending;
  });

  it("closes a running agent tab by aborting the same process", async () => {
    const child = childProcess();
    const manager = new TerminalSessionManager({
      spawnImpl: () => child,
      platform: "linux",
      defaultCwd: "/home/user",
      createId: () => "closing-agent",
    });
    const pending = manager.runAgentCommand({
      rendererId: 1,
      ownerId: "chat",
      actorId: "main",
      toolCallId: "tool-close",
      command: "npm test",
      cwd: "/work",
      timeoutMs: 60_000,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const closing = manager.close(1, "closing-agent");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("exit", null, "SIGTERM");
    child.emit("close", null, "SIGTERM");
    await rejected;
    await expect(closing).resolves.toBe(true);
    expect(manager.list(1, "chat")).toEqual([]);
  });

  it("never kills a live agent command on wall-clock timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = childProcess();
      const manager = new TerminalSessionManager({
        spawnImpl: () => child,
        platform: "linux",
        defaultCwd: "/home/user",
        createId: () => "timed-agent",
      });
      const pending = manager.runAgentCommand({
        rendererId: 1,
        ownerId: "chat",
        actorId: "main",
        toolCallId: "tool-timeout",
        command: "sleep forever",
        cwd: "/work",
        timeoutMs: 10,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(child.kill).not.toHaveBeenCalled();
      expect(manager.list(1, "chat")[0]).toMatchObject({ status: "running" });
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
      await expect(pending).resolves.toContain("(exit code: 0)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses free finished tabs and keeps only one free tab per actor after waves", async () => {
    let nextId = 0;
    const queue: ReturnType<typeof childProcess>[] = [];
    const manager = new TerminalSessionManager({
      spawnImpl: () => queue.shift() ?? childProcess(),
      platform: "linux",
      defaultCwd: "/home/user",
      createId: () => `wave-${++nextId}`,
    });

    const children = [childProcess(), childProcess(), childProcess()];
    queue.push(...children);
    const pending = children.map((child, index) => manager.runAgentCommand({
      rendererId: 1,
      ownerId: "chat",
      actorId: "main",
      toolCallId: `wave-${index}`,
      command: `cmd-${index}`,
      cwd: "/work",
      timeoutMs: 60_000,
    }));
    expect(manager.list(1, "chat")).toHaveLength(3);
    for (const child of children) {
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    }
    await Promise.all(pending);
    // Compact keeps a single free tab for the next sequential command.
    expect(manager.list(1, "chat")).toHaveLength(1);
    expect(manager.list(1, "chat")[0]).toMatchObject({ kind: "agent", actorId: "main", status: "exited" });

    const nextChild = childProcess();
    queue.push(nextChild);
    const next = manager.runAgentCommand({
      rendererId: 1,
      ownerId: "chat",
      actorId: "main",
      toolCallId: "reuse-free",
      command: "next",
      cwd: "/work",
      timeoutMs: 60_000,
    });
    expect(manager.list(1, "chat")).toHaveLength(1);
    expect(manager.list(1, "chat")[0].status).toBe("running");
    nextChild.emit("exit", 0, null);
    nextChild.emit("close", 0, null);
    await next;
  });

  it("uses the same process lifecycle for an AbortSignal", async () => {
    const child = childProcess();
    const controller = new AbortController();
    const manager = new TerminalSessionManager({
      spawnImpl: () => child,
      platform: "linux",
      defaultCwd: "/home/user",
      createId: () => "aborted-agent",
    });
    const pending = manager.runAgentCommand({
      rendererId: 1,
      ownerId: "chat",
      actorId: "main",
      toolCallId: "tool-abort",
      command: "npm test",
      cwd: "/work",
      timeoutMs: 60_000,
      abortSignal: controller.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("exit", null, "SIGTERM");
    child.emit("close", null, "SIGTERM");
    await rejected;
    expect(manager.list(1, "chat")[0]).toMatchObject({ kind: "agent", status: "failed" });
  });

  it("waits for process termination before removing a terminal tab", async () => {
    const child = childProcess();
    const manager = new TerminalSessionManager({
      spawnImpl: () => child,
      platform: "linux",
      defaultCwd: "/home/user",
      createId: () => "closing-terminal",
    });
    manager.create({ rendererId: 1, ownerId: "chat", title: "Close me" });
    const closing = manager.close(1, "closing-terminal");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(manager.list(1, "chat")).toHaveLength(1);
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    await closing;
    expect(manager.list(1, "chat")).toEqual([]);
  });

  it("coalesces duplicate close requests and emits one closed event", async () => {
    const child = childProcess();
    const events: Array<{ type?: string }> = [];
    const manager = new TerminalSessionManager({
      spawnImpl: () => child,
      platform: "linux",
      defaultCwd: "/home/user",
      createId: () => "closing-once",
    });
    manager.onEvent((event: { type?: string }) => events.push(event));
    manager.create({ rendererId: 1, ownerId: "chat", title: "Close once" });

    const first = manager.close(1, "closing-once");
    const second = manager.close(1, "closing-once");
    expect(first).toBe(second);
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    await Promise.all([first, second]);
    expect(events.filter((event) => event.type === "closed")).toHaveLength(1);
  });

  it("treats an already closed spawn failure as terminated", async () => {
    const child = childProcess();
    const manager = new TerminalSessionManager({
      spawnImpl: () => child,
      platform: "linux",
      defaultCwd: "/home/user",
      createId: () => "spawn-failure",
    });
    manager.create({ rendererId: 1, ownerId: "chat", title: "Failed" });
    child.emit("error", new Error("spawn ENOENT"));
    child.emit("close", -2, null);

    await expect(manager.close(1, "spawn-failure")).resolves.toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("keeps draining stdout between process exit and stream close", () => {
    const child = childProcess();
    const manager = new TerminalSessionManager({
      spawnImpl: () => child,
      platform: "linux",
      defaultCwd: "/home/user",
      createId: () => "draining-terminal",
    });
    manager.create({ rendererId: 1, ownerId: "chat", title: "Drain" });
    child.emit("exit", 0, null);
    child.stdout.emit("data", Buffer.from("last line\n"));
    child.emit("close", 0, null);

    expect(manager.list(1, "chat")[0]).toMatchObject({
      status: "exited",
      output: [{ stream: "stdout", text: "last line\n" }],
    });
  });

  it("bounds process fan-out per owner and renderer", () => {
    let nextId = 0;
    const manager = new TerminalSessionManager({
      spawnImpl: () => childProcess(),
      platform: "linux",
      defaultCwd: "/home/user",
      createId: () => `terminal-${++nextId}`,
    });
    for (let index = 0; index < MAX_TERMINALS_PER_OWNER; index += 1) {
      manager.create({ rendererId: 1, ownerId: "chat-a", title: `A ${index}` });
    }
    expect(() => manager.create({ rendererId: 1, ownerId: "chat-a", title: "Too many" }))
      .toThrow("terminal_owner_limit");

    for (let index = MAX_TERMINALS_PER_OWNER; index < MAX_TERMINALS_PER_RENDERER; index += 1) {
      manager.create({ rendererId: 1, ownerId: "chat-b", title: `B ${index}` });
    }
    expect(() => manager.create({ rendererId: 1, ownerId: "chat-c", title: "Renderer full" }))
      .toThrow("terminal_renderer_limit");
  });

  it("reclaims finished agent tabs so a manual terminal can still be opened", async () => {
    let nextId = 0;
    const queue: ReturnType<typeof childProcess>[] = [];
    const manager = new TerminalSessionManager({
      spawnImpl: () => queue.shift() ?? childProcess(),
      platform: "linux",
      defaultCwd: "/home/user",
      createId: () => `slot-${++nextId}`,
    });

    for (let index = 0; index < MAX_TERMINALS_PER_OWNER; index += 1) {
      const child = childProcess();
      queue.push(child);
      const pending = manager.runAgentCommand({
        rendererId: 1,
        ownerId: "chat",
        actorId: `actor-${index}`,
        toolCallId: `tool-${index}`,
        command: `cmd-${index}`,
        cwd: "/work",
        timeoutMs: 60_000,
      });
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
      await pending;
    }
    expect(manager.list(1, "chat")).toHaveLength(MAX_TERMINALS_PER_OWNER);

    const manual = manager.create({ rendererId: 1, ownerId: "chat", title: "Manual" });
    expect(manual.kind).toBe("manual");
    expect(manager.list(1, "chat").length).toBeLessThanOrEqual(MAX_TERMINALS_PER_OWNER);
    expect(manager.list(1, "chat").some((session) => session.kind === "manual")).toBe(true);
  });

  it("isolates a failing event listener from process output collection", () => {
    const child = childProcess();
    const healthy = vi.fn();
    const manager = new TerminalSessionManager({
      spawnImpl: () => child,
      platform: "linux",
      defaultCwd: "/home/user",
      createId: () => "listener-isolation",
    });
    manager.onEvent(() => { throw new Error("renderer gone"); });
    manager.onEvent(healthy);
    manager.create({ rendererId: 1, ownerId: "chat", title: "Listeners" });
    child.stdout.emit("data", Buffer.from("still captured\n"));
    expect(manager.list(1, "chat")[0].output[0].text).toBe("still captured\n");
    expect(healthy).toHaveBeenCalledWith(expect.objectContaining({ type: "output" }));
  });

  it("bounds retained output and strips credential-shaped environment variables", () => {
    const child = childProcess();
    const manager = new TerminalSessionManager({
      spawnImpl: () => child,
      platform: "linux",
      defaultCwd: "/home/user",
      createId: () => "bounded",
    });
    manager.create({ rendererId: 1, ownerId: "chat", title: "Bounded" });
    child.stdout.emit("data", Buffer.from("x".repeat(MAX_OUTPUT_CHARS + 100)));
    expect(manager.list(1, "chat")[0].output[0].text).toHaveLength(MAX_OUTPUT_CHARS);
    expect(sanitizeTerminalEnvironment({ PATH: "/bin", API_KEY: "one", password: "two", SAFE: "yes" }))
      .toEqual({ PATH: "/bin", SAFE: "yes", TERM: "dumb" });
    expect(sanitizeAgentEnvironment({ PATH: "/bin", SAFE: "yes", DATABASE_URL: "private", API_KEY: "one" }))
      .toEqual({ PATH: "/bin", TERM: "dumb" });
  });
});
