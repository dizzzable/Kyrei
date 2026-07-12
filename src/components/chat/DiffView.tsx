import { useMemo } from "react";
import { parseDiff, type DiffKind } from "@/lib/diff";
import { cn } from "@/lib/utils";

const TINT: Record<DiffKind, string> = {
  add: "border-success bg-success/12 text-success",
  remove: "border-danger bg-danger/12 text-danger",
  context: "border-transparent text-muted",
};

/** Cursor-style unified diff: tint + 2px gutter, marker/gutter stripped. */
export function DiffView({ diff, className }: { diff: string; className?: string }) {
  const lines = useMemo(() => parseDiff(diff), [diff]);
  return (
    <pre
      className={cn(
        "max-h-72 overflow-auto bg-black/25 font-mono text-[11.5px] leading-relaxed",
        className,
      )}
    >
      {lines.map((line, i) => (
        <span
          key={i}
          className={cn("block whitespace-pre-wrap break-all border-l-2 px-3", TINT[line.kind])}
        >
          {line.text || " "}
        </span>
      ))}
    </pre>
  );
}
