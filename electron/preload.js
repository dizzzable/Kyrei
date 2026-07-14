const { contextBridge, ipcRenderer, webUtils } = require("electron");

const desktopPlatform = (() => {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  return "unknown";
})();

const CHANNELS = Object.freeze({
  workspaceChoose: "kyrei:workspace:choose",
  workspaceValidate: "kyrei:workspace:validate",
  terminalList: "kyrei:terminal:list",
  terminalCreate: "kyrei:terminal:create",
  terminalWrite: "kyrei:terminal:write",
  terminalRename: "kyrei:terminal:rename",
  terminalClose: "kyrei:terminal:close",
  terminalEvent: "kyrei:terminal:event",
});
let nextTerminalSubscription = 1;
const terminalSubscriptions = new Map();
const MAX_TERMINAL_SUBSCRIPTIONS = 64;

const dispatchTerminalEvent = (_event, value) => {
  for (const callback of terminalSubscriptions.values()) {
    try {
      callback(value);
    } catch {
      // One renderer component must not starve other terminal subscribers.
    }
  }
};

// The renderer talks to the local gateway over HTTP/SSE directly. The bridge
// exposes only the sandboxed OS file-path resolver used by native file picking.
contextBridge.exposeInMainWorld("kyrei", {
  platform: desktopPlatform,
  // webUtils.getPathForFile replaces the removed File.path — the sandboxed way
  // to turn a <input type=file> / drop File into its absolute OS path.
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  workspace: {
    choose: (locale) => ipcRenderer.invoke(CHANNELS.workspaceChoose, locale),
    validatePath: (path) => ipcRenderer.invoke(CHANNELS.workspaceValidate, path),
  },
  terminal: {
    list: (ownerId) => ipcRenderer.invoke(CHANNELS.terminalList, ownerId),
    create: (input) => ipcRenderer.invoke(CHANNELS.terminalCreate, input),
    write: (sessionId, data) => ipcRenderer.invoke(CHANNELS.terminalWrite, { sessionId, data }),
    rename: (sessionId, title) => ipcRenderer.invoke(CHANNELS.terminalRename, { sessionId, title }),
    close: (sessionId) => ipcRenderer.invoke(CHANNELS.terminalClose, sessionId),
    subscribe: (callback) => {
      if (typeof callback !== "function" || terminalSubscriptions.size >= MAX_TERMINAL_SUBSCRIPTIONS) return "";
      const id = `terminal-${nextTerminalSubscription++}`;
      if (terminalSubscriptions.size === 0) {
        ipcRenderer.on(CHANNELS.terminalEvent, dispatchTerminalEvent);
      }
      terminalSubscriptions.set(id, callback);
      return id;
    },
    unsubscribe: (id) => {
      if (!terminalSubscriptions.has(id)) return false;
      terminalSubscriptions.delete(id);
      if (terminalSubscriptions.size === 0) {
        ipcRenderer.removeListener(CHANNELS.terminalEvent, dispatchTerminalEvent);
      }
      return true;
    },
  },
});
