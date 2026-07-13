import { useMemo, useState } from "react";
import { Copy, Download, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from "lucide-react";

import type { SessionInfo } from "@/lib/types";
import { sessionMatchesSearch, sessionTitle } from "@/lib/session-search";
import { buildSessionExport, redactSecretsInExport } from "@/lib/session-export";
import { togglePinned, usePinnedIds } from "@/store/sessions-ui";
import { gateway } from "@/lib/gateway";
import { useI18n } from "@/i18n";
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
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

async function exportSession(session: SessionInfo, fallbackTitle: string) {
  try {
    const messages = await gateway.getMessages(session.id);
    const data = redactSecretsInExport(
      buildSessionExport(session, messages.map((message, index) => ({
        id: `m-${index}`,
        role: message.role,
        parts: message.parts && message.parts.length ? message.parts : [{ type: "text" as const, text: message.content }],
      }))),
    );
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${sessionTitle(session, fallbackTitle).slice(0, 40)}-${session.id.slice(-8)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch {
    // Export is best-effort and never mutates the stored session.
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
  const { t } = useI18n();
  const title = sessionTitle(session, t("shell.session.untitled"));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  const commitRename = () => {
    setEditing(false);
    const nextTitle = draft.trim();
    if (nextTitle && nextTitle !== title) onRename(session.id, nextTitle);
  };

  return (
    <div
      className={cn(
        "session-row group flex min-h-7 cursor-pointer items-center gap-2 rounded-md py-1 pl-2 pr-1 text-[11.5px] leading-none",
        active ? "bg-(--ui-row-active) text-foreground" : "text-secondary hover:bg-(--ui-row-hover)",
      )}
      onClick={(event) => {
        if (editing) return;
        if (event.shiftKey) togglePinned(session.id);
        else onSelect(session.id);
      }}
    >
      <span className="grid size-3 shrink-0 place-items-center" title={working ? t("shell.session.working") : undefined}>
        {working ? (
          <span className="relative size-1.5 rounded-full bg-primary before:absolute before:inset-0 before:animate-ping before:rounded-full before:bg-primary before:opacity-70" />
        ) : active ? (
          <span className="size-1.5 rounded-full bg-primary" />
        ) : (
          <span className="size-1 rounded-full bg-faint" />
        )}
      </span>
      {editing ? (
        <Input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitRename();
            if (event.key === "Escape") setEditing(false);
          }}
          className="h-5 flex-1 px-1 py-0 text-[11.5px]"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">{title}</span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            onClick={(event) => event.stopPropagation()}
            className="shell-icon-button size-5 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
            aria-label={t("shell.session.actions")}
          >
            <MoreHorizontal size={13} aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem className={dropdownMenuRow} onSelect={() => togglePinned(session.id)}>
            {pinned ? <PinOff size={14} aria-hidden /> : <Pin size={14} aria-hidden />}
            {pinned ? t("shell.session.unpin") : t("shell.session.pin")}
          </DropdownMenuItem>
          <DropdownMenuItem className={dropdownMenuRow} onSelect={() => { setDraft(title); setEditing(true); }}>
            <Pencil size={14} aria-hidden /> {t("shell.session.rename")}
          </DropdownMenuItem>
          <DropdownMenuItem className={dropdownMenuRow} onSelect={() => void exportSession(session, t("shell.session.untitled"))}>
            <Download size={14} aria-hidden /> {t("shell.session.export")}
          </DropdownMenuItem>
          <DropdownMenuItem className={dropdownMenuRow} onSelect={() => navigator.clipboard.writeText(session.id).catch(() => {})}>
            <Copy size={14} aria-hidden /> {t("shell.session.copyId")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className={cn(dropdownMenuRow, "text-danger")} onSelect={() => onDelete(session.id)}>
            <Trash2 size={14} aria-hidden /> {t("shell.session.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SectionHeader({ label, count, className }: { label: string; count: number; className?: string }) {
  return (
    <div className={cn("flex items-center gap-1.5 px-2 pb-1 pt-1", className)}>
      <span className="size-1 shrink-0 bg-faint" aria-hidden />
      <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</span>
      <span className="text-[9px] font-medium tabular-nums text-faint">{count}</span>
    </div>
  );
}

export function Sidebar({ sessions, currentId, workingId, onSelect, onDelete, onRename }: SidebarProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const pinnedIds = usePinnedIds();
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const filtered = useMemo(() => sessions.filter((session) => sessionMatchesSearch(session, query)), [sessions, query]);
  const pinned = filtered.filter((session) => pinnedSet.has(session.id));
  const recent = filtered.filter((session) => !pinnedSet.has(session.id));

  const renderRow = (session: SessionInfo) => (
    <SessionRow
      key={session.id}
      session={session}
      active={session.id === currentId}
      working={session.id === workingId || session.status === "working"}
      pinned={pinnedSet.has(session.id)}
      onSelect={onSelect}
      onDelete={onDelete}
      onRename={onRename}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pb-2 pt-1" data-shell-session-search>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t("shell.session.search")}
          aria-label={t("shell.session.search")}
          data-session-search
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {filtered.length === 0 && (
          <div className="px-2 py-3 text-[11px] text-muted">{query ? t("shell.session.noResults") : t("shell.session.none")}</div>
        )}
        <SectionHeader label={t("shell.session.pinned")} count={pinned.length} />
        {pinned.length > 0
          ? pinned.map(renderRow)
          : <div className="px-2 pb-2 text-[9.5px] leading-4 text-faint">{t("shell.session.pinHint")}</div>}
        {recent.length > 0 && (
          <>
            <SectionHeader label={t("shell.session.recent")} count={recent.length} className="pt-3" />
            {recent.map(renderRow)}
          </>
        )}
      </div>
    </div>
  );
}
