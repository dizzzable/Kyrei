const { contextBridge, ipcRenderer } = require("electron");

// The renderer talks to the local gateway over HTTP/SSE directly; the bridge
// only exposes what needs the main process (opening external links).
contextBridge.exposeInMainWorld("kyrei", {
  openExternal: (url) => ipcRenderer.invoke("kyrei:open-external", url),
});
