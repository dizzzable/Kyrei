import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
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
    {/* Outermost on purpose: it must survive a throw from I18nProvider or the
        design-system providers too, so it renders its own bare-DOM fallback. */}
    <AppErrorBoundary>
      <I18nProvider>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </I18nProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
