import { useState } from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import type { ToolPart } from "@/lib/types";
import { buildToolView } from "@/lib/tool-view";
import { DisclosureRow } from "@/components/ui";
import { ToolIcon } from "./chat/ToolIcon";
import { DiffView } from "./chat/DiffView";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

function StatusGlyph({ status }: { status: "running" | "success" | "error" }) {
  if (status === "running") return <Loader2 size={13} className="animate-spin text-primary" />;
  if (status === "error") return <AlertCircle size={13} className="text-danger" />;
  return <CheckCircle2 size={13} className="text-success/80" />;
}

export function ToolRow({ part }: { part: ToolPart }) {
  const { t } = useI18n();
  const view = buildToolView(part, t);
  const hasDiff = Boolean(view.inlineDiff);
  const expandable = hasDiff || Boolean(view.detail);
  const [open, setOpen] = useState(hasDiff);

  return (
    <div
      className={cn(
        "my-1 overflow-hidden rounded-[5px] text-[11px]",
        open && "border border-border-soft bg-surface/50",
      )}
    >
      <div className={cn(open && "border-b border-border-soft px-2 py-1")}>
        <DisclosureRow open={open} onToggle={expandable ? () => setOpen((o) => !o) : undefined}>
          <span className="grid size-3.5 place-items-center">
            {view.status === "success" ? (
              <ToolIcon name={view.icon} className="text-muted" />
            ) : (
              <StatusGlyph status={view.status} />
            )}
          </span>
          <span className="font-medium text-secondary">{view.title}</span>
          {view.subtitle && (
            <span className="truncate font-mono text-[11px] text-muted">{view.subtitle}</span>
          )}
          {view.diffStats && (view.diffStats.added > 0 || view.diffStats.removed > 0) && (
            <span className="flex shrink-0 items-center gap-1 font-mono text-[10px]">
              {view.diffStats.added > 0 && <span className="text-success">+{view.diffStats.added}</span>}
              {view.diffStats.removed > 0 && <span className="text-danger">−{view.diffStats.removed}</span>}
            </span>
          )}
          {view.durationLabel && (
            <span className="ml-auto shrink-0 font-mono text-[10px] text-muted">{view.durationLabel}</span>
          )}
        </DisclosureRow>
      </div>
      {part.running && part.progress && (
        <div className="truncate px-3 py-1 font-mono text-[11px] text-muted">{part.progress}</div>
      )}
      {open && hasDiff && <DiffView diff={view.inlineDiff} className="-mx-px" />}
      {open && !hasDiff && view.detail && (
        <pre
          className={cn(
            "max-h-56 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed",
            view.status === "error" ? "text-danger" : "text-secondary",
          )}
        >
          {view.detail}
        </pre>
      )}
    </div>
  );
}
