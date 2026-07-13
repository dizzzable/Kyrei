import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  CirclePause,
  Clock3,
  GitBranch,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui";
import { useI18n } from "@/i18n";
import { gateway, GatewayRequestError } from "@/lib/gateway";
import { formatCompactTokens } from "@/lib/status-metrics";
import type {
  PipelineRunSnapshot,
  PipelineRunStatus,
  PipelineDefinition,
  PipelinesConfig,
  PipelineStageRun,
  PipelineStageRunStatus,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type MissionAction = "start" | "pause" | "resume" | "cancel" | "approve" | "reject";
type MissionCreationErrorKey =
  | "shell.mission.createFailed"
  | "shell.mission.createError.workspaceRequired"
  | "shell.mission.createError.workspaceUnavailable"
  | "shell.mission.createError.workspaceChanging"
  | "shell.mission.createError.workspaceTooLarge"
  | "shell.mission.createError.runtimeUnavailable"
  | "shell.mission.createError.sandboxUnavailable"
  | "shell.mission.createError.definitionUnavailable"
  | "shell.mission.createError.sessionUnavailable";

interface PipelineMissionPanelProps {
  open: boolean;
  onClose: () => void;
  onConfigure: () => void;
  pipelines?: PipelinesConfig;
  sessionId?: string;
}

interface PipelineBudgetSummary {
  totalTokens: number;
  totalTokenLimit: number | null;
  calls: number;
  callLimit: number | null;
  exhausted: boolean;
}

export function awaitingApprovalStageId(run: Pick<PipelineRunSnapshot, "stages">): string | null {
  return run.stages.find((stage) => stage.kind === "approval" && stage.status === "awaiting_approval")?.id ?? null;
}

/** Safe controls are derived solely from durable run state, never optimistic UI state. */
export function pipelineRunControls(run: PipelineRunSnapshot): readonly MissionAction[] {
  switch (run.status) {
    case "queued": return ["start", "cancel"];
    case "running": return ["pause", "cancel"];
    case "paused":
    case "interrupted": return ["resume", "cancel"];
    // A pinned mission cannot safely resume after an immutable budget is spent.
    case "budget_paused":
    case "blocked": return ["cancel"];
    case "awaiting_approval": return awaitingApprovalStageId(run) ? ["approve", "reject", "cancel"] : ["cancel"];
    default: return [];
  }
}

export function pipelineBudgetSummary(budget: Record<string, unknown>): PipelineBudgetSummary {
  const limits = recordValue(budget.limits);
  const consumed = recordValue(budget.consumed);
  const inputTokens = nonNegativeNumber(consumed.inputTokens) ?? 0;
  const outputTokens = nonNegativeNumber(consumed.outputTokens) ?? 0;
  return {
    totalTokens: nonNegativeNumber(consumed.totalTokens) ?? inputTokens + outputTokens,
    totalTokenLimit: nonNegativeNumber(limits.maxTotalTokens),
    calls: (nonNegativeNumber(consumed.calls) ?? 0) + (nonNegativeNumber(budget.unmeteredCalls) ?? 0),
    callLimit: nonNegativeNumber(limits.maxCalls),
    exhausted: budget.exhausted === true,
  };
}

export function pipelineMissionCreationErrorKey(error: unknown): MissionCreationErrorKey {
  const code = error instanceof GatewayRequestError ? error.serverCode : undefined;
  if (code === "pipeline_workspace_required") return "shell.mission.createError.workspaceRequired";
  if (code === "pipeline_workspace_evidence_path_invalid" || code === "pipeline_workspace_evidence_path_unavailable") {
    return "shell.mission.createError.workspaceUnavailable";
  }
  if (code === "pipeline_workspace_changed_during_evidence") return "shell.mission.createError.workspaceChanging";
  if (code === "pipeline_workspace_evidence_limit") return "shell.mission.createError.workspaceTooLarge";
  if (code === "pipeline_runtime_unavailable") return "shell.mission.createError.runtimeUnavailable";
  if (code === "sandbox_required_unavailable") return "shell.mission.createError.sandboxUnavailable";
  if (code === "pipeline_definition_not_found" || code === "pipeline_revision_conflict") {
    return "shell.mission.createError.definitionUnavailable";
  }
  if (code === "session_not_found") return "shell.mission.createError.sessionUnavailable";
  return "shell.mission.createFailed";
}

export function PipelineMissionPanel({ open, onClose, onConfigure, pipelines, sessionId }: PipelineMissionPanelProps) {
  const { t, date, number } = useI18n();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  const confirmCancelRef = useRef<string | null>(null);
  const requestRef = useRef(0);
  const [runs, setRuns] = useState<PipelineRunSnapshot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingMission, setCreatingMission] = useState(false);
  const [pipelineId, setPipelineId] = useState("");
  const [goal, setGoal] = useState("");
  onCloseRef.current = onClose;
  confirmCancelRef.current = confirmCancelId;

  const availablePipelines = useMemo(
    () => (pipelines?.definitions ?? []).filter((definition) => definition.enabled),
    [pipelines?.definitions],
  );
  const selectedRun = useMemo(() => runs.find((run) => run.runId === selectedId) ?? null, [runs, selectedId]);
  const refresh = useCallback(async (initial = false) => {
    const requestId = ++requestRef.current;
    if (initial) setLoading(true);
    try {
      const next = sortRuns(await gateway.listPipelineRuns());
      if (requestId !== requestRef.current) return;
      setRuns(next);
      setSelectedId((current) => current && next.some((run) => run.runId === current) ? current : next[0]?.runId ?? null);
      if (initial && next.length === 0 && availablePipelines.length > 0) setCreating(true);
    } catch {
      if (requestId === requestRef.current) setError(t("shell.mission.loadFailed"));
    } finally {
      if (requestId === requestRef.current && initial) setLoading(false);
    }
  }, [availablePipelines.length, t]);

  useEffect(() => {
    if (!open) return;
    setPipelineId((current) => availablePipelines.some((definition) => definition.id === current)
      ? current
      : availablePipelines[0]?.id ?? "");
  }, [availablePipelines, open]);

  useEffect(() => {
    if (!open) return;
    setConfirmCancelId(null);
    void refresh(true);
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const hadInert = shell?.hasAttribute("inert") ?? false;
    const previousAriaHidden = shell?.getAttribute("aria-hidden");
    shell?.setAttribute("inert", "");
    shell?.setAttribute("aria-hidden", "true");
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (confirmCancelRef.current) setConfirmCancelId(null);
        else onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
      )].filter((element) => !element.hasAttribute("hidden"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown, true);
      if (!hadInert) shell?.removeAttribute("inert");
      if (previousAriaHidden == null) shell?.removeAttribute("aria-hidden");
      else shell?.setAttribute("aria-hidden", previousAriaHidden);
      previousFocus?.focus();
    };
  }, [open]);

  const applyAction = useCallback(async (run: PipelineRunSnapshot, action: MissionAction) => {
    setBusyId(run.runId);
    setError(null);
    try {
      const approvalStageId = awaitingApprovalStageId(run);
      const updated = action === "start"
        ? await gateway.startPipelineRun(run.runId)
        : action === "pause"
          ? await gateway.pausePipelineRun(run.runId)
          : action === "resume"
            ? await gateway.resumePipelineRun(run.runId)
            : action === "cancel"
              ? await gateway.cancelPipelineRun(run.runId)
              : approvalStageId
                ? await gateway.recordPipelineApproval(run.runId, {
                  stageId: approvalStageId,
                  status: action === "approve" ? "approved" : "rejected",
                })
                : null;
      if (!updated) {
        setError(t("shell.mission.operationFailed"));
        return;
      }
      setRuns((current) => sortRuns(current.map((candidate) => candidate.runId === updated.runId ? updated : candidate)));
      setConfirmCancelId(null);
    } catch {
      setError(t("shell.mission.operationFailed"));
    } finally {
      setBusyId(null);
    }
  }, [t]);

  const createMission = useCallback(async () => {
    const normalizedGoal = goal.trim();
    if (!pipelineId || !normalizedGoal || creatingMission) return;
    setCreatingMission(true);
    setError(null);
    try {
      const run = await gateway.createPipelineRun({
        pipelineId,
        goal: normalizedGoal,
        ...(sessionId ? { sessionId } : {}),
      });
      setRuns((current) => sortRuns([run, ...current.filter((candidate) => candidate.runId !== run.runId)]));
      setSelectedId(run.runId);
      setGoal("");
      setCreating(false);
    } catch (reason) {
      setError(t(pipelineMissionCreationErrorKey(reason)));
    } finally {
      setCreatingMission(false);
    }
  }, [creatingMission, goal, pipelineId, sessionId, t]);

  let missionContent: ReactNode;
  if (creating) {
    missionContent = <CreateMission
      pipelines={availablePipelines}
      pipelineId={pipelineId}
      goal={goal}
      busy={creatingMission}
      onPipelineChange={setPipelineId}
      onGoalChange={setGoal}
      onCreate={() => void createMission()}
      onCancel={() => setCreating(false)}
      onConfigure={onConfigure}
      t={t}
      number={number}
    />;
  } else if (selectedRun) {
    missionContent = <MissionDetails
      run={selectedRun}
      busy={busyId === selectedRun.runId}
      confirmingCancel={confirmCancelId === selectedRun.runId}
      onRequestAction={(action) => {
        if (action === "cancel") setConfirmCancelId(selectedRun.runId);
        else void applyAction(selectedRun, action);
      }}
      onCancelConfirmation={() => void applyAction(selectedRun, "cancel")}
      onDismissCancelConfirmation={() => setConfirmCancelId(null)}
      t={t}
      date={date}
      number={number}
    />;
  } else {
    missionContent = <EmptyMissionDetail onCreate={() => {
      if (availablePipelines.length === 0) onConfigure();
      else setCreating(true);
    }} hasPipelines={availablePipelines.length > 0} />;
  }

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-x-0 top-[var(--app-titlebar-h)] bottom-[var(--app-statusbar-h)] z-[110] grid min-h-0 place-items-center bg-bg p-3 sm:p-5"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="flex h-full max-h-full min-h-0 w-full max-w-[82rem] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-nous">
        <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-elevated text-primary"><GitBranch className="size-4" aria-hidden /></div>
          <div className="min-w-44 flex-1">
            <h2 id={titleId} className="text-[14px] font-semibold text-foreground">{t("shell.mission.title")}</h2>
            <p className="mt-0.5 text-[10px] text-muted">{t("shell.mission.subtitle")}</p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              if (availablePipelines.length === 0) onConfigure();
              else {
                setCreating(true);
                setConfirmCancelId(null);
              }
            }}
            disabled={creatingMission || busyId !== null}
          >
            <Plus className="size-3.5" aria-hidden />
            {availablePipelines.length === 0 ? t("shell.mission.configure") : t("shell.mission.new")}
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={() => void refresh()} disabled={loading || busyId !== null} aria-label={t("shell.mission.refresh")} title={t("shell.mission.refresh")}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden />
          </Button>
          <button ref={closeRef} type="button" onClick={onClose} className="grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45" aria-label={t("shell.mission.close")} title={t("shell.mission.close")}>
            <X className="size-4" aria-hidden />
          </button>
        </header>
        {error && <div role="alert" className="mx-4 mt-3 shrink-0 rounded-md border border-danger/30 bg-danger/8 px-3 py-2 text-[11px] text-danger sm:mx-5">{error}</div>}
        <div className={cn(
          "grid min-h-0 flex-1 min-[860px]:grid-cols-[20rem_minmax(0,1fr)] min-[860px]:grid-rows-1",
          creating ? "grid-rows-1" : "grid-rows-[minmax(10rem,35%)_minmax(0,1fr)]",
        )}>
          <aside className={cn(
            "flex min-h-0 flex-col border-b border-border bg-bg/35 min-[860px]:border-b-0 min-[860px]:border-r",
            creating && "max-[859px]:hidden",
          )}>
            <div className="min-h-0 flex-1 overflow-y-auto p-2" aria-label={t("shell.mission.runList")}>
              {loading ? <LoadingState label={t("shell.mission.loading")} /> : runs.length === 0 ? <EmptyRunList /> : runs.map((run) => ( // i18n-data-ok
                <RunRow key={run.runId} run={run} active={run.runId === selectedId} onSelect={() => { setSelectedId(run.runId); setConfirmCancelId(null); }} t={t} date={date} />
              ))}
            </div>
          </aside>
          <main className="min-h-0 overflow-y-auto">
            {missionContent}
          </main>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CreateMission({ pipelines, pipelineId, goal, busy, onPipelineChange, onGoalChange, onCreate, onCancel, onConfigure, t, number }: {
  pipelines: readonly PipelineDefinition[];
  pipelineId: string;
  goal: string;
  busy: boolean;
  onPipelineChange: (value: string) => void;
  onGoalChange: (value: string) => void;
  onCreate: () => void;
  onCancel: () => void;
  onConfigure: () => void;
  t: ReturnType<typeof useI18n>["t"];
  number: ReturnType<typeof useI18n>["number"];
}) {
  const selected = pipelines.find((definition) => definition.id === pipelineId) ?? null;
  if (pipelines.length === 0) {
    return <EmptyMissionDetail onCreate={onConfigure} hasPipelines={false} />;
  }
  return <form className="mx-auto w-full max-w-3xl p-4 min-[860px]:p-6" onSubmit={(event) => { event.preventDefault(); onCreate(); }}>
    <div className="rounded-xl border border-border-soft bg-bg/20 p-4 min-[860px]:p-5">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><GitBranch className="size-4" aria-hidden /></div>
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-foreground">{t("shell.mission.createTitle")}</h3>
          <p className="mt-1 text-[10.5px] leading-5 text-secondary">{t("shell.mission.createHint")}</p>
        </div>
      </div>
      <div className="mt-5 grid gap-4">
        <label className="grid gap-1.5 text-[10px] font-medium text-secondary">
          {t("shell.mission.pipeline")}
          <select className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[11px] text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/15" value={pipelineId} onChange={(event) => onPipelineChange(event.target.value)} disabled={busy}>
            {pipelines.map((definition) => <option key={definition.id} value={definition.id}>{definition.name}</option>)}
          </select>
        </label>
        {selected && <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-border-soft bg-surface/50 px-3 py-2 font-mono text-[9px] text-muted">
          <span>{selected.id}</span>
          <span>{t("shell.mission.stageCount", { count: number(selected.stages.length) })}</span>
          <span>{t("shell.mission.revision", { count: selected.revision })}</span>
        </div>}
        <label className="grid gap-1.5 text-[10px] font-medium text-secondary">
          {t("shell.mission.goal")}
          <textarea className="min-h-24 w-full resize-y rounded-md border border-border bg-surface px-3 py-2.5 text-[11px] leading-5 text-foreground outline-none placeholder:text-faint focus:border-primary/60 focus:ring-2 focus:ring-primary/15 min-[860px]:min-h-28" value={goal} onChange={(event) => onGoalChange(event.target.value)} placeholder={t("shell.mission.goalPlaceholder")} disabled={busy} />
        </label>
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-border-soft pt-4">
        <Button type="button" size="sm" variant="ghost" onClick={onConfigure} disabled={busy}>{t("shell.mission.editPipelines")}</Button>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>{t("shell.mission.back")}</Button>
          <Button type="submit" size="sm" disabled={busy || !pipelineId || !goal.trim()}>
            {busy ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <Plus className="size-3.5" aria-hidden />}
            {busy ? t("shell.mission.creating") : t("shell.mission.create")}
          </Button>
        </div>
      </div>
    </div>
  </form>;
}

function RunRow({ run, active, onSelect, t, date }: {
  run: PipelineRunSnapshot;
  active: boolean;
  onSelect: () => void;
  t: ReturnType<typeof useI18n>["t"];
  date: ReturnType<typeof useI18n>["date"];
}) {
  const completed = run.stages.filter((stage) => stage.status === "completed").length;
  return (
    <button type="button" onClick={onSelect} aria-pressed={active} className={cn(
      "mb-1 flex w-full min-w-0 items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
      active ? "border-border bg-elevated text-foreground" : "border-transparent text-secondary hover:border-border-soft hover:bg-(--ui-row-hover)",
    )}>
      <RunStatusIcon status={run.status} label={runStatusLabel(run.status, t)} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2"><span className="truncate text-[11px] font-medium">{run.pipelineId}</span><StatusChip status={run.status} t={t} /></span>
        <span className="mt-1 block line-clamp-2 text-[9.5px] leading-4 text-muted">{run.goal || t("shell.mission.noGoal")}</span>
        <span className="mt-1.5 flex items-center justify-between gap-2 font-mono text-[8.5px] text-faint">
          <span>{t("shell.mission.completedStages", { completed, total: run.stages.length })}</span>
          <span>{formatDate(run.updatedAt, date, t("shell.mission.notAvailable"))}</span>
        </span>
      </span>
    </button>
  );
}

function MissionDetails({ run, busy, confirmingCancel, onRequestAction, onCancelConfirmation, onDismissCancelConfirmation, t, date, number }: {
  run: PipelineRunSnapshot;
  busy: boolean;
  confirmingCancel: boolean;
  onRequestAction: (action: MissionAction) => void;
  onCancelConfirmation: () => void;
  onDismissCancelConfirmation: () => void;
  t: ReturnType<typeof useI18n>["t"];
  date: ReturnType<typeof useI18n>["date"];
  number: ReturnType<typeof useI18n>["number"];
}) {
  const budget = pipelineBudgetSummary(run.budget);
  const controls = pipelineRunControls(run);
  const completed = run.stages.filter((stage) => stage.status === "completed").length;
  const hint = runStatusHint(run.status, t);
  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-[15px] font-semibold text-foreground">{run.pipelineId}</h3><StatusChip status={run.status} t={t} large /></div>
          <p className="mt-1 max-w-3xl text-[11px] leading-5 text-secondary">{run.goal || t("shell.mission.noGoal")}</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[9.5px] text-muted">
            <span>{t("shell.mission.revision", { count: run.definitionRevision })}</span>
            <span>{t("shell.mission.completedStages", { completed, total: run.stages.length })}</span>
            <span>{t("shell.mission.artifacts", { count: run.artifacts.length })}</span>
            <span>{t("shell.mission.updated", { value: formatDate(run.updatedAt, date, t("shell.mission.notAvailable")) })}</span>
          </div>
        </div>
        {controls.length > 0 && <div className="flex flex-wrap items-center gap-1.5" aria-label={t("shell.mission.actions")}>
          {controls.map((action) => <Button key={action} size="sm" variant={action === "cancel" || action === "reject" ? "outline" : action === "approve" ? "default" : "secondary"} onClick={() => onRequestAction(action)} disabled={busy}>
            <ActionIcon action={action} busy={busy} />{missionActionLabel(action, t)}
          </Button>)}
        </div>}
      </div>
      {hint && <div className={cn("mt-4 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[10.5px] leading-4", run.status === "budget_paused" ? "border-warning/35 bg-warning/8 text-warning" : "border-border-soft bg-bg/30 text-secondary")}>
        {run.status === "budget_paused" ? <CirclePause className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />}<p>{hint}</p>
      </div>}
      {confirmingCancel && <div role="alert" className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-danger/35 bg-danger/8 p-3">
        <AlertCircle className="size-4 shrink-0 text-danger" aria-hidden /><span className="min-w-0 flex-1 text-[11px] font-medium text-secondary">{t("shell.mission.cancelConfirm")}</span>
        <Button size="sm" variant="ghost" onClick={onDismissCancelConfirmation}>{t("shell.mission.back")}</Button>
        <Button size="sm" variant="destructive" onClick={onCancelConfirmation} disabled={busy}>{busy ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <X className="size-3.5" aria-hidden />}{t("shell.mission.cancel")}</Button>
      </div>}
      <section className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0 rounded-xl border border-border-soft bg-bg/20">
          <div className="flex items-center justify-between border-b border-border-soft px-4 py-3"><h4 className="text-[12px] font-semibold text-foreground">{t("shell.mission.stages")}</h4><span className="font-mono text-[9px] text-muted">{completed}/{run.stages.length}</span></div>
          <ol className="divide-y divide-border-soft">{run.stages.map((stage, index) => <StageRow key={stage.id} stage={stage} index={index} t={t} />)}</ol>
        </div>
        <BudgetCard budget={budget} t={t} number={number} />
      </section>
    </div>
  );
}

function StageRow({ stage, index, t }: { stage: PipelineStageRun; index: number; t: ReturnType<typeof useI18n>["t"] }) {
  return <li className="flex min-w-0 items-start gap-3 px-4 py-3">
    <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-border-soft bg-surface font-mono text-[8px] text-muted" aria-hidden>{index + 1}</span>
    <StageStatusIcon status={stage.status} label={stageStatusLabel(stage.status, t)} />
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="truncate text-[11px] font-medium text-foreground">{stage.name || t("shell.mission.unnamedStage")}</span>
        <span className="rounded-sm bg-elevated px-1.5 py-0.5 font-mono text-[8px] text-muted">{stageKindLabel(stage.kind, t)}</span>
        {stage.writeCapable && <span className="rounded-sm border border-warning/25 px-1.5 py-0.5 font-mono text-[8px] text-warning">{t("shell.mission.stageWriter")}</span>}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-muted"><span>{stageStatusLabel(stage.status, t)}</span><span>{t("shell.mission.stageAttempts", { count: stage.attempts })}</span>{stage.uncertain && <span className="text-warning">{t("shell.mission.stageUncertain")}</span>}</div>
    </div>
  </li>;
}

function BudgetCard({ budget, t, number }: { budget: PipelineBudgetSummary; t: ReturnType<typeof useI18n>["t"]; number: ReturnType<typeof useI18n>["number"] }) { // i18n-data-ok
  return <section className="rounded-xl border border-border-soft bg-bg/20 p-4">
    <div className="flex items-center justify-between gap-2"><h4 className="text-[12px] font-semibold text-foreground">{t("shell.mission.budget")}</h4>{budget.exhausted && <CirclePause className="size-3.5 text-warning" aria-label={t("shell.mission.budgetExhausted")} />}</div>
    <div className="mt-4 space-y-4">
      <BudgetMetric label={t("shell.mission.budgetTokens")} used={budget.totalTokens} limit={budget.totalTokenLimit} format={formatCompactTokens} unlimited={t("shell.mission.unlimited")} />
      <BudgetMetric label={t("shell.mission.budgetCalls")} used={budget.calls} limit={budget.callLimit} format={(value) => number(value)} unlimited={t("shell.mission.unlimited")} />
    </div>
    {budget.exhausted && <p className="mt-4 border-t border-border-soft pt-3 text-[9.5px] leading-4 text-warning">{t("shell.mission.budgetExhausted")}</p>}
  </section>;
}

function BudgetMetric({ label, used, limit, format, unlimited }: { label: string; used: number; limit: number | null; format: (value: number) => string; unlimited: string }) {
  const ratio = limit && limit > 0 ? Math.min(1, used / limit) : 0;
  return <div>
    <div className="flex items-center justify-between gap-3 text-[9.5px]"><span className="text-muted">{label}</span><span className="font-mono text-secondary">{format(used)} / {limit == null ? unlimited : format(limit)}</span></div>
    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border-soft"><div className={cn("h-full rounded-full bg-primary", ratio >= 1 && "bg-warning")} style={{ width: `${ratio * 100}%` }} /></div>
  </div>;
}

function StatusChip({ status, t, large = false }: { status: PipelineRunStatus; t: ReturnType<typeof useI18n>["t"]; large?: boolean }) {
  return <span className={cn("shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[8px]", large && "text-[9px]", statusTone(status))}>{runStatusLabel(status, t)}</span>;
}

function ActionIcon({ action, busy }: { action: MissionAction; busy: boolean }) {
  if (busy) return <LoaderCircle className="size-3.5 animate-spin" aria-hidden />;
  if (action === "start" || action === "resume" || action === "approve") return <Play className="size-3.5" aria-hidden />;
  if (action === "pause") return <Pause className="size-3.5" aria-hidden />;
  return <X className="size-3.5" aria-hidden />;
}

function RunStatusIcon({ status, label }: { status: PipelineRunStatus; label: string }) { return <StatusIcon status={status} label={label} />; }
function StageStatusIcon({ status, label }: { status: PipelineStageRunStatus; label: string }) { return <StatusIcon status={status} label={label} />; }
function StatusIcon({ status, label }: { status: PipelineRunStatus | PipelineStageRunStatus; label: string }) {
  const common = "mt-0.5 size-3.5 shrink-0";
  let icon: ReactNode;
  if (status === "running") icon = <LoaderCircle className={`${common} animate-spin text-primary`} />;
  else if (status === "completed") icon = <CheckCircle2 className={`${common} text-success`} />;
  else if (status === "budget_paused") icon = <CirclePause className={`${common} text-warning`} />;
  else if (status === "awaiting_approval") icon = <Clock3 className={`${common} text-primary`} />;
  else if (status === "failed" || status === "blocked" || status === "uncertain") icon = <AlertCircle className={`${common} text-danger`} />;
  else icon = <CircleDashed className={`${common} text-muted`} />;
  return <span role="img" aria-label={label}>{icon}</span>;
}

function EmptyRunList() {
  const { t } = useI18n();
  return <div className="grid min-h-48 place-items-center px-5 py-8 text-center"><div><GitBranch className="mx-auto size-5 text-muted" aria-hidden /><div className="mt-2 text-[11px] font-medium text-secondary">{t("shell.mission.empty")}</div><p className="mx-auto mt-1 max-w-64 text-[10px] leading-4 text-muted">{t("shell.mission.emptyListHint")}</p></div></div>;
}
function EmptyMissionDetail({ onCreate, hasPipelines }: { onCreate: () => void; hasPipelines: boolean }) {
  const { t } = useI18n();
  return <div className="grid min-h-full place-items-center px-5 py-10 text-center">
    <div className="max-w-sm">
      <div className="mx-auto grid size-10 place-items-center rounded-xl bg-elevated text-primary"><GitBranch className="size-5" aria-hidden /></div>
      <div className="mt-3 text-[13px] font-semibold text-foreground">{hasPipelines ? t("shell.mission.emptyDetail") : t("shell.mission.noPipelines")}</div>
      <p className="mx-auto mt-1.5 max-w-72 text-[10.5px] leading-5 text-muted">{hasPipelines ? t("shell.mission.emptyHint") : t("shell.mission.noPipelinesHint")}</p>
      <Button size="sm" className="mt-4" onClick={onCreate}><Plus className="size-3.5" aria-hidden />{hasPipelines ? t("shell.mission.new") : t("shell.mission.configure")}</Button>
    </div>
  </div>;
}
function LoadingState({ label }: { label: string }) { return <div role="status" aria-label={label} className="grid min-h-48 place-items-center"><LoaderCircle className="size-4 animate-spin text-muted" aria-hidden /></div>; }
function sortRuns(runs: readonly PipelineRunSnapshot[]): PipelineRunSnapshot[] { return [...runs].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)); }
function formatDate(value: string | undefined, date: ReturnType<typeof useI18n>["date"], fallback: string): string {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? date(timestamp, { dateStyle: "medium", timeStyle: "short" }) : fallback;
}
function missionActionLabel(action: MissionAction, t: ReturnType<typeof useI18n>["t"]): string {
  switch (action) {
    case "start": return t("shell.mission.start");
    case "pause": return t("shell.mission.pause");
    case "resume": return t("shell.mission.resume");
    case "cancel": return t("shell.mission.cancel");
    case "approve": return t("shell.mission.approve");
    case "reject": return t("shell.mission.reject");
  }
}
function runStatusLabel(status: PipelineRunStatus, t: ReturnType<typeof useI18n>["t"]): string { return t(`shell.mission.status.${status}` as "shell.mission.status.queued"); }
function stageStatusLabel(status: PipelineStageRunStatus, t: ReturnType<typeof useI18n>["t"]): string { return t(`shell.mission.stageStatus.${status}` as "shell.mission.stageStatus.pending"); }
function stageKindLabel(kind: PipelineStageRun["kind"], t: ReturnType<typeof useI18n>["t"]): string { return t(`shell.mission.stageKind.${kind}` as "shell.mission.stageKind.department"); }
function runStatusHint(status: PipelineRunStatus, t: ReturnType<typeof useI18n>["t"]): string | null {
  if (status === "budget_paused") return t("shell.mission.budgetPausedHint");
  if (status === "blocked") return t("shell.mission.blockedHint");
  if (status === "awaiting_approval") return t("shell.mission.approvalHint");
  return null;
}
function statusTone(status: PipelineRunStatus): string {
  if (status === "running" || status === "awaiting_approval") return "border-primary/30 bg-primary/8 text-primary";
  if (status === "completed") return "border-success/30 bg-success/8 text-success";
  if (status === "budget_paused" || status === "paused" || status === "interrupted") return "border-warning/30 bg-warning/8 text-warning";
  if (status === "failed" || status === "blocked") return "border-danger/30 bg-danger/8 text-danger";
  return "border-border-soft bg-elevated text-muted";
}
function recordValue(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function nonNegativeNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
