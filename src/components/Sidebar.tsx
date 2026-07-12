import { MessageSquarePlus, Settings, Trash2 } from "lucide-react";
import type { SessionInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ThemeSwitcher } from "./ThemeSwitcher";

interface SidebarProps {
  sessions: SessionInfo[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
}

export function Sidebar({ sessions, currentId, onSelect, onNew, onDelete, onOpenSettings }: SidebarProps) {
  return (
    <aside className="flex h-full w-full flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="grid size-8 place-items-center rounded-lg bg-primary-strong text-[15px] font-bold text-white">K</div>
        <span className="text-[16px] font-bold tracking-tight">Kyrei</span>
      </div>

      <div className="px-3">
        <button
          onClick={onNew}
          className="flex w-full items-center gap-2 rounded-lg bg-primary-strong px-3 py-2 text-[13px] font-semibold text-white transition-colors hover:brightness-110"
        >
          <MessageSquarePlus size={16} />
          Новый диалог
        </button>
      </div>

      <div className="mt-4 px-4 text-[11px] font-semibold uppercase tracking-wider text-muted">Диалоги</div>
      <div className="mt-1 flex-1 overflow-y-auto px-2">
        {sessions.length === 0 && <div className="px-2 py-3 text-[12px] text-muted">Пока нет диалогов</div>}
        {sessions.map(s => (
          <div
            key={s.id}
            className={cn(
              "group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px]",
              s.id === currentId ? "bg-elevated text-foreground" : "text-secondary hover:bg-white/[0.04]",
            )}
            onClick={() => onSelect(s.id)}
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", s.id === currentId ? "bg-primary" : "bg-border")} />
            <span className="flex-1 truncate">{s.title || "Новый диалог"}</span>
            <button
              onClick={e => { e.stopPropagation(); onDelete(s.id); }}
              className="shrink-0 text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
              title="Удалить"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="m-3 mt-1 space-y-0.5">
        <ThemeSwitcher />
        <button
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-secondary transition-colors hover:bg-white/[0.04]"
        >
          <Settings size={16} />
          Настройки
        </button>
      </div>
    </aside>
  );
}
