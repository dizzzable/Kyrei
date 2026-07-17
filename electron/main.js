import { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, shell } from "electron";
import electronUpdater from "electron-updater";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startGateway } from "../core/gateway.js";
import { createAppUpdater } from "./app-updater.js";
import { registerDesktopIpc } from "./desktop-ipc.js";
import { installDesktopViewportGuard } from "./desktop-viewport-guard.js";
import { TerminalSessionManager } from "./terminal-session-manager.js";
import { formatLinuxSecretsUnavailableMessage } from "./linux-secrets-env.js";
import {
  createWindowsDpapiSecretsCodec,
  createWindowsProtectedSecretsCodec,
} from "./windows-dpapi-secrets.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const appIcon = join(here, "..", "assets", "icon.png");

let windowRef;
let gateway; // { port, token, close }
let desktopCapabilities; // { terminalManager, dispose }
let shutdownStarted = false;
let shutdownComplete = false;

const ownsSingleInstance = app.requestSingleInstanceLock();
if (!ownsSingleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!windowRef) return;
    if (windowRef.isMinimized()) windowRef.restore();
    windowRef.show();
    windowRef.focus();
  });
}

async function chooseFolder() {
  const result = await dialog.showOpenDialog(windowRef, {
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? "" : result.filePaths[0] ?? "";
}

async function openPath(path) {
  const error = await shell.openPath(path);
  if (error) throw new Error(error);
}

function warnLinuxSecretsUnavailable(backend) {
  try {
    console.warn(formatLinuxSecretsUnavailableMessage({
      backend: typeof backend === "string" ? backend : undefined,
      env: process.env,
    }));
  } catch {
    console.warn("[kyrei] Linux protected credential storage is unavailable.");
  }
}

async function createSecretsCodec() {
  let selectedBackend;
  try {
    selectedBackend = safeStorage.getSelectedStorageBackend?.();
  } catch {
    selectedBackend = undefined;
  }
  // Electron's basic_text backend is not OS-protected storage. Refuse it so
  // provider keys never land on disk as pseudo-encrypted plaintext.
  if (process.platform === "linux" && selectedBackend === "basic_text") {
    warnLinuxSecretsUnavailable(selectedBackend);
    return undefined;
  }
  let safeStorageCodec;
  if (await safeStorage.isAsyncEncryptionAvailable()) {
    const codec = {
      encode: async (value) => (await safeStorage.encryptStringAsync(value)).toString("base64"),
      decode: async (value) => (await safeStorage.decryptStringAsync(Buffer.from(value, "base64"))).result,
    };
    try {
      const probe = "kyrei-safe-storage-probe";
      if (await codec.decode(await codec.encode(probe)) === probe) safeStorageCodec = codec;
    } catch {
      // On Windows the CurrentUser DPAPI fallback below preserves encrypted
      // storage even if Electron's wrapper is temporarily unavailable.
    }
  }
  if (!safeStorageCodec && safeStorage.isEncryptionAvailable()) {
    const codec = {
      encode: (value) => safeStorage.encryptString(value).toString("base64"),
      decode: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
    };
    try {
      const probe = "kyrei-safe-storage-probe";
      if (await codec.decode(await codec.encode(probe)) === probe) safeStorageCodec = codec;
    } catch {
      // Fall through to Windows DPAPI when Electron's probe fails.
    }
  }
  if (process.platform === "win32") {
    let dpapiCodec;
    try {
      dpapiCodec = await createWindowsDpapiSecretsCodec();
    } catch (error) {
      console.warn("[kyrei] Windows protected credential storage is unavailable:", error?.code ?? "windows_dpapi_unavailable");
    }
    if (safeStorageCodec || dpapiCodec) {
      return createWindowsProtectedSecretsCodec({ safeStorageCodec, dpapiCodec });
    }
  }
  if (process.platform === "linux" && !safeStorageCodec) {
    warnLinuxSecretsUnavailable(selectedBackend ?? "probe_failed");
  }
  return safeStorageCodec;
}

async function createWindow(port, gatewayToken) {
  // macOS keeps its standard application menu; Windows/Linux use our compact
  // title strip instead of a second menu bar.
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  const titlebar = process.platform === "darwin"
    ? { titleBarStyle: "hiddenInset" }
    : {
        titleBarStyle: "hidden",
        titleBarOverlay: { color: "#08090a", symbolColor: "#8a8f98", height: 34 },
      };
  windowRef = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: "#08090a",
    title: "Kyrei",
    icon: appIcon,
    autoHideMenuBar: true,
    // The in-app 34px title strip is the workspace header on every platform.
    ...titlebar,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(here, "preload.js"),
    },
  });

  // Kyrei's renderer is a closed desktop workspace: it never creates browser
  // tabs or navigates away from the local UI. Provider connectors may ask an
  // official external CLI to open the system browser for authentication, but
  // sign-in pages are never embedded in this BrowserWindow.
  windowRef.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  windowRef.webContents.on("will-navigate", (event) => event.preventDefault());
  windowRef.webContents.on("will-redirect", (event) => event.preventDefault());
  const disposeViewportGuard = installDesktopViewportGuard(windowRef);
  windowRef.once("closed", disposeViewportGuard);

  const devUrl = process.env.KYREI_RENDERER_URL;
  if (devUrl) {
    const renderer = new URL(devUrl);
    renderer.searchParams.set("port", String(port));
    renderer.searchParams.set("gatewayToken", gatewayToken);
    await windowRef.loadURL(renderer.href);
  } else {
    await windowRef.loadFile(join(app.getAppPath(), "dist", "renderer", "index.html"), {
      search: new URLSearchParams({ port: String(port), gatewayToken }).toString(),
    });
  }
}

if (ownsSingleInstance) app.whenReady().then(async () => {
  try {
    const devUrl = process.env.KYREI_RENDERER_URL;
    const rendererOrigin = devUrl ? new URL(devUrl).origin : "null";
    const secretsCodec = await createSecretsCodec();
    const terminalManager = new TerminalSessionManager({ defaultCwd: app.getPath("home") });
    const commandRunner = {
      run: (input) => terminalManager.runAgentCommand({
        ...input,
        // Renderer identity is derived from the trusted BrowserWindow. It is
        // never accepted from the HTTP request or tool arguments.
        rendererId: windowRef && !windowRef.isDestroyed() ? windowRef.webContents.id : 0,
      }),
    };
    gateway = await startGateway({
      dataDir: join(app.getPath("userData"), "kyrei"),
      chooseFolder,
      openPath,
      preferredPort: 8765,
      rendererOrigin,
      runtimeBuildId: `${app.getVersion()}:${process.env.KYREI_BUILD_ID ?? "release"}`,
      requireProtectedSecrets: true,
      commandRunner,
      ...(secretsCodec ? { secretsCodec } : {}),
    });
    // download/install are user-driven from Settings → About (never silent).
    // Resolve autoUpdater lazily inside Electron (CJS export; needs app ready).
    const { autoUpdater } = electronUpdater;
    const updateBroadcast = { send: /** @type {null | ((status: object) => void)} */ (null) };
    const appUpdater = createAppUpdater({
      app,
      autoUpdater,
      onStatus: (status) => {
        try {
          updateBroadcast.send?.(status);
        } catch {
          /* renderer may be gone during quit */
        }
      },
    });
    desktopCapabilities = registerDesktopIpc({
      ipcMain,
      dialog,
      shell,
      defaultCwd: app.getPath("home"),
      getWindow: (webContents) => BrowserWindow.fromWebContents(webContents),
      terminalManager,
      appUpdater,
    });
    updateBroadcast.send = (status) => desktopCapabilities?.broadcastUpdate?.(status);
    await createWindow(gateway.port, gateway.token);
    void appUpdater.start();
  } catch (error) {
    dialog.showErrorBox("Kyrei", error.message);
    app.quit();
  }
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0 && gateway) createWindow(gateway.port, gateway.token); });
app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  Promise.all([
    Promise.resolve(gateway && typeof gateway.close === "function" ? gateway.close() : undefined),
    Promise.resolve(desktopCapabilities && typeof desktopCapabilities.dispose === "function" ? desktopCapabilities.dispose() : undefined),
  ])
    .catch(error => console.error("[kyrei] desktop shutdown failed:", error))
    .finally(() => {
      shutdownComplete = true;
      app.quit();
    });
});
