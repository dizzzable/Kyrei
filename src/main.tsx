import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { applyTheme, getTheme } from "./lib/theme";
import { restoreCustomTheme } from "./lib/vscode-theme";
import { applyScale, getUiSettings } from "./store/settings";
import { I18nProvider } from "./i18n";
import { TooltipProvider } from "./components/ui";
import { installWindowDropGuard } from "./lib/window-drop-guard";

// Boot-paint already set data-theme in index.html; this syncs the store/event
// and localStorage without causing a flash.
applyTheme(getTheme());
restoreCustomTheme();
applyScale(getUiSettings().scale);

// Block the Electron default where dropping a file/image navigates the window
// away and unloads the app. Components that accept a drop opt in explicitly.
installWindowDropGuard();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </I18nProvider>
  </StrictMode>,
);
