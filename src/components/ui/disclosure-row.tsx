import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Раскрываемая строка (заголовок с кареткой + trailing/action-слоты). Основа
 * для tool-строк, reasoning-блока, секций сайдбара. Каретка не показывается,
 * если `onToggle` не задан (нераскрываемая строка).
 */
export function DisclosureRow({
  open,
  onToggle,
  children,
  trailing,
  action,
  className,
}: {
  open: boolean;
  onToggle?: () => void;
  children: ReactNode;
  trailing?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const interactive = Boolean(onToggle);
  return (
    <div
      className={cn(
        "group/disclosure-row flex min-w-0 items-center gap-1.5 rounded-md py-0.5 pr-1 text-left",
        interactive && "cursor-pointer hover:bg-(--ui-row-hover)",
        className,
      )}
      onClick={onToggle}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggle?.();
              }
            }
          : undefined
      }
      aria-expanded={interactive ? open : undefined}
    >
      {interactive && (
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-muted transition-transform", open && "rotate-90")}
          aria-hidden
        />
      )}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">{children}</span>
      {trailing}
      {action}
    </div>
  );
}
