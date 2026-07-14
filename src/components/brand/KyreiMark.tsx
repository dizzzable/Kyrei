import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export type KyreiMarkSize = "sm" | "md" | "lg" | "xl";

/** The official Kyrei glyph, kept on its original 150×150 coordinate system. */
export function KyreiGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 150 150"
      fill="none"
      focusable="false"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
    >
      <g fill="currentColor">
        <polygon points="74.9 3.5 47.3 30.8 64.6 47.9 79.3 63.2 90.5 51.9 78.7 40.5 69.5 30.9 74.9 25.5 80.1 30.9 75.7 35.6 86.7 45.8 102.5 30.8" />
        <path d="m108 37-32.3 31.7 10.8 10.8 21.5-21 5.4 5.5-5.4 5.5-4.7-4.5-11 10.8 15.6 15.4 28.2-27.1-28.1-27.8" />
        <polygon points="41.7 36.3 14 64.1 41.7 91.2 57.8 75.2 74 59.2 63.3 47.5 41.7 69.6 36.3 64.1 41.7 58.5 46.5 63.3 57.7 51.8" />
        <polyline points="55.5 88.9 63.3 81.2 74 92.1 70.8 94.9 70.8 150.2 55.5 150.2" />
        <polygon points="59.3 75.8 78.6 95 78.6 150.2 94.4 150.2 94.3 88.8 70.2 64.8" />
      </g>
    </svg>
  );
}

export function KyreiMark({
  size = "md",
  className,
  ...props
}: Omit<HTMLAttributes<HTMLSpanElement>, "children"> & { size?: KyreiMarkSize }) {
  return (
    <span
      {...props}
      className={cn("kyrei-mark", `kyrei-mark-${size}`, className)}
      aria-hidden="true"
    >
      <KyreiGlyph />
    </span>
  );
}
