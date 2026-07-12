import { app, BrowserWindow, Menu, dialog } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startGateway } from "../core/gateway.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const appIcon = join(here, "..", "assets", "icon.png");

let windowRef;
let gateway; // { port, token, close }

async function chooseFolder() {
  const result = await dialog.showOpenDialog(windowRef, {
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? "" : result.filePaths[0] ?? "";
}

async function createWindow(port, gatewayToken) {
  // macOS keeps its standard application menu; Windows/Linux use our compact
  // title strip instead of a second menu bar.
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  const titlebar = process.platform === "darwin"
    ? { titleBarStyle: "hiddenInset" }
    : {
        titleBarStyle: "hidden",
        titleBarOverlay: { color: "#0e0e0e", symbolColor: "#a4a4a4", height: 34 },
      };
  windowRef = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#000000",
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

  // Kyrei is a closed desktop workspace: it never creates browser tabs,
  // hands URLs to the OS, or navigates away from its local renderer.
  windowRef.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  windowRef.webContents.on("will-navigate", (event) => event.preventDefault());
  windowRef.webContents.on("will-redirect", (event) => event.preventDefault());

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

app.whenReady().then(async () => {
  try {
    const devUrl = process.env.KYREI_RENDERER_URL;
    const rendererOrigin = devUrl ? new URL(devUrl).origin : "null";
    gateway = await startGateway({
      dataDir: join(app.getPath("userData"), "kyrei"),
      chooseFolder,
      preferredPort: 8765,
      rendererOrigin,
    });
    await createWindow(gateway.port, gateway.token);
  } catch (error) {
    dialog.showErrorBox("Kyrei", error.message);
    app.quit();
  }
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0 && gateway) createWindow(gateway.port, gateway.token); });
app.on("before-quit", () => { if (gateway && typeof gateway.close === "function") gateway.close(); });
