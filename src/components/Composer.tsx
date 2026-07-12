import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Square } from "lucide-react";
import { parseSlash, SLASH_COMMANDS } from "@/lib/commands";
import { cn } from "@/lib/utils";

interface ComposerProps {
  streaming: boolean;
  disabled?: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onCommand: (name: string, arg?: string) => void;
}

export function Composer({ streaming, disabled, onSend, onStop, onCommand }: ComposerProps) {
  const [value, setValue] = useState("");
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const history = useRef<string[]>([]);
  const browse = useRef<number | null>(null);

  const suggestions = useMemo(() => {
    if (!value.startsWith("/") || value.includes(" ") || value.includes("\n")) return [];
    const q = value.slice(1).toLowerCase();
    return SLASH_COMMANDS.filter(c => c.name.startsWith(q));
  }, [value]);

  useEffect(() => setSel(0), [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  const runOrSend = () => {
    const text = value.trim();
    if (!text || streaming) return;
    if (text.startsWith("/")) {
      const { name, arg } = parseSlash(text);
      if (SLASH_COMMANDS.some(c => c.name === name)) { onCommand(name, arg || undefined); setValue(""); return; }
    }
    if (history.current[history.current.length - 1] !== text) history.current.push(text);
    browse.current = null;
    onSend(text);
    setValue("");
  };

  const pickSuggestion = (index: number) => {
    const c = suggestions[index];
    if (!c) return;
    if (c.arg) { setValue(`/${c.name} `); ref.current?.focus(); }
    else { onCommand(c.name); setValue(""); }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSel(s => (s + 1) % suggestions.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSel(s => (s - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === "Tab") { e.preventDefault(); setValue(`/${suggestions[sel].name} `); return; }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); pickSuggestion(sel); return; }
      if (e.key === "Escape") { e.preventDefault(); setValue(""); return; }
    }

    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runOrSend(); return; }

    const h = history.current;
    if (e.key === "ArrowUp") {
      if (!h.length) return;
      if (browse.current === null) { if (value.trim() !== "") return; browse.current = h.length; }
      browse.current = Math.max(0, browse.current - 1);
      e.preventDefault();
      setValue(h[browse.current]);
    } else if (e.key === "ArrowDown" && browse.current !== null) {
      e.preventDefault();
      browse.current += 1;
      if (browse.current >= h.length) { browse.current = null; setValue(""); }
      else setValue(h[browse.current]);
    }
  };

  return (
    <div className="px-4 pb-4 pt-2">
      <div className="relative mx-auto max-w-3xl">
        {suggestions.length > 0 && (
          <div className="absolute bottom-full left-0 mb-2 w-72 overflow-hidden rounded-xl border border-border bg-elevated py-1 shadow-lg">
            {suggestions.map((c, i) => (
              <button
                key={c.name}
                onMouseDown={e => { e.preventDefault(); pickSuggestion(i); }}
                onMouseEnter={() => setSel(i)}
                className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left", i === sel ? "bg-white/[0.06]" : "")}
              >
                <span className="font-mono text-[13px] text-primary">/{c.name}</span>
                {c.arg && <span className="font-mono text-[11px] text-muted">{c.arg}</span>}
                <span className="ml-auto text-[11.5px] text-muted">{c.desc}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-2xl border border-border bg-surface px-3 py-2 focus-within:border-primary/60">
          <textarea
            ref={ref}
            rows={1}
            value={value}
            disabled={disabled}
            onChange={e => { setValue(e.target.value); browse.current = null; }}
            onKeyDown={onKeyDown}
            placeholder={disabled ? "Подключение…" : "Спросите Kyrei…  (/ — команды)"}
            className="max-h-[220px] min-h-[24px] flex-1 resize-none bg-transparent py-1 text-[14px] leading-relaxed text-foreground outline-none placeholder:text-muted"
          />
          {streaming ? (
            <button onClick={onStop} className="grid size-8 shrink-0 place-items-center rounded-lg bg-danger text-white transition-colors hover:brightness-110" title="Остановить">
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button onClick={runOrSend} disabled={!value.trim()} className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-strong text-white transition-colors hover:brightness-110 disabled:bg-border disabled:text-muted" title="Отправить">
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="mx-auto mt-1.5 max-w-3xl px-1 text-center text-[11px] text-muted">
        Enter — отправить · Shift+Enter — новая строка
      </div>
    </div>
  );
}
