import { useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronRight, Loader2, Terminal } from "lucide-react";
import type { ToolPart } from "@/lib/types";
import { cn } from "@/lib/utils";

const TOOL_LABEL: Record<string, string> = {
  list_dir: "Список файлов",
  read_file: "Чтение файла",
  write_file: "Запись файла",
  run_command: "Команда",
};

function DiffView({ diff }: { diff: string }) {
  const lines = useMemo(() => diff.split("\n"), [diff]);
  return (
    <div className="max-h-72 overflow-auto border-t border-border-soft bg-black/25 font-mono text-[11.5px] leading-relaxed">
      {lines.map((line, i) => {
        const kind = line[0] === "+" ? "add" : line[0] === "-" ? "del" : "ctx";
        const text = kind === "ctx" ? line : line.slice(1);
        return (
          <div
            key={i}
            className={cn(
              "whitespace-pre-wrap break-all border-l-2 px-3",
              kind === "add" && "border-success bg-success/10 text-[#8ee0bb]",
              kind === "del" && "border-danger bg-danger/10 text-[#f2a6ad]",
              kind === "ctx" && "border-transparent text-muted",
            )}
          >
            {text || " "}
          </div>
        );
      })}
    </div>
  );
}

export function ToolRow({ part }: { part: ToolPart }) {
  const hasDiff = Boolean(part.inlineDiff);
  const [open, setOpen] = useState(hasDiff);
  const label = TOOL_LABEL[part.name] || part.name;
  const arg =
    part.args && typeof part.args === "object"
      ? ((part.args as any).path || (part.args as any).command || "")
      : "";

  const stats = useMemo(() => {
    if (!part.inlineDiff) return null;
    let added = 0, removed = 0;
    for (const line of part.inlineDiff.split("\n")) {
      if (line[0] === "+") added++;
      else if (line[0] === "-") removed++;
    }
    return { added, removed };
  }, [part.inlineDiff]);

  const expandable = hasDiff || Boolean(part.result || part.error);

  return (
    <div className="my-1.5 overflow-hidden rounded-md border border-border-soft bg-surface/60 text-[12.5px]">
      <button
        onClick={() => expandable && setOpen(o => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-secondary transition-colors hover:bg-white/[0.03]"
      >
        <span className="grid size-4 place-items-center">
          {part.running ? <Loader2 size={14} className="animate-spin text-primary" />
            : part.error ? <AlertCircle size={14} className="text-danger" />
            : <CheckCircle2 size={14} className="text-success/80" />}
        </span>
        <Terminal size={13} className="shrink-0 text-muted" />
        <span className="font-medium">{label}</span>
        {arg && <span className="truncate font-mono text-[11.5px] text-muted">{String(arg)}</span>}
        {stats && (stats.added > 0 || stats.removed > 0) && (
          <span className="flex shrink-0 items-center gap-1 font-mono text-[10.5px]">
            {stats.added > 0 && <span className="text-success">+{stats.added}</span>}
            {stats.removed > 0 && <span className="text-danger">−{stats.removed}</span>}
          </span>
        )}
        {typeof part.durationS === "number" && !part.running && (
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted">{part.durationS.toFixed(1)}s</span>
        )}
        {expandable && (
          <ChevronRight size={13} className={cn("shrink-0 text-muted transition-transform", open && "rotate-90", typeof part.durationS !== "number" && "ml-auto")} />
        )}
      </button>
      {open && hasDiff && <DiffView diff={part.inlineDiff!} />}
      {open && !hasDiff && (part.result || part.error) && (
        <pre className="max-h-56 overflow-auto border-t border-border-soft bg-black/25 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-secondary">
          {part.error ? `Ошибка: ${part.error}\n` : ""}
          {part.result}
        </pre>
      )}
    </div>
  );
}
