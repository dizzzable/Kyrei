import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Единственный источник стиля кнопок (Property 6): call-site передаёт
 * `variant`/`size`, а не хардкодит паддинги/цвета. Токены — из каскада index.css.
 */
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap select-none " +
    "transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/45 " +
    "disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-strong",
        secondary: "bg-elevated text-foreground hover:bg-elevated/80 border border-border-soft",
        outline: "border border-border text-secondary hover:bg-(--ui-row-hover) hover:text-foreground",
        ghost: "text-secondary hover:bg-(--ui-row-hover) hover:text-foreground",
        destructive: "bg-danger text-white hover:bg-danger/90",
        link: "text-primary underline-offset-4 hover:underline",
        text: "text-secondary hover:text-foreground",
        // Высококонтрастная круглая CTA (fg-on-bg) — как send в Hermes.
        cta: "rounded-full bg-foreground text-bg hover:bg-foreground/90 disabled:bg-foreground/30 disabled:opacity-100",
      },
      size: {
        sm: "h-7 px-2.5 text-xs",
        md: "h-8 px-3 text-[13px]",
        lg: "h-10 px-4 text-sm",
        icon: "size-8 p-0",
        "icon-sm": "size-7 p-0",
        "icon-xs": "size-6 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type = "button", ...props },
  ref,
) {
  return <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
