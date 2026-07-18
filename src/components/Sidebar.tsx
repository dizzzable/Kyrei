import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, Copy, Download, GitFork, MoreHorizontal, Pencil, Pin, PinOff, Trash2, Upload } from "lucide-react";

import type { SessionInfo } from "@/lib/types";
import { sessionMatchesSearch, sessionTitle } from "@/lib/session-search";
import { buildSessionExport, redactSecretsInExport } from "@/lib/session-export";
import { importConversationFile } from "@/lib/session-import-api";
import { orderSessionsWithForkTree } from "@/lib/session-fork-tree";
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
  /** Soft-archive (default). Messages kept for hybrid memory. */
  onArchive: (id: string) => void;
  /** Fork full chat into a new session (parent untouched). */
  onFork?: (id: string) => void;
  /** Permanent delete — only if caller wires it (Settings uses this). */
  onDelete?: (id: string) => void;
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
  depth = 0,
  onSelect,
  onArchive,
  onFork,
  onDelete,
  onRename,
  now,
}: {
  session: SessionInfo;
  active: boolean;
  working: boolean;
  pinned: boolean;
  /** Nest depth for fork tree (0 = root). */
  depth?: number;
  onSelect: (id: string) => void;
  onArchive: (id: string) => void;
  onFork?: (id: string) => void;
  onDelete?: (id: string) => void;
  onRename: (id: string, title: string) => void;
  now: number;
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

  const nestPad = Math.min(Math.max(depth, 0), 4) * 10;

  return (
    <div
      className={cn(
        "session-row group flex min-h-8 cursor-pointer items-center gap-2 rounded-md py-1 pl-2 pr-1 text-[11.5px] leading-none",
        active ? "bg-(--ui-row-active) text-foreground" : "text-secondary hover:bg-(--ui-row-hover)",
      )}
      style={nestPad > 0 ? { paddingLeft: `${8 + nestPad}px` } : undefined}
      onClick={(event) => {
        if (editing) return;
        if (event.shiftKey) togglePinned(session.id);
        else onSelect(session.id);
      }}
    >
      {depth > 0 && (
        <span className="shrink-0 font-mono text-[9px] text-faint" aria-hidden title={t("shell.session.fork")}>
          └
        </span>
      )}
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
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1">
            <span className="block min-w-0 truncate">{title}</span>
            {session.parentSessionId && (
              <span
                className="shrink-0 rounded bg-elevated px-1 py-px text-[8px] font-medium uppercase tracking-wide text-muted"
                title={t("shell.session.forkBadge", { id: session.parentSessionId.slice(-8) })}
              >
                {t("shell.session.fork")}
              </span>
            )}
          </span>
          {session.activity?.active && (
            <span className="mt-0.5 flex min-w-0 items-center gap-1 font-mono text-[9px] leading-none text-muted">
              <span className="truncate">{session.activity.currentTool || t(`shell.session.phase.${session.activity.phase}` as const)}</span>
              <span className="shrink-0 text-faint">{Math.max(0, Math.floor((now - session.activity.startedAt) / 1000))}s</span>
            </span>
          )}
        </span>
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
          {onFork && (
            <DropdownMenuItem className={dropdownMenuRow} onSelect={() => onFork(session.id)}>
              <GitFork size={14} aria-hidden /> {t("shell.session.forkChat")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className={dropdownMenuRow} onSelect={() => void exportSession(session, t("shell.session.untitled"))}>
            <Download size={14} aria-hidden /> {t("shell.session.export")}
          </DropdownMenuItem>
          <DropdownMenuItem className={dropdownMenuRow} onSelect={() => navigator.clipboard.writeText(session.id).catch(() => {})}>
            <Copy size={14} aria-hidden /> {t("shell.session.copyId")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className={dropdownMenuRow} onSelect={() => onArchive(session.id)}>
            <Archive size={14} aria-hidden /> {t("shell.session.archive")}
          </DropdownMenuItem>
          {onDelete && (
            <DropdownMenuItem className={cn(dropdownMenuRow, "text-danger")} onSelect={() => onDelete(session.id)}>
              <Trash2 size={14} aria-hidden /> {t("shell.session.delete")}
            </DropdownMenuItem>
          )}
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

export function Sidebar({ sessions, currentId, workingId, onSelect, onArchive, onFork, onDelete, onRename }: SidebarProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(Date.now());
  const [importBusy, setImportBusy] = useState(false);
  const [importNote, setImportNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const pinnedIds = usePinnedIds();
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const filtered = useMemo(() => sessions.filter((session) => sessionMatchesSearch(session, query)), [sessions, query]);
  const pinned = filtered.filter((session) => pinnedSet.has(session.id));
  const recent = filtered.filter((session) => !pinnedSet.has(session.id));
  /** Nested fork tree for recent list only (pinned stays flat for pin UX). */
  const recentTree = useMemo(() => orderSessionsWithForkTree(recent), [recent]);

  useEffect(() => {
    if (!sessions.some((session) => session.activity?.active)) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [sessions]);

  const onImportFile = async (file: File | undefined) => {
    if (!file || importBusy) return;
    setImportBusy(true);
    setImportNote(null);
    try {
      const result = await importConversationFile(file);
      if (result.sessionId) onSelect(result.sessionId);
      window.dispatchEvent(new CustomEvent("kyrei:sessions-refresh"));
      setImportNote({
        kind: "ok",
        text: t("shell.session.importOk", {
          count: String(result.report.messageCount),
          adapter: result.report.adapterId,
        }),
      });
    } catch (error) {
      setImportNote({
        kind: "error",
        text: error instanceof Error && error.message
          ? `${t("shell.session.importFailed")}: ${error.message}`
          : t("shell.session.importFailed"),
      });
      console.warn(t("shell.session.importFailed"), error);
    } finally {
      setImportBusy(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  const renderRow = (session: SessionInfo, depth = 0) => (
    <SessionRow
      key={session.id}
      session={session}
      active={session.id === currentId}
      working={session.id === workingId || session.status === "working"}
      pinned={pinnedSet.has(session.id)}
      depth={depth}
      onSelect={onSelect}
      onArchive={onArchive}
      onFork={onFork}
      onDelete={onDelete}
      onRename={onRename}
      now={now}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-2 pb-2 pt-1" data-shell-session-search>
        <div className="min-w-0 flex-1">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={t("shell.session.search")}
            aria-label={t("shell.session.search")}
            data-session-search
          />
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept=".json,.jsonl,.md,.txt,application/json,text/markdown,text/plain"
          className="hidden"
          onChange={(event) => void onImportFile(event.target.files?.[0])}
        />
        <button
          type="button"
          className="shell-icon-button size-7 shrink-0"
          title={t("shell.session.importHint")}
          aria-label={t("shell.session.import")}
          disabled={importBusy}
          onClick={() => importInputRef.current?.click()}
        >
          <Upload size={14} aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {importNote && (
          <div
            className={cn(
              "mb-2 rounded-md border px-2 py-1.5 text-[10px] leading-4",
              importNote.kind === "ok"
                ? "border-success/30 bg-success/8 text-secondary"
                : "border-danger/30 bg-danger/8 text-danger",
            )}
            role="status"
          >
            {importNote.text}
            <button
              type="button"
              className="ml-2 text-faint underline"
              onClick={() => setImportNote(null)}
            >
              {t("common.dismiss")}
            </button>
          </div>
        )}
        {filtered.length === 0 && (
          <div className="px-2 py-3 text-[11px] text-muted">{query ? t("shell.session.noResults") : t("shell.session.none")}</div>
        )}
        <SectionHeader label={t("shell.session.pinned")} count={pinned.length} />
        {pinned.length > 0
          ? pinned.map(renderRow)
          : <div className="px-2 pb-2 text-[9.5px] leading-4 text-faint">{t("shell.session.pinHint")}</div>}
        {recentTree.length > 0 && (
          <>
            <SectionHeader label={t("shell.session.recent")} count={recentTree.length} className="pt-3" />
            {recentTree.map(({ session, depth }) => renderRow(session, depth))}
          </>
        )}
      </div>
    </div>
  );
}
