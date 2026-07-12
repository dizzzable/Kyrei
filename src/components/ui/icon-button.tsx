import { forwardRef } from "react";
import { Button, type ButtonProps } from "./button";
import { Tip } from "./tooltip";

export interface IconButtonProps extends Omit<ButtonProps, "size"> {
  /** Tooltip label (also used as aria-label if none given). */
  tip?: React.ReactNode;
  size?: "icon" | "icon-sm" | "icon-xs";
  side?: "top" | "bottom" | "left" | "right";
}

/** Иконочная кнопка с опциональным тултипом. Дефолт вариант — ghost. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { tip, side = "top", variant = "ghost", size = "icon", "aria-label": ariaLabel, ...props },
  ref,
) {
  const label = ariaLabel ?? (typeof tip === "string" ? tip : undefined);
  const btn = <Button ref={ref} variant={variant} size={size} aria-label={label} {...props} />;
  return tip ? (
    <Tip label={tip} side={side}>
      {btn}
    </Tip>
  ) : (
    btn
  );
});
