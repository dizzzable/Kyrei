import { DropdownMenu as Primitive } from "radix-ui";
import { Check, ChevronRight } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuGroup = Primitive.Group;
export const DropdownMenuRadioGroup = Primitive.RadioGroup;
export const DropdownMenuSub = Primitive.Sub;

export const dropdownMenuRow =
  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-secondary outline-none " +
  "data-highlighted:bg-(--ui-row-hover) data-highlighted:text-foreground data-disabled:opacity-40 data-disabled:pointer-events-none";

export const DropdownMenuContent = forwardRef<
  React.ElementRef<typeof Primitive.Content>,
  React.ComponentPropsWithoutRef<typeof Primitive.Content>
>(function DropdownMenuContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "z-50 min-w-36 rounded-lg bg-elevated p-1 shadow-nous overlay-blur",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
});

export const DropdownMenuItem = forwardRef<
  React.ElementRef<typeof Primitive.Item>,
  React.ComponentPropsWithoutRef<typeof Primitive.Item>
>(function DropdownMenuItem({ className, ...props }, ref) {
  return <Primitive.Item ref={ref} className={cn(dropdownMenuRow, className)} {...props} />;
});

export const DropdownMenuRadioItem = forwardRef<
  React.ElementRef<typeof Primitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof Primitive.RadioItem>
>(function DropdownMenuRadioItem({ className, children, ...props }, ref) {
  return (
    <Primitive.RadioItem ref={ref} className={cn(dropdownMenuRow, "justify-between", className)} {...props}>
      <span className="truncate">{children}</span>
      <Primitive.ItemIndicator>
        <Check className="size-3.5 shrink-0 text-foreground" />
      </Primitive.ItemIndicator>
    </Primitive.RadioItem>
  );
});

export const DropdownMenuSubTrigger = forwardRef<
  React.ElementRef<typeof Primitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof Primitive.SubTrigger> & { hideChevron?: boolean }
>(function DropdownMenuSubTrigger({ className, children, hideChevron, ...props }, ref) {
  return (
    <Primitive.SubTrigger ref={ref} className={cn(dropdownMenuRow, "data-[state=open]:bg-(--ui-row-hover)", className)} {...props}>
      {children}
      {!hideChevron && <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted" />}
    </Primitive.SubTrigger>
  );
});

export const DropdownMenuSubContent = forwardRef<
  React.ElementRef<typeof Primitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof Primitive.SubContent>
>(function DropdownMenuSubContent({ className, sideOffset = 4, ...props }, ref) {
  return (
    <Primitive.Portal>
      <Primitive.SubContent
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "z-50 min-w-40 rounded-lg bg-elevated p-1 shadow-nous overlay-blur",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
});

export function DropdownMenuLabel({ className, ...props }: React.ComponentPropsWithoutRef<typeof Primitive.Label>) {
  return (
    <Primitive.Label
      className={cn("px-2 py-1 text-[0.62rem] font-semibold uppercase tracking-wider text-muted", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({ className, ...props }: React.ComponentPropsWithoutRef<typeof Primitive.Separator>) {
  return <Primitive.Separator className={cn("my-1 h-px bg-border-soft", className)} {...props} />;
}
