import { Check } from "lucide-react";
import { applyTheme, THEMES, useThemeId, type ThemeId } from "@/lib/theme";
import { cn } from "@/lib/utils";

// A tiny swatch preview per theme so cards read at a glance without applying.
const PREVIEW: Record<ThemeId, { bg: string; fg: string; accent: string }> = {
  dark: { bg: "#000000", fg: "#fafafa", accent: "#fafafa" },
  light: { bg: "#fcfcfc", fg: "#000000", accent: "#000000" },
  midnight: { bg: "#0a0e1a", fg: "#cdd6f4", accent: "#89b4fa" },
  ember: { bg: "#17110d", fg: "#f0e2d6", accent: "#e07a3c" },
  mono: { bg: "#101010", fg: "#eaeaea", accent: "#9a9a9a" },
  cyberpunk: { bg: "#0d0221", fg: "#f6f0ff", accent: "#ff2a6d" },
  slate: { bg: "#1a1f2b", fg: "#dde3ec", accent: "#5b9dff" },
};

export function ThemeGrid() {
  const current = useThemeId();
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
      {THEMES.map((t) => {
        const p = PREVIEW[t.id];
        const active = current === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => applyTheme(t.id)}
            aria-pressed={active}
            className={cn(
              "group relative overflow-hidden rounded-xl border p-0 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
              active ? "border-primary" : "border-border-soft hover:border-border",
            )}
          >
            <div className="flex h-16 items-center gap-2 px-3" style={{ background: p.bg }}>
              <span className="size-6 rounded-full" style={{ background: p.accent }} />
              <div className="flex-1 space-y-1">
                <span className="block h-1.5 w-3/4 rounded-full" style={{ background: p.fg, opacity: 0.85 }} />
                <span className="block h-1.5 w-1/2 rounded-full" style={{ background: p.fg, opacity: 0.45 }} />
              </div>
              {active && (
                <span className="grid size-5 place-items-center rounded-full" style={{ background: p.accent }}>
                  <Check className="size-3 text-white" />
                </span>
              )}
            </div>
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-[12px] font-medium text-foreground">{t.label}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
