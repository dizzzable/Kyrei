import { cn } from "@/lib/utils";

export interface SegmentOption<T extends string> {
  value: T;
  label: React.ReactNode;
  title?: string;
}

/** Сегментированный переключатель (Light/Dark/System, Product/Technical, …). */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  className,
  size = "md",
  disabled = false,
}: {
  value: T;
  options: SegmentOption<T>[];
  onChange: (v: T) => void;
  className?: string;
  size?: "sm" | "md";
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      className={cn("inline-flex items-center gap-0.5 rounded-lg border border-border-soft bg-surface p-0.5", className)}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={cn(
              "rounded-md font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
              "disabled:cursor-not-allowed disabled:opacity-45",
              size === "sm" ? "px-2 py-1 text-[11px]" : "px-2.5 py-1 text-xs",
              active ? "bg-elevated text-foreground shadow-sm" : "text-muted hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
