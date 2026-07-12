import { useEffect, useRef, useState } from "react";
import { Check, Palette } from "lucide-react";
import { applyTheme, getTheme, THEMES, type ThemeId } from "@/lib/theme";
import { cn } from "@/lib/utils";

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<ThemeId>(getTheme());
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const pick = (id: ThemeId) => { applyTheme(id); setTheme(id); setOpen(false); };
  const current = THEMES.find(t => t.id === theme);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-secondary transition-colors hover:bg-white/[0.04]"
      >
        <Palette size={16} />
        Тема: {current?.label}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-full overflow-hidden rounded-lg border border-border bg-elevated py-1 shadow-lg">
          {THEMES.map(t => (
            <button
              key={t.id}
              onClick={() => pick(t.id)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-white/[0.05]",
                t.id === theme ? "text-foreground" : "text-secondary",
              )}
            >
              <span className="flex-1">{t.label}</span>
              {t.id === theme && <Check size={14} className="text-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
