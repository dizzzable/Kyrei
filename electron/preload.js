const { contextBridge, webUtils } = require("electron");

// The renderer talks to the local gateway over HTTP/SSE directly. The bridge
// exposes only the sandboxed OS file-path resolver used by native file picking.
contextBridge.exposeInMainWorld("kyrei", {
  // webUtils.getPathForFile replaces the removed File.path — the sandboxed way
  // to turn a <input type=file> / drop File into its absolute OS path.
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
});
