/**
 * In-app updates via electron-updater (GitHub Releases).
 *
 * Policy:
 * - No silent download or install: user must Check → Download → Restart & install.
 * - Disabled for unpackaged/dev and Windows Portable builds.
 * - Falls back to capability flags so the UI can open the release page instead.
 */

/**
 * @typedef {"idle"|"checking"|"available"|"not-available"|"downloading"|"downloaded"|"error"|"disabled"} UpdatePhase
 * @typedef {{
 *   phase: UpdatePhase,
 *   currentVersion: string,
 *   latestVersion?: string,
 *   releaseName?: string,
 *   percent?: number,
 *   transferred?: number,
 *   total?: number,
 *   error?: string,
 *   canAutoInstall: boolean,
 *   reason?: string,
 *   packaged: boolean,
 *   portable: boolean,
 *   platform: string,
 * }} AppUpdateStatus
 */

function comparableVersion(value) {
  const match = String(value ?? "").trim().replace(/^v/i, "")
    .match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** electron-updater should filter older releases, but stale GitHub metadata or
 * a custom feed must never turn a downgrade into an update affordance. */
export function isNewerAppVersion(candidate, current) {
  const next = comparableVersion(candidate);
  const installed = comparableVersion(current);
  if (!next || !installed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== installed[index]) return next[index] > installed[index];
  }
  return false;
}

/**
 * @param {{
 *   app: { getVersion: () => string, isPackaged: boolean },
 *   autoUpdater: import("electron-updater").AppUpdater,
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   onStatus?: (status: AppUpdateStatus) => void,
 * }} options
 */
export function createAppUpdater({
  app,
  autoUpdater,
  env = process.env,
  platform = process.platform,
  onStatus,
} = {}) {
  if (!app?.getVersion) throw new Error("app_updater_app_required");
  if (!autoUpdater) throw new Error("app_updater_auto_updater_required");

  const portable = Boolean(env.PORTABLE_EXECUTABLE_DIR || env.PORTABLE_EXECUTABLE_FILE);
  const packaged = app.isPackaged === true;
  /** NSIS / mac zip / AppImage can auto-update; portable/dev cannot. */
  const canAutoInstall = packaged && !portable;
  const disableReason = !packaged
    ? "not_packaged"
    : portable
      ? "portable"
      : undefined;

  /** @type {AppUpdateStatus} */
  let status = {
    phase: canAutoInstall ? "idle" : "disabled",
    currentVersion: String(app.getVersion() || "0.0.0"),
    canAutoInstall,
    ...(disableReason ? { reason: disableReason } : {}),
    packaged,
    portable,
    platform,
  };
  /** @type {Promise<AppUpdateStatus> | null} */
  let startupCheckPromise = null;

  const emit = () => {
    if (typeof onStatus === "function") {
      try {
        onStatus(getStatus());
      } catch {
        /* ignore subscriber errors */
      }
    }
  };

  const setStatus = (patch) => {
    status = { ...status, ...patch };
    emit();
    return getStatus();
  };

  const getStatus = () => ({ ...status });

  autoUpdater.autoDownload = false;
  // A downloaded build must not replace the current application merely because
  // the user closed a window. Installation is only performed by `install()`.
  autoUpdater.autoInstallOnAppQuit = false;
  // Always replace the complete packaged bundle. This keeps the embedded
  // engine/native modules and renderer dependency graph in lockstep after a
  // release instead of relying on an old installer blockmap.
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.allowPrerelease = false;
  // Public GitHub releases for this app; do not require GH_TOKEN for checks.
  if (typeof autoUpdater.setFeedURL === "function" || autoUpdater.channel !== undefined) {
    try {
      autoUpdater.channel = "latest";
    } catch {
      /* ignore */
    }
  }

  const wire = (event, handler) => {
    if (typeof autoUpdater.on === "function") autoUpdater.on(event, handler);
  };

  wire("checking-for-update", () => {
    setStatus({ phase: "checking", error: undefined });
  });

  wire("update-available", (info) => {
    const latestVersion = String(info?.version ?? "").replace(/^v/i, "") || undefined;
    if (!latestVersion || !isNewerAppVersion(latestVersion, status.currentVersion)) {
      setStatus({
        phase: "not-available",
        latestVersion: latestVersion ?? status.currentVersion,
        releaseName: undefined,
        error: undefined,
        percent: undefined,
      });
      return;
    }
    setStatus({
      phase: "available",
      latestVersion,
      releaseName: typeof info?.releaseName === "string" ? info.releaseName : undefined,
      error: undefined,
      percent: undefined,
    });
  });

  wire("update-not-available", (info) => {
    const latestVersion = String(info?.version ?? status.currentVersion).replace(/^v/i, "");
    setStatus({
      phase: "not-available",
      latestVersion,
      error: undefined,
      percent: undefined,
    });
  });

  wire("download-progress", (progress) => {
    setStatus({
      phase: "downloading",
      percent: typeof progress?.percent === "number" ? progress.percent : undefined,
      transferred: typeof progress?.transferred === "number" ? progress.transferred : undefined,
      total: typeof progress?.total === "number" ? progress.total : undefined,
      error: undefined,
    });
  });

  wire("update-downloaded", (info) => {
    const latestVersion = String(info?.version ?? status.latestVersion ?? "").replace(/^v/i, "") || status.latestVersion;
    if (!latestVersion || !isNewerAppVersion(latestVersion, status.currentVersion)) {
      setStatus({
        phase: "not-available",
        latestVersion: latestVersion ?? status.currentVersion,
        error: undefined,
        percent: undefined,
      });
      return;
    }
    setStatus({
      phase: "downloaded",
      latestVersion,
      percent: 100,
      error: undefined,
    });
  });

  wire("error", (error) => {
    const message = error?.message ? String(error.message) : "update_error";
    setStatus({
      phase: "error",
      error: message.slice(0, 400),
    });
  });

  async function check() {
    if (!canAutoInstall) {
      return setStatus({
        phase: "disabled",
        reason: disableReason,
        error: undefined,
      });
    }
    setStatus({ phase: "checking", error: undefined });
    try {
      // Returns UpdateCheckResult | null; events also update status.
      const result = await autoUpdater.checkForUpdates();
      // If the provider already emitted available/not-available, keep that phase.
      if (status.phase === "checking") {
        const version = result?.updateInfo?.version
          ? String(result.updateInfo.version).replace(/^v/i, "")
          : status.currentVersion;
        setStatus({
          phase: isNewerAppVersion(version, status.currentVersion) ? "available" : "not-available",
          latestVersion: version,
        });
      }
      return getStatus();
    } catch (error) {
      return setStatus({
        phase: "error",
        error: error?.message ? String(error.message).slice(0, 400) : "check_failed",
      });
    }
  }

  async function download() {
    if (!canAutoInstall) {
      throw new Error("update_auto_install_unavailable");
    }
    if (status.phase === "downloaded") return getStatus();
    if (status.phase !== "available" && status.phase !== "downloading") {
      // Retry after a failed download is OK if we still know the target version.
      if (!(status.phase === "error" && status.latestVersion)) {
        throw new Error("update_not_available_to_download");
      }
    }
    setStatus({ phase: "downloading", percent: status.percent ?? 0, error: undefined });
    try {
      await autoUpdater.downloadUpdate();
      // download-progress / update-downloaded events usually set the phase.
      if (status.phase === "downloading") {
        setStatus({ phase: "downloaded", percent: 100 });
      }
      return getStatus();
    } catch (error) {
      setStatus({
        phase: "error",
        error: error?.message ? String(error.message).slice(0, 400) : "download_failed",
      });
      throw error;
    }
  }

  /** Run the app-start check exactly once; manual checks remain available. */
  function start() {
    if (!startupCheckPromise) startupCheckPromise = check();
    return startupCheckPromise;
  }

  function install() {
    if (!canAutoInstall) throw new Error("update_auto_install_unavailable");
    if (status.phase !== "downloaded") throw new Error("update_not_downloaded");
    // isSilent=false, isForceRunAfter=true — restart into the new version.
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  }

  return {
    getStatus,
    start,
    check,
    download,
    install,
    canAutoInstall,
    /** @internal test helper */
    _setStatusForTests: setStatus,
  };
}
