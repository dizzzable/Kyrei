/**
 * Desktop windows must always render at their native content size. Chromium
 * device emulation is useful for browser QA, but a leaked CDP override leaves
 * the renderer at the emulated size and exposes black compositor space around
 * it. Clear that state at the native Electron boundary whenever the window is
 * loaded or its real geometry becomes authoritative again.
 */
export function installDesktopViewportGuard(window) {
  const webContents = window.webContents;
  const reset = () => {
    try {
      if (window.isDestroyed() || webContents.isDestroyed()) return;
      webContents.disableDeviceEmulation();
    } catch {
      // A close can race a native focus/resize notification. The window is
      // already going away, so there is no viewport left to repair.
    }
  };

  webContents.on("did-finish-load", reset);
  window.on("focus", reset);
  window.on("resize", reset);

  return () => {
    webContents.removeListener("did-finish-load", reset);
    window.removeListener("focus", reset);
    window.removeListener("resize", reset);
  };
}
