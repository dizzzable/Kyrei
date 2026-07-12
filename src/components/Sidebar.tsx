import { useMemo, useState } from "react";
import { Copy, Download, MessageSquarePlus, MoreHorizontal, Pencil, Pin, PinOff, Settings, Trash2, Command, Orbit } from "lucide-react";
import type { SessionInfo } from "@/lib/types";
import { sessionMatchesSearch, sessionTitle } from "@/lib/session-search";
import { buildSessionExport, redactSecretsInExport } from "@/lib/session-export";
import { togglePinned, usePinnedIds } from "@/store/sessions-ui";
import { gateway } from "@/lib/gateway";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  SearchField,
  dropdownMenuRow,
} from "@/components/ui";
import { cn } from "@/lib/utils";

interface SidebarProps {
  sessions: SessionInfo[];
  currentId: string | null;
  workingId?: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onOpenSettings: () => void;
}

async function exportSession(session: SessionInfo) {
  try {
    const messages = await gateway.getMessages(session.id);
    const data = redactSecretsInExport(
      buildSessionExport(session, messages.map((m, i) => ({
        id: `m-${i}`,
        role: m.role,
        parts: m.parts && m.parts.length ? m.parts : [{ type: "text" as const, text: m.content }],
      }))),
    );
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sessionTitle(session).slice(0, 40) || "session"}-${session.id.slice(-8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    /* best-effort */
  }
}

function SessionRow({
  session,
  active,
  working,
  pinned,
  onSelect,
  onDelete,
  onRename,
}: {
  session: SessionInfo;
  active: boolean;
  working: boolean;
  pinned: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(sessionTitle(session));

  const commitRename = () => {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== sessionTitle(session)) onRename(session.id, t);
  };

  return (
    <div
      className={cn(
        "session-row group flex min-h-8 cursor-pointer items-center gap-2 rounded-lg py-1 pl-2 pr-1 text-[12.5px] leading-none",
        active ? "bg-(--ui-row-active) text-foreground" : "text-secondary hover:bg-(--ui-row-hover)",
      )}
      onClick={() => !editing && onSelect(session.id)}
    >
      <span className="grid size-3.5 shrink-0 place-items-center" title={working ? "Работает" : undefined}>
        {working ? (
          <span className="relative size-1.5 rounded-full bg-primary shadow-[0_0_0.5rem_color-mix(in_srgb,var(--k-primary)_55%,transparent)] before:absolute before:inset-0 before:animate-ping before:rounded-full before:bg-primary before:opacity-70" />
        ) : active ? (
          <span className="size-1.5 rounded-full bg-primary" />
        ) : (
          <span className="size-1 rounded-full bg-faint opacity-80" />
        )}
      </span>
      {editing ? (
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setEditing(false);
          }}
          className="h-5 flex-1 px-1 py-0 text-[13px]"
        />
      ) : (
        <span className={cn("min-w-0 flex-1 truncate", !active && "group-hover:text-foreground")}>{sessionTitle(session)}</span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            onClick={(e) => e.stopPropagation()}
            className="grid size-5 shrink-0 place-items-center rounded text-muted opacity-0 hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
            aria-label="Действия"
          >
            <MoreHorizontal size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem className={dropdownMenuRow} onSelect={() => togglePinned(session.id)}>
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            {pinned ? "Открепить" : "Закрепить"}
          </DropdownMenuItem>
          <DropdownMenuItem className={dropdownMenuRow} onSelect={() => { setDraft(sessionTitle(session)); setEditing(true); }}>
            <Pencil size={14} /> Переименовать
          </DropdownMenuItem>
          <DropdownMenuItem className={dropdownMenuRow} onSelect={() => void exportSession(session)}>
            <Download size={14} /> Экспорт JSON
          </DropdownMenuItem>
          <DropdownMenuItem className={dropdownMenuRow} onSelect={() => navigator.clipboard.writeText(session.id).catch(() => {})}>
            <Copy size={14} /> Копировать id
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className={cn(dropdownMenuRow, "text-danger")} onSelect={() => onDelete(session.id)}>
            <Trash2 size={14} /> Удалить
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SectionHeader({ label, count, className }: { label: string; count: number; className?: string }) {
  return (
    <div className={cn("flex items-center gap-1.5 px-2 pb-1 pt-1", className)}>
      <span className="size-1.5 shrink-0 rounded-[1px] bg-faint" aria-hidden />
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</span>
      <span className="text-[10px] font-medium text-faint tabular-nums">{count}</span>
    </div>
  );
}

export function Sidebar({ sessions, currentId, workingId, onSelect, onNew, onDelete, onRename, onOpenSettings }: SidebarProps) {
  const [query, setQuery] = useState("");
  const pinnedIds = usePinnedIds();
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);

  const filtered = useMemo(
    () => sessions.filter((s) => sessionMatchesSearch(s, query)),
    [sessions, query],
  );
  const pinned = filtered.filter((s) => pinnedSet.has(s.id));
  const recent = filtered.filter((s) => !pinnedSet.has(s.id));

  const renderRow = (s: SessionInfo) => (
    <SessionRow
      key={s.id}
      session={s}
      active={s.id === currentId}
      working={s.id === workingId || s.status === "working"}
      pinned={pinnedSet.has(s.id)}
      onSelect={onSelect}
      onDelete={onDelete}
      onRename={onRename}
    />
  );

  return (
    <aside className="sidebar-panel flex h-full w-full flex-col border-r border-border-soft">
      <div className="flex items-center gap-2 px-3 pb-2 pt-4">
        <div className="kyrei-mark kyrei-mark-md" aria-hidden><span>K</span></div>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold tracking-[-0.02em] text-foreground">Kyrei</div>
          <div className="text-[9px] uppercase tracking-[0.15em] text-muted">agent workspace</div>
        </div>
        <span className="online-pill"><span /> online</span>
      </div>
      <div className="space-y-2 px-2.5 pt-2">
        <button
          onClick={onNew}
          className="new-session-button flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[12.5px] font-medium transition-colors"
        >
          <MessageSquarePlus size={15} />
          Новый диалог
        </button>
        <SearchField value={query} onChange={setQuery} placeholder="Поиск диалогов" aria-label="Поиск диалогов" />
      </div>

      <div className="mt-4 flex-1 overflow-y-auto px-2">
        {filtered.length === 0 && (
          <div className="px-2 py-3 text-[12px] text-muted">{query ? "Ничего не найдено" : "Пока нет диалогов"}</div>
        )}
        {pinned.length > 0 && (
          <>
            <SectionHeader label="Закреплённые" count={pinned.length} />
            {pinned.map(renderRow)}
          </>
        )}
        {recent.length > 0 && (
          <>
            {pinned.length > 0 && <SectionHeader label="Диалоги" count={recent.length} className="pt-3" />}
            {recent.map(renderRow)}
          </>
        )}
      </div>

      <div className="mx-2.5 mb-2 border-t border-border-soft pt-2">
        <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] text-secondary transition-colors hover:bg-(--ui-row-hover) hover:text-foreground" onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }))}>
          <Command size={14} /> Команды <kbd className="ml-auto">Ctrl K</kbd>
        </button>
        <button
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] text-secondary transition-colors hover:bg-(--ui-row-hover) hover:text-foreground"
        >
          <Settings size={16} />
          Настройки
          <Orbit size={12} className="ml-auto text-muted" />
        </button>
      </div>
    </aside>
  );
}
