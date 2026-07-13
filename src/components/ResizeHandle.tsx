import type { PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/utils";

interface ResizeHandleProps {
  side: "left" | "right" | "top" | "bottom";
  value?: number;
  /** Backward-compatible alias for vertical rail widths. */
  width?: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  label: string;
}

export function ResizeHandle({ side, value, width, min, max, onChange, label }: ResizeHandleProps) {
  const current = value ?? width ?? min;
  const horizontal = side === "left" || side === "right";

  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startPosition = horizontal ? event.clientX : event.clientY;
    const startValue = current;
    const direction = side === "right" || side === "bottom" ? 1 : -1;

    const move = (nextEvent: PointerEvent) => {
      const position = horizontal ? nextEvent.clientX : nextEvent.clientY;
      const next = Math.min(max, Math.max(min, startValue + (position - startPosition) * direction));
      onChange(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      onPointerDown={start}
      className={cn(
        "absolute z-30 transition-colors hover:bg-primary/50",
        horizontal ? "inset-y-0 w-1.5 cursor-col-resize" : "inset-x-0 h-1.5 cursor-row-resize",
        side === "right" && "right-0 translate-x-1/2",
        side === "left" && "left-0 -translate-x-1/2",
        side === "bottom" && "bottom-0 translate-y-1/2",
        side === "top" && "top-0 -translate-y-1/2",
      )}
      role="separator"
      aria-label={label}
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(current)}
    />
  );
}
