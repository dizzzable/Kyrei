import { Check, ChevronDown, Compass, Hammer, SearchCode, Sparkles, Wand2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  dropdownMenuRow,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import type { CodingMode } from "@/lib/coding-mode";
import { CODING_MODE_IDS } from "@/lib/coding-mode";

const MODE_ICONS: Record<CodingMode, typeof Sparkles> = {
  auto: Sparkles,
  plan: Compass,
  build: Hammer,
  polish: Wand2,
  deepreep: SearchCode,
};

interface ModePillProps {
  mode: CodingMode;
  disabled?: boolean;
  onChange: (mode: CodingMode) => void;
}

export function ModePill({ mode, disabled, onChange }: ModePillProps) {
  const { t } = useI18n();
  const Icon = MODE_ICONS[mode] ?? Sparkles;
  const label = t(`chat.mode.${mode}` as const);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "composer-tool inline-flex h-7 max-w-[9.5rem] items-center gap-1 rounded-md px-1.5 text-[11px] text-muted transition-colors",
            "hover:text-foreground data-[state=open]:bg-(--ui-row-active) data-[state=open]:text-foreground",
            "disabled:pointer-events-none disabled:opacity-45",
          )}
          title={t("chat.mode.pickerTitle")}
          aria-label={t("chat.mode.pickerTitle")}
        >
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate font-medium">{label}</span>
          <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-64">
        <DropdownMenuLabel>{t("chat.mode.pickerTitle")}</DropdownMenuLabel>
        {CODING_MODE_IDS.map((id) => {
          const ItemIcon = MODE_ICONS[id];
          return (
            <DropdownMenuItem
              key={id}
              className={cn(dropdownMenuRow, "items-start gap-2 py-2")}
              onSelect={(event) => {
                event.preventDefault();
                onChange(id);
              }}
            >
              <ItemIcon className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
                  {t(`chat.mode.${id}` as const)}
                  {id === mode ? <Check className="size-3 text-primary" aria-hidden /> : null}
                </span>
                <span className="mt-0.5 block text-[10.5px] leading-4 text-muted">
                  {t(`chat.mode.${id}.hint` as const)}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
