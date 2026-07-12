import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquarePlus, Palette, Settings as SettingsIcon, MessagesSquare } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui";
import { applyTheme, THEMES } from "@/lib/theme";
import { sessionMatchesSearch, sessionTitle } from "@/lib/session-search";
import type { SessionInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Item {
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
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const wrap = (run: () => void) => () => { run(); onClose(); };
    const base: Item[] = [
      { id: "new", label: "Новый диалог", icon: <MessageSquarePlus className="size-4" />, run: wrap(onNew) },
      { id: "settings", label: "Открыть настройки", icon: <SettingsIcon className="size-4" />, run: wrap(onOpenSettings) },
      ...THEMES.map((t) => ({
        id: `theme:${t.id}`,
        label: `Тема: ${t.label}`,
        hint: "оформление",
        icon: <Palette className="size-4" />,
        run: wrap(() => applyTheme(t.id)),
      })),
      ...sessions.slice(0, 40).map((s) => ({
        id: `sess:${s.id}`,
        label: sessionTitle(s),
        hint: "перейти к диалогу",
        icon: <MessagesSquare className="size-4" />,
        run: wrap(() => onSelectSession(s.id)),
      })),
    ];
    const q = query.trim().toLowerCase();
    if (!q) return base;
    const words = q.split(/\s+/);
    return base.filter((it) => {
      const hay = `${it.label} ${it.hint ?? ""}`.toLowerCase();
      // Sessions also match via the shared search helper.
      if (it.id.startsWith("sess:")) {
        const s = sessions.find((x) => `sess:${x.id}` === it.id);
        if (s && sessionMatchesSearch(s, q)) return true;
      }
      return words.every((w) => hay.includes(w));
    });
  }, [query, sessions, onNew, onOpenSettings, onSelectSession, onClose]);

  useEffect(() => setActive(0), [query]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent showClose={false} className="top-[18%] w-[min(92vw,34rem)] translate-y-0 gap-0 p-0">
        <DialogTitle className="sr-only">Командная палитра</DialogTitle>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % Math.max(items.length, 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + items.length) % Math.max(items.length, 1)); }
            else if (e.key === "Enter") { e.preventDefault(); items[active]?.run(); }
          }}
          placeholder="Команды и переход к диалогу…"
          className="w-full border-b border-border-soft bg-transparent px-4 py-3 text-[14px] text-foreground outline-none placeholder:text-muted"
        />
        <div className="max-h-80 overflow-y-auto p-1.5">
          {items.length === 0 && <div className="px-3 py-4 text-center text-[13px] text-muted">Ничего не найдено</div>}
          {items.map((it, i) => (
            <button
              key={it.id}
              onMouseEnter={() => setActive(i)}
              onClick={() => it.run()}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px]",
                i === active ? "bg-(--ui-row-hover) text-foreground" : "text-secondary",
              )}
            >
              <span className="shrink-0 text-muted">{it.icon}</span>
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.hint && <span className="shrink-0 text-[11px] text-muted">{it.hint}</span>}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
