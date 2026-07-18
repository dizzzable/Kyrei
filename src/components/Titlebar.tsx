import { ArrowLeftRight, Keyboard, PanelLeft, PanelRight, Settings } from "lucide-react";
import { useEffect } from "react";

import { useI18n } from "@/i18n";
import { cssColorToHex } from "@/lib/window-theme";
import { cn } from "@/lib/utils";

interface TitlebarProps {
  title: string;
  developerOpen: boolean;
  activityOpen: boolean;
  swapped: boolean;
  onToggleDeveloper: () => void;
  onToggleActivity: () => void;
  onSwapRails: () => void;
  onOpenSettings: () => void;
  onOpenKeybinds: () => void;
}

/** One compact drag surface shared by Windows, macOS and Linux. */
export function Titlebar({
  title,
  developerOpen,
  activityOpen,
  swapped,
  onToggleDeveloper,
  onToggleActivity,
  onSwapRails,
  onOpenSettings,
  onOpenKeybinds,
}: TitlebarProps) {
  const { t } = useI18n();

  useEffect(() => {
    const setWindowTheme = window.kyrei?.appearance?.setWindowTheme;
    if (!setWindowTheme || typeof document === "undefined") return;
    const root = document.documentElement;
    const resolveThemeColor = (variable: "--k-surface" | "--k-secondary") => {
      const probe = document.createElement("span");
      probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;color:var(${variable});`;
      root.append(probe);
      try {
        return cssColorToHex(getComputedStyle(probe).color);
      } finally {
        probe.remove();
      }
    };
    const sync = () => {
      const color = resolveThemeColor("--k-surface");
      const symbolColor = resolveThemeColor("--k-secondary");
      if (color && symbolColor) void setWindowTheme({ color, symbolColor }).catch(() => undefined);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "style"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const controls = (navigator as Navigator & {
      windowControlsOverlay?: {
        visible: boolean;
        getTitlebarAreaRect(): DOMRect;
        addEventListener(type: "geometrychange", listener: () => void): void;
        removeEventListener(type: "geometrychange", listener: () => void): void;
      };
    }).windowControlsOverlay;
    const updateInsets = () => {
      if (controls?.visible) {
        const rect = controls.getTitlebarAreaRect();
        root.style.setProperty("--native-titlebar-start", `${Math.max(6, rect.x + 6)}px`);
        root.style.setProperty("--native-titlebar-end", `${Math.max(6, window.innerWidth - rect.right + 6)}px`);
        return;
      }
      const mac = /Macintosh|Mac OS X/i.test(navigator.userAgent);
      root.style.setProperty("--native-titlebar-start", mac ? "76px" : "6px");
      root.style.setProperty("--native-titlebar-end", "6px");
    };
    updateInsets();
    controls?.addEventListener("geometrychange", updateInsets);
    window.addEventListener("resize", updateInsets);
    return () => {
      controls?.removeEventListener("geometrychange", updateInsets);
      window.removeEventListener("resize", updateInsets);
    };
  }, []);

  return (
    <header className="titlebar shell-titlebar relative z-40 flex h-8 shrink-0 items-center gap-1 border-b border-border-soft">
      <div className="titlebar-controls flex items-center gap-0.5">
        <button
          onClick={onToggleDeveloper}
          className={cn("shell-icon-button", developerOpen && "text-foreground")}
          title={t("shell.title.toggleDeveloper")}
          aria-label={t("shell.title.toggleDeveloper")}
          aria-pressed={developerOpen}
        >
          <PanelLeft size={14} aria-hidden />
        </button>
        <button
          onClick={onSwapRails}
          className={cn("shell-icon-button", swapped && "text-primary")}
          title={t("shell.title.swapRails")}
          aria-label={t("shell.title.swapRails")}
          aria-pressed={swapped}
        >
          <ArrowLeftRight size={13} aria-hidden />
        </button>
      </div>

      <div className="titlebar-center min-w-0 flex-1 px-3 text-center">
        <span className="block truncate text-[11px] font-medium text-secondary">{title}</span>
      </div>

      <div className="titlebar-controls ml-auto flex items-center gap-1">
        <button
          onClick={onOpenKeybinds}
          className="shell-icon-button"
          title={t("shell.title.openKeybinds")}
          aria-label={t("shell.title.openKeybinds")}
        >
          <Keyboard size={13} aria-hidden />
        </button>
        <button
          onClick={onOpenSettings}
          className="shell-icon-button"
          title={t("shell.settings.open")}
          aria-label={t("shell.settings.open")}
        >
          <Settings size={13} aria-hidden />
        </button>
        <button
          onClick={onToggleActivity}
          className={cn("shell-icon-button", activityOpen && "text-foreground")}
          title={t("shell.title.toggleActivity")}
          aria-label={t("shell.title.toggleActivity")}
          aria-pressed={activityOpen}
        >
          <PanelRight size={14} aria-hidden />
        </button>
      </div>
    </header>
  );
}
