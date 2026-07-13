import { AlertCircle, Bot, CheckCircle2, CircleDashed, LoaderCircle, XCircle } from "lucide-react";

import { useI18n } from "@/i18n";
import { formatCompactTokens, formatElapsed } from "@/lib/status-metrics";
import type { SubagentRun } from "@/lib/types";
import { cn } from "@/lib/utils";

export function AgentsPanel({ runs, now }: { runs: readonly SubagentRun[]; now: number }) {
  const { t } = useI18n();
  const sorted = [...runs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 24);

  return (
    <div className="w-[min(23rem,calc(100vw-1rem))] p-2">
      <div className="flex items-center gap-2 border-b border-border-soft px-2 pb-2">
        <Bot className="size-3.5 text-secondary" aria-hidden />
        <span className="text-[12px] font-semibold text-foreground">{t("shell.status.agents")}</span>
        {runs.length > 0 && <span className="ml-auto font-mono text-[9px] text-muted">{runs.length}</span>}
      </div>
      {sorted.length === 0 ? (
        <div className="px-2 py-5 text-center">
          <div className="text-[12px] font-medium text-secondary">{t("shell.status.agentsEmpty")}</div>
          <p className="mx-auto mt-1 max-w-[19rem] text-[10px] leading-4 text-muted">{t("shell.status.agentsEmptyHint")}</p>
        </div>
      ) : (
        <div className="max-h-80 space-y-1 overflow-y-auto py-1.5">
          {sorted.map((run) => {
            const tokens = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
            const durationMs = run.durationSeconds != null
              ? run.durationSeconds * 1000
              : Math.max(0, now - run.startedAt);
            return (
              <div key={run.id} className="rounded-md px-2 py-2 hover:bg-(--ui-row-hover)">
                <div className="flex min-w-0 items-start gap-2">
                  <AgentStatusIcon status={run.status} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-medium text-secondary">{run.goal}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[8.5px] text-muted">
                      <span>{statusLabel(run.status, t)}</span>
                      <span>{formatElapsed(durationMs)}</span>
                      {tokens > 0 && <span>{t("shell.status.agentTokens", { count: formatCompactTokens(tokens) })}</span>}
                      {(run.toolCount ?? 0) > 0 && <span>{t("shell.status.agentTools", { count: run.toolCount ?? 0 })}</span>}
                    </div>
                    {(run.currentTool || run.summary || run.error) && (
                      <p className={cn("mt-1 line-clamp-2 text-[9.5px] leading-4 text-muted", run.error && "text-danger")}>
                        {run.currentTool || run.summary || run.error}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AgentStatusIcon({ status }: { status: SubagentRun["status"] }) {
  const common = "mt-0.5 size-3 shrink-0";
  switch (status) {
    case "running": return <LoaderCircle className={`${common} animate-spin text-primary`} aria-hidden />;
    case "completed": return <CheckCircle2 className={`${common} text-success`} aria-hidden />;
    case "failed": return <XCircle className={`${common} text-danger`} aria-hidden />;
    case "interrupted": return <AlertCircle className={`${common} text-warning`} aria-hidden />;
    default: return <CircleDashed className={`${common} text-muted`} aria-hidden />;
  }
}

function statusLabel(status: SubagentRun["status"], t: ReturnType<typeof useI18n>["t"]): string {
  switch (status) {
    case "running": return t("shell.status.agentRunning");
    case "completed": return t("shell.status.agentCompleted");
    case "failed": return t("shell.status.agentFailed");
    case "interrupted": return t("shell.status.agentInterrupted");
    default: return t("shell.status.agentQueued");
  }
}
