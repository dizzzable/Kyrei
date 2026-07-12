import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startGateway } from "../core/gateway.js";

ipcMain.handle("kyrei:open-external", (_event, url) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) shell.openExternal(url);
});

const here = fileURLToPath(new URL(".", import.meta.url));
const appIcon = join(here, "..", "assets", "icon.png");

let windowRef;
let gateway; // { port, close }

async function chooseFolder() {
  const result = await dialog.showOpenDialog(windowRef, {
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? "" : result.filePaths[0] ?? "";
}

async function createWindow(port) {
  windowRef = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#0d0f13",
    title: "Kyrei",
    icon: appIcon,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(here, "preload.js"),
    },
  });

  windowRef.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });

  const devUrl = process.env.KYREI_RENDERER_URL;
  if (devUrl) {
    await windowRef.loadURL(`${devUrl}?port=${port}`);
  } else {
    await windowRef.loadFile(join(app.getAppPath(), "dist", "renderer", "index.html"), {
      search: `port=${port}`,
    });
  }
}

app.whenReady().then(async () => {
  try {
    gateway = await startGateway({ dataDir: join(app.getPath("userData"), "kyrei"), chooseFolder, preferredPort: 8765 });
    await createWindow(gateway.port);
  } catch (error) {
    dialog.showErrorBox("Kyrei", error.message);
    app.quit();
  }
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0 && gateway) createWindow(gateway.port); });
app.on("before-quit", () => { if (gateway && typeof gateway.close === "function") gateway.close(); });
