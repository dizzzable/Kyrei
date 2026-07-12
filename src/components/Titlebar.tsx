import { PanelLeft, PanelRight, ShieldCheck } from "lucide-react";

/**
 * The single 34px top strip — Hermes-style. It is the window drag region AND
 * the chat header: no separate tall header band ("forehead"). Interactive
 * controls opt out of dragging; the right side reserves room for the native
 * min/max/close buttons painted by Electron's titleBarOverlay.
 */
export function Titlebar({
  title,
  model,
  hasKey,
  explorerOpen,
  onToggleSidebar,
  onToggleExplorer,
}: {
  title: string;
  model?: string;
  hasKey?: boolean;
  explorerOpen: boolean;
  onToggleSidebar: () => void;
  onToggleExplorer: () => void;
}) {
  return (
    <div
      className="titlebar relative z-20 flex h-[34px] shrink-0 items-center gap-2 border-b border-border-soft pl-2.5"
      style={{ WebkitAppRegion: "drag", paddingRight: "8.75rem" } as React.CSSProperties}
    >
      <button
        onClick={onToggleSidebar}
        className="shell-button grid size-7 shrink-0 place-items-center text-muted transition-colors hover:text-foreground"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        title="Показать/скрыть сайдбар"
      >
        <PanelLeft size={15} />
      </button>
      <div
        className="kyrei-mark kyrei-mark-sm"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        K
      </div>
      <span className="min-w-0 truncate text-[12px] font-medium text-secondary">{title}</span>

      <div className="ml-auto flex shrink-0 items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        {model && (
          <span className="model-status flex items-center gap-1.5 text-[10.5px] text-muted">
            <ShieldCheck size={12} className={hasKey ? "text-success" : "text-warning"} />
            <span className="max-w-56 truncate">{model}</span>
          </span>
        )}
        <button
          onClick={onToggleExplorer}
          className={`shell-button grid size-7 place-items-center transition-colors ${explorerOpen ? "bg-(--ui-row-active) text-foreground" : "text-muted hover:text-foreground"}`}
          title="Файлы рабочей папки"
        >
          <PanelRight size={14} />
        </button>
      </div>
    </div>
  );
}
