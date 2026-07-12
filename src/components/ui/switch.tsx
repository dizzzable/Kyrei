import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

export function Switch({
  checked,
  onCheckedChange,
  size = "md",
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  size?: "xs" | "md";
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const dims = size === "xs" ? "h-4 w-7" : "h-5 w-9";
  const thumb = size === "xs" ? "size-3 data-[state=checked]:translate-x-3" : "size-4 data-[state=checked]:translate-x-4";
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        "peer inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent p-0.5 transition-colors",
        "outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:cursor-not-allowed disabled:opacity-50",
        "bg-elevated data-[state=checked]:bg-primary",
        dims,
        className,
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn("pointer-events-none block rounded-full bg-white shadow-sm transition-transform translate-x-0", thumb)}
      />
    </SwitchPrimitive.Root>
  );
}
