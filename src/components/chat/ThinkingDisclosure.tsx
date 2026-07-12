import { useEffect, useRef, useState } from "react";
import { DisclosureRow } from "@/components/ui";
import { Markdown } from "@/components/Markdown";
import { cn } from "@/lib/utils";

/**
 * Reasoning block: collapsible "Размышление" with a live timer + shimmer while
 * streaming, auto-opens during the run and auto-collapses when done. Empty
 * reasoning renders nothing.
 */
export function ThinkingDisclosure({ text, pending }: { text: string; pending?: boolean }) {
  // null = defer to streaming default (open while pending); first toggle wins.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(Date.now());

  useEffect(() => {
    if (!pending) return;
    startRef.current = Date.now();
    setElapsed(0);
    const id = window.setInterval(() => setElapsed((Date.now() - startRef.current) / 1000), 200);
    return () => window.clearInterval(id);
  }, [pending]);

  if (!text.trim() && !pending) return null;
  const open = userOpen ?? Boolean(pending);

  return (
    <div className="my-1.5 text-[13px] text-muted">
      <DisclosureRow open={open} onToggle={() => setUserOpen(!open)}>
        <span className={cn("text-[12px] font-medium text-secondary", pending && "shimmer")}>Размышление</span>
        {pending && <span className="font-mono text-[10.5px] tabular-nums text-muted">{elapsed.toFixed(1)}s</span>}
      </DisclosureRow>
      {open && text.trim() && (
        <div className="mt-0.5 border-l-2 border-border-soft pl-3 text-[12.5px] italic opacity-80">
          <Markdown text={text} />
        </div>
      )}
    </div>
  );
}
