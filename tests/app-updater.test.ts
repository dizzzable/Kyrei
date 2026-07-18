import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createAppUpdater } from "../electron/app-updater.js";

function makeAutoUpdater() {
  const emitter = new EventEmitter();
  return {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: true,
    channel: "latest",
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
  };
}

describe("createAppUpdater", () => {
  it("disables auto-install for unpackaged and portable builds", () => {
    const autoUpdater = makeAutoUpdater();
    const dev = createAppUpdater({
      app: { getVersion: () => "0.4.2", isPackaged: false },
      autoUpdater,
      env: {},
    });
    expect(dev.getStatus()).toMatchObject({
      canAutoInstall: false,
      reason: "not_packaged",
      phase: "disabled",
    });

    const portable = createAppUpdater({
      app: { getVersion: () => "0.4.2", isPackaged: true },
      autoUpdater: makeAutoUpdater(),
      env: { PORTABLE_EXECUTABLE_DIR: "C:\\KyreiPortable" },
    });
    expect(portable.getStatus()).toMatchObject({
      canAutoInstall: false,
      reason: "portable",
      phase: "disabled",
    });
  });

  it("never auto-downloads and reports available → downloaded → install", async () => {
    const autoUpdater = makeAutoUpdater();
    const statuses: string[] = [];
    const updater = createAppUpdater({
      app: { getVersion: () => "0.4.2", isPackaged: true },
      autoUpdater,
      env: {},
      onStatus: (status) => statuses.push(status.phase),
    });

    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    expect(autoUpdater.disableDifferentialDownload).toBe(true);

    autoUpdater.checkForUpdates.mockImplementation(async () => {
      autoUpdater.emit("update-available", { version: "0.4.3", releaseName: "Kyrei v0.4.3" });
      return { updateInfo: { version: "0.4.3" } };
    });

    const available = await updater.check();
    expect(available).toMatchObject({
      phase: "available",
      latestVersion: "0.4.3",
      canAutoInstall: true,
    });

    autoUpdater.downloadUpdate.mockImplementation(async () => {
      autoUpdater.emit("download-progress", { percent: 40, transferred: 40, total: 100 });
      autoUpdater.emit("update-downloaded", { version: "0.4.3" });
    });

    const downloaded = await updater.download();
    expect(downloaded.phase).toBe("downloaded");
    expect(downloaded.percent).toBe(100);

    expect(updater.install()).toEqual({ ok: true });
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(statuses).toContain("available");
    expect(statuses).toContain("downloading");
    expect(statuses).toContain("downloaded");
  });

  it("rejects download/install when not ready", async () => {
    const updater = createAppUpdater({
      app: { getVersion: () => "0.4.2", isPackaged: true },
      autoUpdater: makeAutoUpdater(),
      env: {},
    });
    await expect(updater.download()).rejects.toThrow("update_not_available_to_download");
    expect(() => updater.install()).toThrow("update_not_downloaded");
  });

  it("surfaces provider errors", async () => {
    const autoUpdater = makeAutoUpdater();
    autoUpdater.checkForUpdates.mockRejectedValue(new Error("network down"));
    const updater = createAppUpdater({
      app: { getVersion: () => "0.4.2", isPackaged: true },
      autoUpdater,
      env: {},
    });
    const status = await updater.check();
    expect(status).toMatchObject({ phase: "error", error: "network down" });
  });

  it("runs the startup check once without downloading", async () => {
    const autoUpdater = makeAutoUpdater();
    const updater = createAppUpdater({
      app: { getVersion: () => "0.4.7", isPackaged: true },
      autoUpdater,
      env: {},
    });

    autoUpdater.checkForUpdates.mockImplementation(async () => {
      autoUpdater.emit("update-available", { version: "0.5.0" });
      return { updateInfo: { version: "0.5.0" } };
    });

    const [first, second] = await Promise.all([updater.start(), updater.start()]);

    expect(first).toMatchObject({ phase: "available", latestVersion: "0.5.0" });
    expect(second).toMatchObject({ phase: "available", latestVersion: "0.5.0" });
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });
});
