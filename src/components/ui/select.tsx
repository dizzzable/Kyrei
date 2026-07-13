import { Select as Primitive } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const Select = Primitive.Root;
export const SelectValue = Primitive.Value;

export const SelectTrigger = forwardRef<
  React.ElementRef<typeof Primitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof Primitive.Trigger>
>(function SelectTrigger({ className, children, ...props }, ref) {
  return (
    <Primitive.Trigger
      ref={ref}
      className={cn(
        "flex h-8 items-center justify-between gap-2 rounded-md border border-border bg-surface px-2.5 text-[13px] text-foreground outline-none",
        "focus:border-primary/60 focus:ring-2 focus:ring-primary/25 data-placeholder:text-muted",
        className,
      )}
      {...props}
    >
      {children}
      <Primitive.Icon asChild>
        <ChevronDown className="size-3.5 shrink-0 text-muted" />
      </Primitive.Icon>
    </Primitive.Trigger>
  );
});

export const SelectContent = forwardRef<
  React.ElementRef<typeof Primitive.Content>,
  React.ComponentPropsWithoutRef<typeof Primitive.Content>
>(function SelectContent({ className, children, position = "popper", ...props }, ref) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        ref={ref}
        position={position}
        sideOffset={6}
        className={cn(
          "z-[220] max-h-72 min-w-32 overflow-hidden rounded-lg bg-elevated p-1 shadow-nous overlay-blur",
          position === "popper" && "w-(--radix-select-trigger-width)",
          className,
        )}
        {...props}
      >
        <Primitive.Viewport>{children}</Primitive.Viewport>
      </Primitive.Content>
    </Primitive.Portal>
  );
});

export const SelectItem = forwardRef<
  React.ElementRef<typeof Primitive.Item>,
  React.ComponentPropsWithoutRef<typeof Primitive.Item>
>(function SelectItem({ className, children, ...props }, ref) {
  return (
    <Primitive.Item
      ref={ref}
      className={cn(
        "flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[13px] text-secondary outline-none",
        "data-highlighted:bg-(--ui-row-hover) data-highlighted:text-foreground",
        className,
      )}
      {...props}
    >
      <Primitive.ItemText>{children}</Primitive.ItemText>
      <Primitive.ItemIndicator>
        <Check className="size-3.5 text-primary" />
      </Primitive.ItemIndicator>
    </Primitive.Item>
  );
});
