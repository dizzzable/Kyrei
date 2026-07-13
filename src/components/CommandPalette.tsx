import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquarePlus, MessagesSquare, Palette, Settings as SettingsIcon } from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui";
import { useI18n } from "@/i18n";
import { applyTheme, THEMES } from "@/lib/theme";
import { sessionMatchesSearch, sessionTitle } from "@/lib/session-search";
import type { SessionInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  sessions,
  onNew,
  onOpenSettings,
  onSelectSession,
}: {
  open: boolean;
  onClose: () => void;
  sessions: SessionInfo[];
  onNew: () => void;
  onOpenSettings: () => void;
  onSelectSession: (id: string) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const timeout = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(timeout);
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const wrap = (run: () => void) => () => {
      run();
      onClose();
    };
    const base: PaletteItem[] = [
      {
        id: "new",
        label: t("shell.session.new"),
        icon: <MessageSquarePlus className="size-4" aria-hidden />,
        run: wrap(onNew),
      },
      {
        id: "settings",
        label: t("shell.commandPalette.openSettings"),
        icon: <SettingsIcon className="size-4" aria-hidden />,
        run: wrap(onOpenSettings),
      },
      ...THEMES.map((theme) => ({
        id: `theme:${theme.id}`,
        label: t("shell.commandPalette.theme", { theme: t(theme.labelKey) }),
        hint: t("shell.commandPalette.themeHint"),
        icon: <Palette className="size-4" aria-hidden />,
        run: wrap(() => applyTheme(theme.id)),
      })),
      ...sessions.slice(0, 40).map((session) => ({
        id: `session:${session.id}`,
        label: sessionTitle(session, t("shell.session.untitled")),
        hint: t("shell.commandPalette.sessionHint"),
        icon: <MessagesSquare className="size-4" aria-hidden />,
        run: wrap(() => onSelectSession(session.id)),
      })),
    ];
    const normalized = query.trim().toLowerCase();
    if (!normalized) return base;
    const words = normalized.split(/\s+/);
    return base.filter((item) => {
      const haystack = `${item.label} ${item.hint ?? ""}`.toLowerCase();
      if (item.id.startsWith("session:")) {
        const session = sessions.find((candidate) => `session:${candidate.id}` === item.id);
        if (session && sessionMatchesSearch(session, normalized)) return true;
      }
      return words.every((word) => haystack.includes(word));
    });
  }, [query, sessions, onNew, onOpenSettings, onSelectSession, onClose, t]);

  useEffect(() => setActive(0), [query]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent showClose={false} className="top-[18%] w-[min(92vw,34rem)] translate-y-0 gap-0 p-0">
        <DialogTitle className="sr-only">{t("shell.commandPalette.title")}</DialogTitle>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((current) => (current + 1) % Math.max(items.length, 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((current) => (current - 1 + items.length) % Math.max(items.length, 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              items[active]?.run();
            }
          }}
          placeholder={t("shell.commandPalette.placeholder")}
          aria-label={t("shell.commandPalette.placeholder")}
          className="w-full border-b border-border-soft bg-transparent px-4 py-3 text-[13px] text-foreground outline-none placeholder:text-muted"
        />
        <div className="max-h-80 overflow-y-auto p-1.5">
          {items.length === 0 && (
            <div className="px-3 py-4 text-center text-[12px] text-muted">{t("shell.commandPalette.noResults")}</div>
          )}
          {items.map((item, index) => (
            <button
              key={item.id}
              onMouseEnter={() => setActive(index)}
              onClick={item.run}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[12px]",
                index === active ? "bg-(--ui-row-hover) text-foreground" : "text-secondary",
              )}
            >
              <span className="shrink-0 text-muted">{item.icon}</span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint && <span className="shrink-0 text-[10px] text-muted">{item.hint}</span>}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
