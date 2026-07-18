import { TerminalSessionManager } from "./terminal-session-manager.js";
import { openDesktopExternalUrl } from "./open-external-url.js";
import { validateWorkspacePath } from "./workspace-path.js";

export const DESKTOP_CHANNELS = Object.freeze({
  workspaceChoose: "kyrei:workspace:choose",
  workspaceValidate: "kyrei:workspace:validate",
  openExternal: "kyrei:shell:openExternal",
  windowTheme: "kyrei:window:theme",
  updateGetStatus: "kyrei:update:getStatus",
  updateCheck: "kyrei:update:check",
  updateDownload: "kyrei:update:download",
  updateInstall: "kyrei:update:install",
  updateEvent: "kyrei:update:event",
  terminalList: "kyrei:terminal:list",
  terminalCreate: "kyrei:terminal:create",
  terminalWrite: "kyrei:terminal:write",
  terminalRename: "kyrei:terminal:rename",
  terminalClose: "kyrei:terminal:close",
  terminalEvent: "kyrei:terminal:event",
});

const PUSH_CHANNELS = new Set([
  DESKTOP_CHANNELS.terminalEvent,
  DESKTOP_CHANNELS.updateEvent,
]);

function isOverlayColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

/**
 * Register the narrow desktop capability surface used by the sandboxed
 * renderer. Dependencies are injected so validation and renderer isolation can
 * be covered without booting Electron in unit tests.
 */
export function registerDesktopIpc({
  ipcMain,
  dialog,
  shell,
  getWindow,
  defaultCwd,
  terminalManager = new TerminalSessionManager({ defaultCwd }),
  appUpdater = null,
} = {}) {
  if (!ipcMain?.handle || !ipcMain?.removeHandler) throw new Error("desktop_ipc_main_required");
  if (!dialog?.showOpenDialog) throw new Error("desktop_ipc_dialog_required");

  const senders = new Map();
  const channels = Object.values(DESKTOP_CHANNELS).filter((channel) => !PUSH_CHANNELS.has(channel));

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

  const broadcastUpdate = (status) => {
    for (const [id, sender] of senders) {
      if (!sender || (typeof sender.isDestroyed === "function" && sender.isDestroyed())) {
        senders.delete(id);
        continue;
      }
      try {
        sender.send(DESKTOP_CHANNELS.updateEvent, status);
      } catch {
        senders.delete(id);
      }
    }
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

  handle(DESKTOP_CHANNELS.openExternal, async (_context, url, options) => {
    const sessionVerificationUri = options
      && typeof options === "object"
      && typeof options.sessionVerificationUri === "string"
      ? options.sessionVerificationUri
      : undefined;
    const codexAuthUri = options
      && typeof options === "object"
      && typeof options.codexAuthUri === "string"
      ? options.codexAuthUri
      : undefined;
    await openDesktopExternalUrl(shell, url, {
      ...(sessionVerificationUri ? { sessionVerificationUri } : {}),
      ...(codexAuthUri ? { codexAuthUri } : {}),
    });
    return { ok: true };
  });

  handle(DESKTOP_CHANNELS.windowTheme, ({ event }, input = {}) => {
    const color = input?.color;
    const symbolColor = input?.symbolColor;
    if (!isOverlayColor(color) || !isOverlayColor(symbolColor)) {
      throw new Error("window_theme_color_invalid");
    }
    const owner = typeof getWindow === "function" ? getWindow(event.sender) : undefined;
    if (!owner || (typeof owner.isDestroyed === "function" && owner.isDestroyed())) return false;
    // Only Windows/Linux title-bar overlays support this. macOS owns its
    // traffic-light controls; a no-op there keeps the renderer portable.
    if (typeof owner.setTitleBarOverlay !== "function") return false;
    owner.setTitleBarOverlay({ color, symbolColor, height: 34 });
    if (typeof owner.setBackgroundColor === "function") owner.setBackgroundColor(color);
    return true;
  });

  const disabledStatus = () => ({
    phase: "disabled",
    currentVersion: "0.0.0",
    canAutoInstall: false,
    reason: "updater_unavailable",
    packaged: false,
    portable: false,
    platform: process.platform,
  });

  handle(DESKTOP_CHANNELS.updateGetStatus, () => (
    appUpdater && typeof appUpdater.getStatus === "function"
      ? appUpdater.getStatus()
      : disabledStatus()
  ));

  handle(DESKTOP_CHANNELS.updateCheck, async () => {
    if (!appUpdater || typeof appUpdater.check !== "function") return disabledStatus();
    const status = await appUpdater.check();
    broadcastUpdate(status);
    return status;
  });

  handle(DESKTOP_CHANNELS.updateDownload, async () => {
    if (!appUpdater || typeof appUpdater.download !== "function") {
      throw new Error("update_auto_install_unavailable");
    }
    const status = await appUpdater.download();
    broadcastUpdate(status);
    return status;
  });

  handle(DESKTOP_CHANNELS.updateInstall, () => {
    if (!appUpdater || typeof appUpdater.install !== "function") {
      throw new Error("update_auto_install_unavailable");
    }
    return appUpdater.install();
  });

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
    broadcastUpdate,
    async dispose() {
      disposeTerminalListener();
      for (const channel of channels) ipcMain.removeHandler(channel);
      senders.clear();
      await terminalManager.closeAll();
    },
  };
}
