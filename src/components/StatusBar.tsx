import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  Bot,
  Clock3,
  Command,
  GitBranch,
  Hash,
  LoaderCircle,
  Sparkles,
  Terminal,
  Zap,
} from "lucide-react";

import { AgentsPanel } from "@/components/agents/AgentsPanel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui";
import { useI18n } from "@/i18n";
import { shouldHighlightUpdate, updateAttentionKey } from "@/lib/app-update";
import { desktopUpdate, type DesktopUpdateStatus } from "@/lib/desktop";
import { contextMetric, formatCompactTokens, formatElapsed } from "@/lib/status-metrics";
import type { GatewayStatus, SubagentRun } from "@/lib/types";
import { cn } from "@/lib/utils";

const BUILD_SHA = typeof __COMMIT_SHA__ === "string" ? __COMMIT_SHA__ : "";

export interface StatusBarProps {
  status: GatewayStatus | null;
  connected: boolean;
  streaming: boolean;
  tokens?: number | null;
  contextWindow?: number | null;
  sessionStartedAt?: string;
  turnStartedAt?: number | null;
  agents: readonly SubagentRun[];
  turbo: boolean;
  developerOpen: boolean;
  onOpenPalette: () => void;
  onOpenCron: () => void;
  onOpenMissions: () => void;
  onOpenProviders: () => void;
  onOpenAbout: () => void;
  onToggleTurbo: () => void;
  onToggleDeveloper: () => void;
}

export function StatusBar({
  status,
  connected,
  streaming,
  tokens,
  contextWindow,
  sessionStartedAt,
  turnStartedAt,
  agents,
  turbo,
  developerOpen,
  onOpenPalette,
  onOpenCron,
  onOpenMissions,
  onOpenProviders,
  onOpenAbout,
  onToggleTurbo,
  onToggleDeveloper,
}: StatusBarProps) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now());
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus | null>(null);
  const [showUpdateNotice, setShowUpdateNotice] = useState(false);
  const lastUpdateNotice = useRef<string | undefined>(undefined);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!desktopUpdate.available()) return;
    let cancelled = false;
    const stop = desktopUpdate.onStatus((next) => {
      if (!cancelled) setUpdateStatus(next);
    });
    void desktopUpdate.getStatus().then((next) => {
      if (!cancelled) setUpdateStatus(next);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  const activeAgents = agents.filter((run) => run.status === "running" || run.status === "queued" || run.status === "recovering").length;
  const failedAgents = agents.filter((run) => run.status === "failed" || run.status === "interrupted" || run.status === "partial").length;
  const activeMissions = status?.pipelines?.active ?? 0;
  const metric = useMemo(() => contextMetric(tokens ?? 0, contextWindow ?? 0), [tokens, contextWindow]);
  const sessionTime = sessionStartedAt ? Date.parse(sessionStartedAt) : Number.NaN;
  const gatewayReady = connected && Boolean(status?.providerReady);
  const gatewayDetail = !connected
    ? t("shell.status.gatewayOffline")
    : gatewayReady
      ? t("shell.status.gatewayReady")
      : t("shell.status.gatewayNeedsSetup");
  const updateAttention = shouldHighlightUpdate(updateStatus?.phase);
  const updateNoticeKey = updateAttentionKey(updateStatus?.phase, updateStatus?.latestVersion);
  const updateTitle = updateStatus?.phase === "downloaded"
    ? t("shell.status.updateDownloaded", { version: updateStatus.latestVersion || "?" })
    : t("shell.status.updateAvailable", { version: updateStatus?.latestVersion || "?" });

  useEffect(() => {
    if (!updateNoticeKey || lastUpdateNotice.current === updateNoticeKey) return;
    lastUpdateNotice.current = updateNoticeKey;
    setShowUpdateNotice(true);
    const timer = window.setTimeout(() => setShowUpdateNotice(false), 12_000);
    return () => window.clearTimeout(timer);
  }, [updateNoticeKey]);

  const openUpdateSettings = () => {
    setShowUpdateNotice(false);
    onOpenAbout();
  };

  return (
    <footer className="statusbar flex shrink-0 items-stretch justify-between gap-2 overflow-hidden border-t border-border-soft px-1 font-mono text-[10px] text-muted">
      <div className="flex min-w-0 items-stretch overflow-hidden">
        <StatusAction
          icon={<Command className="size-3" />}
          title={t("shell.status.commandCenter")}
          onClick={onOpenPalette}
          compact
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(STATUS_ACTION, !gatewayReady && connected && "text-warning", !connected && "text-danger")}
              title={t("shell.status.gatewayMenu")}
            >
              {gatewayReady ? <Activity className="size-3" aria-hidden /> : <AlertCircle className="size-3" aria-hidden />}
              <span>{t("shell.status.gateway")}</span>
              <span className="hidden text-faint min-[850px]:inline">{gatewayDetail}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" sideOffset={5} className="w-72 p-2">
            <GatewayPanel status={status} connected={connected} now={now} onConfigure={onOpenProviders} />
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(STATUS_ACTION, failedAgents > 0 && "text-danger", activeAgents > 0 && "text-primary")}
              title={t("shell.status.agentsOpen")}
            >
              {activeAgents > 0 ? <LoaderCircle className="size-3 animate-spin" aria-hidden /> : <Bot className="size-3" aria-hidden />}
              <span className="hidden min-[620px]:inline">{t("shell.status.agents")}</span>
              {(activeAgents > 0 || failedAgents > 0) && <span>{activeAgents || failedAgents}</span>} {/* i18n-data-ok */}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" sideOffset={5} className="p-0">
            <AgentsPanel runs={agents} now={now} />
          </DropdownMenuContent>
        </DropdownMenu>

        <StatusAction icon={<Clock3 className="size-3" />} label={t("shell.status.cron")} title={t("shell.status.cronOpen")} onClick={onOpenCron} />
        <StatusAction
          icon={<GitBranch className="size-3" />}
          label={<><span className="hidden min-[700px]:inline">{t("shell.status.missions")}</span>{activeMissions > 0 && <span>{activeMissions}</span>}</>}
          title={t("shell.status.missionsOpen")}
          onClick={onOpenMissions}
          emphasized={activeMissions > 0}
        />
      </div>

      <div className="flex min-w-0 items-stretch overflow-hidden">
        {streaming && turnStartedAt && (
          <StatusText
            icon={<LoaderCircle className="size-3 animate-spin" />}
            label={t("shell.status.turnRunning")}
            detail={formatElapsed(now - turnStartedAt)}
            className="hidden min-[900px]:inline-flex"
          />
        )}

        {metric && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={cn(STATUS_ACTION, "hidden min-[700px]:inline-flex")} title={t("shell.status.context") }>
                <span>{formatCompactTokens(metric.used)}/{formatCompactTokens(metric.limit)}</span>
                <ContextMeter filled={metric.filledCells} />
                <span>{metric.percent}%</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" sideOffset={5} className="w-64 p-3">
              <div className="text-[11px] font-semibold text-foreground">{t("shell.status.context")}</div>
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border-soft">
                  <div className="h-full bg-primary" style={{ width: `${metric.percent}%` }} />
                </div>
                <span className="font-mono text-[10px] text-secondary">{metric.percent}%</span>
              </div>
              <p className="mt-2 text-[10px] leading-4 text-muted">
                {t("shell.status.contextUsed", { used: formatCompactTokens(metric.used), limit: formatCompactTokens(metric.limit) })}
              </p>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {status?.harness?.intentRoute ? (
          <StatusText
            icon={<Activity className="size-3" />}
            label={status.harness.intentRoute}
            detail={
              typeof status.harness.wasteRatio === "number"
                ? `${Math.round(status.harness.wasteRatio * 100)}%`
                : undefined
            }
            title={t("shell.status.harnessHint", {
              intent: status.harness.intentRoute,
              waste: typeof status.harness.wasteRatio === "number"
                ? Math.round(status.harness.wasteRatio * 100)
                : 0,
              prunes: status.harness.toolPrunes ?? 0,
            })}
            className="hidden min-[960px]:inline-flex"
          />
        ) : null}

        {Number.isFinite(sessionTime) && (
          <StatusText
            label={t("shell.status.session")}
            detail={formatElapsed(now - sessionTime)}
            className="hidden min-[790px]:inline-flex"
          />
        )}

        <StatusAction
          icon={<Zap className={cn("size-3.5", turbo && "fill-current")} />}
          title={turbo ? t("shell.status.autonomyOn") : t("shell.status.autonomyOff")}
          onClick={onToggleTurbo}
          active={turbo}
          compact
        />
        <StatusAction
          icon={<Terminal className="size-3.5" />}
          title={developerOpen ? t("shell.status.developerHide") : t("shell.status.developerShow")}
          onClick={onToggleDeveloper}
          active={developerOpen}
          compact
        />
        {updateAttention ? (
          <button
            type="button"
            className={cn(STATUS_ACTION, "status-update-attention")}
            title={updateTitle}
            aria-label={updateTitle}
            onClick={openUpdateSettings}
          >
            <Sparkles className="size-3" aria-hidden />
            <span>{`v${__APP_VERSION__}`}</span>
            {updateStatus?.latestVersion && (
              <span className="status-update-version">{`→ v${updateStatus.latestVersion}`}</span>
            )}
          </button>
        ) : (
          <StatusText
            icon={<Hash className="size-3" />}
            label={`v${__APP_VERSION__}`}
            detail={BUILD_SHA || undefined}
            title={t("shell.status.build", { version: __APP_VERSION__, commit: BUILD_SHA || __APP_VERSION__ })}
            className="text-faint"
          />
        )}
        {updateAttention && (
          <span className="sr-only" role="status" aria-live="polite">{updateTitle}</span>
        )}
        {updateAttention && showUpdateNotice && (
          <button
            type="button"
            className="status-update-notice"
            title={updateTitle}
            aria-label={`${updateTitle}. ${t("shell.status.openUpdates")}`}
            onClick={openUpdateSettings}
          >
            <Sparkles className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 text-left">
              <span className="block truncate">{updateTitle}</span>
              <span className="status-update-notice-action">{t("shell.status.openUpdates")}</span>
            </span>
          </button>
        )}
      </div>
    </footer>
  );
}

const STATUS_ACTION = "inline-flex h-full shrink-0 items-center gap-1.5 px-1.5 transition-colors hover:bg-(--ui-row-hover) hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/40";

function StatusAction({ icon, label, title, onClick, compact, active, emphasized }: {
  icon: ReactNode;
  label?: ReactNode;
  title: string;
  onClick: () => void;
  compact?: boolean;
  active?: boolean;
  emphasized?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn(STATUS_ACTION, compact && "w-7 justify-center px-0", active && "bg-(--ui-row-active) text-foreground", emphasized && "text-primary")}
    >
      {icon}{label}
    </button>
  );
}

function StatusText({ icon, label, detail, title, className }: {
  icon?: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span title={title} className={cn("inline-flex h-full shrink-0 items-center gap-1.5 px-1.5", className)}>
      {icon}{label}{detail && <span className="text-faint">{detail}</span>}
    </span>
  );
}

function ContextMeter({ filled }: { filled: number }) {
  return (
    <span className="hidden items-center gap-px min-[980px]:inline-flex" aria-hidden>
      {Array.from({ length: 10 }, (_, index) => (
        <span key={index} className={cn("h-2.5 w-[2px] bg-border", index < filled && "bg-primary")} />
      ))}
    </span>
  );
}

function GatewayPanel({ status, connected, now, onConfigure }: {
  status: GatewayStatus | null;
  connected: boolean;
  now: number;
  onConfigure: () => void;
}) {
  const { t } = useI18n();
  const ready = connected && Boolean(status?.providerReady);
  const rows = [
    [t("shell.status.gatewayUptime"), status?.startedAt ? formatElapsed(now - Date.parse(status.startedAt)) : t("shell.status.notSelected")],
    [t("shell.status.gatewayActiveRuns"), String(status?.activeRuns ?? 0)],
    [t("shell.status.gatewayProvider"), status?.providerName || t("shell.status.notSelected")],
    [t("shell.status.activeModel"), status?.model || t("shell.status.noModel")],
    [t("shell.status.gatewayWorkspace"), status?.workspace || t("shell.status.notSelected")],
    [t("shell.status.gatewaySkills"), `${status?.skills.enabled ?? 0}/${status?.skills.total ?? 0}`],
    [t("shell.status.gatewaySchedules"), `${status?.cron.enabled ?? 0}/${status?.cron.total ?? 0}`],
  ];
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-border-soft px-1 pb-2">
        {ready ? <Activity className="size-3.5 text-success" aria-hidden /> : <AlertCircle className="size-3.5 text-warning" aria-hidden />}
        <div>
          <div className="text-[11px] font-semibold text-foreground">{t("shell.status.gatewayMenu")}</div>
          <div className="text-[9px] text-muted">{!connected ? t("shell.status.gatewayOffline") : ready ? t("shell.status.gatewayReady") : t("shell.status.gatewayNeedsSetup")}</div>
        </div>
      </div>
      <dl className="space-y-1.5 px-1 pt-2">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2 text-[9.5px]">
            <dt className="text-muted">{label}</dt>
            <dd className="truncate text-right text-secondary" title={value}>{value}</dd>
          </div>
        ))}
      </dl>
      <DropdownMenuItem className="mt-2 border-t border-border-soft pt-2 text-[10px]" onSelect={onConfigure}>
        {t("shell.status.gatewayConfigure")}
      </DropdownMenuItem>
    </div>
  );
}
