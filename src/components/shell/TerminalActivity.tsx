import { CircleCheck, CircleX, LoaderCircle, TerminalSquare } from "lucide-react";

import { useI18n } from "@/i18n";
import type { ChatMessage, ToolPart } from "@/lib/types";
import { cn } from "@/lib/utils";

function recentTools(messages: ChatMessage[]): ToolPart[] {
  return messages
    .flatMap((message) => message.parts)
    .filter((part): part is ToolPart => part.type === "tool")
    .slice(-8)
    .reverse();
}

export function TerminalActivity({ messages, streaming }: { messages: ChatMessage[]; streaming: boolean }) {
  const { t } = useI18n();
  const tools = recentTools(messages);

  return (
    <section className="terminal-activity flex h-full min-h-0 flex-col bg-bg">
      <div className="rail-section-header">
        <TerminalSquare size={13} aria-hidden />
        <span>{t("shell.terminal.title")}</span>
        <span className={cn("ml-auto size-1.5 rounded-full", streaming ? "animate-pulse bg-primary" : "bg-faint")} aria-hidden />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 font-mono text-[10.5px] leading-5">
        <div className="flex items-center gap-2 text-muted">
          <span className="text-primary" aria-hidden>›</span>
          <span>{streaming ? t("shell.terminal.running") : t("shell.terminal.idle")}</span>
        </div>
        {tools.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 px-1 text-[9px] uppercase tracking-[0.12em] text-faint">{t("shell.terminal.recent")}</div>
            {tools.map((tool) => {
              const failed = Boolean(tool.error);
              const state = tool.running
                ? t("shell.terminal.active")
                : failed
                  ? t("shell.terminal.failed")
                  : t("shell.terminal.complete");
              const Icon = tool.running ? LoaderCircle : failed ? CircleX : CircleCheck;
              return (
                <div key={tool.toolCallId} className="group flex items-start gap-2 rounded px-1 py-0.5 hover:bg-(--ui-row-hover)">
                  <Icon
                    size={11}
                    className={cn(
                      "mt-1 shrink-0",
                      tool.running && "animate-spin text-primary",
                      failed && "text-danger",
                      !tool.running && !failed && "text-success",
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-secondary">{tool.name}</span>
                  <span className="shrink-0 text-[9px] text-faint">{state}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
