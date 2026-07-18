import { useEffect, useRef, useState } from "react";
import { DisclosureRow } from "@/components/ui";
import { Markdown } from "@/components/Markdown";
import { sanitizeAssistantDisplayText } from "@/lib/assistant-display";
import type { ReasoningPart } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

/**
 * Segment-local reasoning disclosure. It only streams while this exact
 * reasoning part is open, so one completed segment no longer depends on the
 * whole assistant message's pending flag.
 */
export function ThinkingDisclosure({ part }: { part: ReasoningPart }) {
  const { t } = useI18n();
  const text = sanitizeAssistantDisplayText(part.text);
  const pending = part.state === "streaming";
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(part.startedAt ?? Date.now());

  useEffect(() => {
    if (!pending) {
      setElapsed(part.startedAt ? Math.max(0, (Date.now() - part.startedAt) / 1000) : 0);
      return;
    }
    startRef.current = part.startedAt ?? Date.now();
    setElapsed(Math.max(0, (Date.now() - startRef.current) / 1000));
    const id = window.setInterval(() => setElapsed((Date.now() - startRef.current) / 1000), 200);
    return () => window.clearInterval(id);
  }, [pending, part.id, part.startedAt]);

  if (!text.trim() && !pending) return null;
  const open = userOpen ?? pending;

  return (
    <div className="my-1.5 text-[13px] text-muted">
      <DisclosureRow open={open} onToggle={() => setUserOpen(!open)}>
        <span className={cn("text-[12px] font-medium text-secondary", pending && "shimmer")}>
          {t("chat.thinking.label")}
        </span>
        {pending && (
          <span className="font-mono text-[10.5px] tabular-nums text-muted">
            {t("chat.thinking.elapsed", { seconds: elapsed.toFixed(1) })}
          </span>
        )}
      </DisclosureRow>
      {open && text.trim() && (
        <div className="mt-0.5 border-l-2 border-border-soft pl-3 text-[12.5px] italic opacity-80">
          <Markdown text={text} />
        </div>
      )}
    </div>
  );
}
