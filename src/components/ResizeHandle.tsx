import type { PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/utils";

interface ResizeHandleProps {
  side: "left" | "right";
  width: number;
  min: number;
  max: number;
  onChange: (width: number) => void;
}

export function ResizeHandle({ side, width, min, max, onChange }: ResizeHandleProps) {
  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const dir = side === "right" ? 1 : -1;
    const move = (ev: PointerEvent) => {
      const next = Math.min(max, Math.max(min, startW + (ev.clientX - startX) * dir));
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
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      onPointerDown={start}
      className={cn(
        "absolute inset-y-0 z-20 w-1.5 cursor-col-resize transition-colors hover:bg-primary/40",
        side === "right" ? "right-0 translate-x-1/2" : "left-0 -translate-x-1/2",
      )}
      role="separator"
      aria-orientation="vertical"
    />
  );
}
