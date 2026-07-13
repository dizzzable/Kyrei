import { Search, X } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

export const SearchField = forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    className?: string;
    "aria-label"?: string;
  }
>(function SearchField({ value, onChange, placeholder, className, ...rest }, ref) {
  const { t } = useI18n();
  return (
    <div className={cn("relative flex items-center", className)}>
      <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted" aria-hidden />
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 w-full rounded-md border border-border bg-surface pl-8 pr-7 text-[13px] text-foreground placeholder:text-muted outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/25"
        {...rest}
      />
      {value && (
        <button
          type="button"
          aria-label={t("common.clear")}
          onClick={() => onChange("")}
          className="absolute right-1.5 grid size-5 place-items-center rounded text-muted hover:bg-(--ui-row-hover) hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
});
