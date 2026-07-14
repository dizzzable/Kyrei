import { TerminalSessionManager } from "./terminal-session-manager.js";
import { validateWorkspacePath } from "./workspace-path.js";

export const DESKTOP_CHANNELS = Object.freeze({
  workspaceChoose: "kyrei:workspace:choose",
  workspaceValidate: "kyrei:workspace:validate",
  terminalList: "kyrei:terminal:list",
  terminalCreate: "kyrei:terminal:create",
  terminalWrite: "kyrei:terminal:write",
  terminalRename: "kyrei:terminal:rename",
  terminalClose: "kyrei:terminal:close",
  terminalEvent: "kyrei:terminal:event",
});

/**
 * Register the narrow desktop capability surface used by the sandboxed
 * renderer. Dependencies are injected so validation and renderer isolation can
 * be covered without booting Electron in unit tests.
 */
export function registerDesktopIpc({
  ipcMain,
  dialog,
  getWindow,
  defaultCwd,
  terminalManager = new TerminalSessionManager({ defaultCwd }),
} = {}) {
  if (!ipcMain?.handle || !ipcMain?.removeHandler) throw new Error("desktop_ipc_main_required");
  if (!dialog?.showOpenDialog) throw new Error("desktop_ipc_dialog_required");

  const senders = new Map();
  const channels = Object.values(DESKTOP_CHANNELS).filter((channel) => channel !== DESKTOP_CHANNELS.terminalEvent);

  const rememberSender = (sender) => {
    if (!sender || !Number.isSafeInteger(sender.id) || sender.id < 1) throw new Error("desktop_ipc_sender_invalid");
    if (senders.has(sender.id)) return sender.id;
    senders.set(sender.id, sender);
    if (typeof sender.once === "function") {
      sender.once("destroyed", () => {
        senders.delete(sender.id);
        void Promise.resolve(terminalManager.closeRenderer(sender.id)).catch(() => {});
      });
    }
    return sender.id;
  };

  const handle = (channel, callback) => {
    ipcMain.handle(channel, async (event, ...args) => {
      const rendererId = rememberSender(event?.sender);
      return callback({ event, rendererId }, ...args);
    });
  };

  handle(DESKTOP_CHANNELS.workspaceChoose, async ({ event }, locale) => {
    const copy = locale === "ru"
      ? { title: "Открыть рабочую папку", buttonLabel: "Открыть" }
      : { title: "Open workspace", buttonLabel: "Open" };
    const options = {
      ...copy,
      properties: ["openDirectory", "createDirectory"],
    };
    const owner = typeof getWindow === "function" ? getWindow(event.sender) : undefined;
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (result?.canceled || !Array.isArray(result?.filePaths) || !result.filePaths[0]) {
      return { canceled: true, path: "" };
    }
    return { canceled: false, path: await validateWorkspacePath(result.filePaths[0]) };
  });

  handle(DESKTOP_CHANNELS.workspaceValidate, async (_context, value) => ({
    path: await validateWorkspacePath(value),
  }));

  handle(DESKTOP_CHANNELS.terminalList, ({ rendererId }, ownerId) => (
    terminalManager.list(rendererId, ownerId)
  ));
  handle(DESKTOP_CHANNELS.terminalCreate, async ({ rendererId }, input = {}) => {
    const cwd = typeof input?.cwd === "string" && input.cwd
      ? await validateWorkspacePath(input.cwd)
      : defaultCwd;
    // This renderer capability always creates a manual tab. `kind`, actor
    // metadata, and command execution are internal-only and intentionally
    // ignored even if a compromised renderer includes them in the payload.
    return terminalManager.createManual({ rendererId, ownerId: input?.ownerId, title: input?.title, cwd });
  });
  handle(DESKTOP_CHANNELS.terminalWrite, ({ rendererId }, input = {}) => (
    terminalManager.write(rendererId, input?.sessionId, input?.data)
  ));
  handle(DESKTOP_CHANNELS.terminalRename, ({ rendererId }, input = {}) => (
    terminalManager.rename(rendererId, input?.sessionId, input?.title)
  ));
  handle(DESKTOP_CHANNELS.terminalClose, ({ rendererId }, sessionId) => (
    terminalManager.close(rendererId, sessionId)
  ));

  const disposeTerminalListener = terminalManager.onEvent((event) => {
    const sender = senders.get(event.rendererId);
    if (!sender || (typeof sender.isDestroyed === "function" && sender.isDestroyed())) return;
    const { rendererId: _rendererId, ...publicEvent } = event;
    try {
      sender.send(DESKTOP_CHANNELS.terminalEvent, publicEvent);
    } catch {
      // A renderer can disappear between isDestroyed() and send(). Drop its
      // route and fail closed by terminating every process it owned.
      senders.delete(event.rendererId);
      void Promise.resolve(terminalManager.closeRenderer(event.rendererId)).catch(() => {});
    }
  });

  return {
    terminalManager,
    async dispose() {
      disposeTerminalListener();
      for (const channel of channels) ipcMain.removeHandler(channel);
      senders.clear();
      await terminalManager.closeAll();
    },
  };
}
