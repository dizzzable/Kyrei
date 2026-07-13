import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installDesktopViewportGuard } from "../electron/desktop-viewport-guard.js";

class FakeWebContents extends EventEmitter {
  isDestroyed = vi.fn(() => false);
  disableDeviceEmulation = vi.fn();
}

class FakeWindow extends EventEmitter {
  isDestroyed = vi.fn(() => false);
  webContents = new FakeWebContents();
}

describe("desktop viewport guard", () => {
  it("clears device emulation after load, focus, and native resize", () => {
    const window = new FakeWindow();
    const dispose = installDesktopViewportGuard(window);

    window.webContents.emit("did-finish-load");
    window.emit("focus");
    window.emit("resize");

    expect(window.webContents.disableDeviceEmulation).toHaveBeenCalledTimes(3);
    dispose();
    window.emit("focus");
    expect(window.webContents.disableDeviceEmulation).toHaveBeenCalledTimes(3);
  });

  it("does nothing once either Electron object is destroyed", () => {
    const window = new FakeWindow();
    installDesktopViewportGuard(window);
    window.isDestroyed.mockReturnValue(true);
    window.emit("focus");
    window.isDestroyed.mockReturnValue(false);
    window.webContents.isDestroyed.mockReturnValue(true);
    window.emit("resize");

    expect(window.webContents.disableDeviceEmulation).not.toHaveBeenCalled();
  });
});
