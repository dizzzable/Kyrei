import { AlertTriangle } from "lucide-react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

interface ExperimentalRiskBadgeProps {
  className?: string;
  /** compact = icon + short label; full = longer ribbon */
  size?: "sm" | "md";
}

/** Visible ⚠️ mark for experimental / at-your-own-risk surfaces. */
export function ExperimentalRiskBadge({ className, size = "sm" }: ExperimentalRiskBadgeProps) {
  const { t } = useI18n();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/10 font-medium text-warning",
        size === "sm" ? "px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide" : "px-2 py-1 text-[10.5px]",
        className,
      )}
      title={t("settings.experimental.badgeTitle")}
    >
      <AlertTriangle className={size === "sm" ? "size-3" : "size-3.5"} aria-hidden />
      {t("settings.experimental.badge")}
    </span>
  );
}
