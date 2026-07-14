import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DESKTOP_CHANNELS, registerDesktopIpc } from "../electron/desktop-ipc.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeIpcMain {
  handlers = new Map<string, (...args: unknown[]) => unknown>();
  handle(channel: string, callback: (...args: unknown[]) => unknown) { this.handlers.set(channel, callback); }
  removeHandler(channel: string) { this.handlers.delete(channel); }
}

class FakeSender extends EventEmitter {
  id: number;
  send = vi.fn();
  constructor(id: number) {
    super();
    this.id = id;
  }
  isDestroyed() { return false; }
}

describe("desktop IPC", () => {
  it("validates picker and dropped workspace paths in the main process", async () => {
    const root = await mkdtemp(join(tmpdir(), "kyrei-desktop-ipc-"));
    roots.push(root);
    const workspace = join(root, "project");
    await mkdir(workspace);
    const canonicalWorkspace = await realpath(workspace);
    const ipcMain = new FakeIpcMain();
    const manager = {
      onEvent: () => () => {},
      closeAll: vi.fn(),
      closeRenderer: vi.fn(),
      list: vi.fn(),
      createManual: vi.fn(),
      runAgentCommand: vi.fn(),
      write: vi.fn(),
      rename: vi.fn(),
      close: vi.fn(),
    };
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: [workspace] }));
    const registration = registerDesktopIpc({
      ipcMain,
      dialog: { showOpenDialog },
      getWindow: () => undefined,
      defaultCwd: root,
      terminalManager: manager,
    });
    const sender = new FakeSender(10);
    const choose = ipcMain.handlers.get(DESKTOP_CHANNELS.workspaceChoose)!;
    const validate = ipcMain.handlers.get(DESKTOP_CHANNELS.workspaceValidate)!;

    await expect(choose({ sender }, "ru")).resolves.toMatchObject({ canceled: false, path: canonicalWorkspace });
    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: "Открыть рабочую папку",
      buttonLabel: "Открыть",
    }));
    await expect(validate({ sender }, "relative/path")).rejects.toThrow("workspace_path_invalid");
    await registration.dispose();
    expect(ipcMain.handlers.size).toBe(0);
  });

  it("pins terminal operations and events to the invoking renderer", async () => {
    const ipcMain = new FakeIpcMain();
    let emit: ((event: Record<string, unknown>) => void) | undefined;
    const manager = {
      onEvent: vi.fn((listener: (event: Record<string, unknown>) => void) => { emit = listener; return () => {}; }),
      closeAll: vi.fn(),
      closeRenderer: vi.fn(),
      list: vi.fn(() => []),
      createManual: vi.fn((input) => ({ id: "terminal", kind: "manual", ...input })),
      runAgentCommand: vi.fn(),
      write: vi.fn(() => true),
      rename: vi.fn(),
      close: vi.fn(),
    };
    const registration = registerDesktopIpc({
      ipcMain,
      dialog: { showOpenDialog: vi.fn() },
      defaultCwd: "C:\\Users\\example",
      terminalManager: manager,
    });
    const sender = new FakeSender(42);
    await ipcMain.handlers.get(DESKTOP_CHANNELS.terminalList)!({ sender }, "chat-a");
    expect(manager.list).toHaveBeenCalledWith(42, "chat-a");

    await ipcMain.handlers.get(DESKTOP_CHANNELS.terminalCreate)!({ sender }, {
      ownerId: "chat-a",
      title: "Manual",
      kind: "agent",
      actorId: "forged",
      toolCallId: "forged-call",
      command: "whoami",
    });
    expect(manager.createManual).toHaveBeenCalledWith({
      rendererId: 42,
      ownerId: "chat-a",
      title: "Manual",
      cwd: "C:\\Users\\example",
    });
    expect(manager.runAgentCommand).not.toHaveBeenCalled();
    expect(Object.values(DESKTOP_CHANNELS)).not.toContain("kyrei:terminal:run-agent-command");

    emit?.({ rendererId: 42, type: "output", sessionId: "terminal", stream: "stdout", text: "ok" });
    expect(sender.send).toHaveBeenCalledWith(
      DESKTOP_CHANNELS.terminalEvent,
      { type: "output", sessionId: "terminal", stream: "stdout", text: "ok" },
    );

    sender.send.mockImplementationOnce(() => { throw new Error("renderer destroyed"); });
    emit?.({ rendererId: 42, type: "output", sessionId: "terminal", stream: "stderr", text: "late" });
    expect(manager.closeRenderer).toHaveBeenCalledWith(42);
    await registration.dispose();
  });
});
