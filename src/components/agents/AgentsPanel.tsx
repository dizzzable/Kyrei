import { AlertCircle, Bot, CheckCircle2, CircleDashed, LoaderCircle, RotateCcw, Square, TriangleAlert, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useI18n } from "@/i18n";
import { gateway } from "@/lib/gateway";
import { formatCompactTokens, formatElapsed } from "@/lib/status-metrics";
import type { SubagentRun } from "@/lib/types";
import { cn } from "@/lib/utils";

export function AgentsPanel({ runs, now }: { runs: readonly SubagentRun[]; now: number }) {
  const { t } = useI18n();
  const [acting, setActing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const sorted = [...runs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 24);

  const runAction = async (run: SubagentRun, action: "retry" | "resume" | "cancel") => {
    setActing(`${run.id}:${action}`);
    setActionError(null);
    try {
      if (action === "retry") await gateway.retryAgent(run.id);
      else if (action === "resume") await gateway.resumeAgent(run.id);
      else await gateway.cancelAgent(run.id);
      window.dispatchEvent(new CustomEvent("kyrei:status-refresh"));
    } catch {
      setActionError(t("shell.status.agentActionFailed"));
    } finally {
      setActing(null);
    }
  };

  return (
    <div className="w-[min(23rem,calc(100vw-1rem))] p-2">
      <div className="flex items-center gap-2 border-b border-border-soft px-2 pb-2">
        <Bot className="size-3.5 text-secondary" aria-hidden />
        <span className="text-[12px] font-semibold text-foreground">{t("shell.status.agents")}</span>
        {runs.length > 0 && <span className="ml-auto font-mono text-[9px] text-muted">{runs.length}</span>}
      </div>
      {actionError ? <p className="mx-2 mt-2 rounded border border-danger/25 bg-danger/8 px-2 py-1.5 text-[9.5px] text-danger" role="alert">{actionError}</p> : null}
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
                      {(run.evidenceCount ?? 0) > 0 && <span>{t("shell.status.agentEvidence", { count: run.evidenceCount ?? 0 })}</span>}
                    </div>
                    {run.lastProgressAt ? <p className="mt-0.5 text-[8.5px] text-faint">{t("shell.status.agentLastProgress", { value: formatElapsed(Math.max(0, now - run.lastProgressAt)) })}</p> : null}
                    {(run.providerId || run.model) ? <p className="mt-0.5 truncate font-mono text-[8.5px] text-faint">{[run.providerId, run.model].filter(Boolean).join(" / ")}</p> : null}
                    {(run.currentTool || run.summary || run.error) && (
                      <p className={cn("mt-1 line-clamp-2 text-[9.5px] leading-4 text-muted", run.error && "text-danger")}>
                        {run.currentTool || run.summary || run.error}
                      </p>
                    )}
                    {(run.actions?.retry || run.actions?.resume || run.actions?.cancel) ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {run.actions.retry ? <ActionButton disabled={acting !== null} onClick={() => void runAction(run, "retry")}><RotateCcw className="size-3" />{t("shell.status.agentRetry")}</ActionButton> : null}
                        {run.actions.resume ? <ActionButton disabled={acting !== null} onClick={() => void runAction(run, "resume")}><RotateCcw className="size-3" />{t("shell.status.agentResume")}</ActionButton> : null}
                        {run.actions.cancel ? <ActionButton disabled={acting !== null} onClick={() => void runAction(run, "cancel")}><Square className="size-3" />{t("shell.status.agentCancel")}</ActionButton> : null}
                      </div>
                    ) : null}
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
    case "recovering": return <RotateCcw className={`${common} animate-spin text-warning`} aria-hidden />;
    case "partial": return <TriangleAlert className={`${common} text-warning`} aria-hidden />;
    case "completed": return <CheckCircle2 className={`${common} text-success`} aria-hidden />;
    case "failed": return <XCircle className={`${common} text-danger`} aria-hidden />;
    case "interrupted": return <AlertCircle className={`${common} text-warning`} aria-hidden />;
    default: return <CircleDashed className={`${common} text-muted`} aria-hidden />;
  }
}

function statusLabel(status: SubagentRun["status"], t: ReturnType<typeof useI18n>["t"]): string {
  switch (status) {
    case "running": return t("shell.status.agentRunning");
    case "recovering": return t("shell.status.agentRecovering");
    case "partial": return t("shell.status.agentPartial");
    case "completed": return t("shell.status.agentCompleted");
    case "failed": return t("shell.status.agentFailed");
    case "interrupted": return t("shell.status.agentInterrupted");
    default: return t("shell.status.agentQueued");
  }
}

function ActionButton({ children, disabled, onClick }: { children: ReactNode; disabled: boolean; onClick: () => void }) {
  return <button type="button" disabled={disabled} onClick={onClick} className="inline-flex h-6 items-center gap-1 rounded border border-border-soft px-1.5 text-[9px] text-secondary hover:bg-(--ui-row-hover) disabled:opacity-45">{children}</button>;
}
