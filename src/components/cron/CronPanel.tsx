import {
  AlertCircle,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  Clock3,
  History,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  Save,
  Trash2,
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

import { Button, Input, SearchField, Switch, Textarea } from "@/components/ui";
import { useI18n } from "@/i18n";
import { gateway } from "@/lib/gateway";
import type { CronJob, CronRun } from "@/lib/types";
import { cn } from "@/lib/utils";

interface CronPanelProps {
  open: boolean;
  onClose: () => void;
  onOpenSession?: (id: string) => void;
}

interface CronDraft {
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
}

const EMPTY_DRAFT: CronDraft = {
  name: "",
  prompt: "",
  schedule: "",
  enabled: true,
};

export function CronPanel({ open, onClose, onOpenSession }: CronPanelProps) {
  const { t, date } = useI18n();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const selectedRef = useRef<string | null>(null);
  const confirmDeleteRef = useRef<string | null>(null);
  const onCloseRef = useRef(onClose);
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"create" | "edit">("edit");
  const [draft, setDraft] = useState<CronDraft>(EMPTY_DRAFT);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsVersion, setRunsVersion] = useState(0);

  selectedRef.current = selectedId;
  confirmDeleteRef.current = confirmDeleteId;
  onCloseRef.current = onClose;
  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedId) ?? null,
    [jobs, selectedId],
  );
  const filteredJobs = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return jobs;
    return jobs.filter((job) => `${job.name} ${job.prompt} ${job.schedule}`.toLocaleLowerCase().includes(normalized));
  }, [jobs, query]);

  const refresh = useCallback(async (preferredId?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const next = await gateway.listCronJobs();
      setJobs(next);
      const requested = preferredId === undefined ? selectedRef.current : preferredId;
      const candidate = requested && next.some((job) => job.id === requested)
        ? requested
        : next[0]?.id ?? null;
      setSelectedId(candidate);
      if (candidate) {
        setMode("edit");
      } else {
        setMode("create");
        setDraft(EMPTY_DRAFT);
      }
    } catch {
      setError(t("shell.cron.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    setConfirmDeleteId(null);
    setValidationError(false);
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (mode !== "edit" || !selectedJob) return;
    setDraft(jobToDraft(selectedJob));
    setValidationError(false);
    setConfirmDeleteId(null);
  }, [mode, selectedJob]);

  useEffect(() => {
    if (!open || mode !== "edit" || !selectedId) {
      setRuns([]);
      setRunsLoading(false);
      return;
    }
    let alive = true;
    setRunsLoading(true);
    gateway.getCronRuns(selectedId)
      .then((next) => { if (alive) setRuns(next); })
      .catch(() => { if (alive) setRuns([]); })
      .finally(() => { if (alive) setRunsLoading(false); });
    return () => { alive = false; };
  }, [mode, open, runsVersion, selectedId]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const hadInert = shell?.hasAttribute("inert") ?? false;
    const previousAriaHidden = shell?.getAttribute("aria-hidden");
    shell?.setAttribute("inert", "");
    shell?.setAttribute("aria-hidden", "true");

    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (confirmDeleteRef.current) setConfirmDeleteId(null);
        else onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
      )].filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
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
      previouslyFocused?.focus();
    };
  }, [open]);

  const chooseJob = (job: CronJob) => {
    setMode("edit");
    setSelectedId(job.id);
    setError(null);
  };

  const beginCreate = () => {
    setMode("create");
    setSelectedId(null);
    setDraft(EMPTY_DRAFT);
    setRuns([]);
    setError(null);
    setValidationError(false);
    setConfirmDeleteId(null);
  };

  const save = async () => {
    const normalized = normalizeDraft(draft);
    if (!normalized || !isValidCronExpression(normalized.schedule)) {
      setValidationError(true);
      return;
    }
    const operationId = mode === "create" ? "create" : selectedId;
    if (!operationId) return;
    setBusyId(operationId);
    setError(null);
    setValidationError(false);
    try {
      const saved = mode === "create"
        ? await gateway.createCronJob(normalized)
        : await gateway.updateCronJob(operationId, normalized);
      setJobs((current) => upsertJob(current, saved));
      setSelectedId(saved.id);
      setMode("edit");
      setDraft(jobToDraft(saved));
    } catch {
      setError(t("shell.cron.operationFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const setEnabled = async (job: CronJob, enabled: boolean) => {
    setBusyId(job.id);
    setError(null);
    try {
      const updated = enabled
        ? await gateway.resumeCronJob(job.id)
        : await gateway.pauseCronJob(job.id);
      setJobs((current) => upsertJob(current, updated));
      if (selectedId === updated.id) setDraft(jobToDraft(updated));
    } catch {
      setError(t("shell.cron.operationFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const runNow = async (job: CronJob) => {
    setBusyId(job.id);
    setError(null);
    try {
      const result = await gateway.triggerCronJob(job.id);
      setJobs((current) => upsertJob(current, result.job));
      setRunsVersion((version) => version + 1);
    } catch {
      setError(t("shell.cron.operationFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const requestDelete = (job: CronJob) => {
    setConfirmDeleteId(job.id);
  };

  const remove = async (job: CronJob) => {
    setBusyId(job.id);
    setError(null);
    try {
      await gateway.deleteCronJob(job.id);
      const remaining = jobs.filter((entry) => entry.id !== job.id);
      setJobs(remaining);
      setConfirmDeleteId(null);
      setSelectedId(remaining[0]?.id ?? null);
      setMode(remaining.length > 0 ? "edit" : "create");
      if (remaining.length === 0) setDraft(EMPTY_DRAFT);
    } catch {
      setError(t("shell.cron.operationFailed"));
    } finally {
      setBusyId(null);
    }
  };

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-x-0 top-[var(--app-titlebar-h)] bottom-[var(--app-statusbar-h)] z-[110] grid min-h-0 place-items-center bg-bg p-3 sm:p-5"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex h-full max-h-full min-h-0 w-full max-w-[80rem] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-nous"
      >
        <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-elevated text-primary">
            <CalendarClock className="size-4" aria-hidden />
          </div>
          <div className="min-w-44 flex-1">
            <h2 id={titleId} className="text-[14px] font-semibold text-foreground">{t("shell.cron.title")}</h2>
            <p className="mt-0.5 text-[10px] text-muted">{t("shell.cron.subtitle")}</p>
          </div>
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={t("shell.cron.searchPlaceholder")}
            aria-label={t("shell.cron.searchPlaceholder")}
            className="order-last w-full sm:order-none sm:w-60"
          />
          <Button size="sm" onClick={beginCreate} disabled={busyId !== null}>
            <Plus className="size-3.5" aria-hidden />{t("shell.cron.create")}
          </Button>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
            aria-label={t("shell.cron.close")}
            title={t("shell.cron.close")}
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>

        {error && (
          <div className="mx-4 mt-3 shrink-0 rounded-md border border-danger/30 bg-danger/8 px-3 py-2 text-[11px] text-danger sm:mx-5">
            {error}
          </div>
        )}

        <div className="grid min-h-0 flex-1 grid-rows-[minmax(10rem,35%)_minmax(0,1fr)] min-[860px]:grid-cols-[19rem_minmax(0,1fr)] min-[860px]:grid-rows-1">
          <aside className="flex min-h-0 flex-col border-b border-border bg-bg/35 min-[860px]:border-b-0 min-[860px]:border-r">
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {loading ? (
                <LoadingState label={t("shell.cron.title")} />
              ) : filteredJobs.length === 0 ? (
                <div className="grid min-h-48 place-items-center px-5 py-8 text-center">
                  <div>
                    <CalendarClock className="mx-auto size-5 text-muted" aria-hidden />
                    <div className="mt-2 text-[11px] font-medium text-secondary">
                      {jobs.length > 0 ? t("shell.cron.noMatches") : t("shell.cron.empty")}
                    </div>
                    {jobs.length === 0 && (
                      <>
                        <p className="mx-auto mt-1 max-w-56 text-[10px] leading-4 text-muted">{t("shell.cron.emptyHint")}</p>
                        <Button className="mt-3" size="sm" variant="outline" onClick={beginCreate}>
                          <Plus className="size-3.5" aria-hidden />{t("shell.cron.create")}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ) : filteredJobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  active={mode === "edit" && selectedId === job.id}
                  busy={busyId === job.id}
                  onSelect={() => chooseJob(job)}
                  nextLabel={t("shell.cron.nextRun")}
                  nextValue={formatDate(job.nextRunAt, date, t("shell.cron.never"))}
                />
              ))}
            </div>
          </aside>

          <main className="min-h-0 overflow-y-auto">
            <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-[15px] font-semibold text-foreground">
                    {mode === "create" ? t("shell.cron.create") : t("shell.cron.edit")}
                  </h3>
                  {selectedJob && mode === "edit" && (
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[9.5px] text-muted">
                      <span>{t("shell.cron.lastRun")}: {formatDate(selectedJob.lastRunAt, date, t("shell.cron.never"))}</span>
                      <span>{t("shell.cron.nextRun")}: {formatDate(selectedJob.nextRunAt, date, t("shell.cron.never"))}</span>
                    </div>
                  )}
                </div>
                {selectedJob && mode === "edit" && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void runNow(selectedJob)}
                      disabled={busyId !== null}
                    >
                      <Play className="size-3.5" aria-hidden />{t("shell.cron.runNow")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void setEnabled(selectedJob, !selectedJob.enabled)}
                      disabled={busyId !== null}
                    >
                      {selectedJob.enabled ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
                      {selectedJob.enabled ? t("shell.cron.pause") : t("shell.cron.resume")}
                    </Button>
                    <Button
                      size="sm"
                      variant={confirmDeleteId === selectedJob.id ? "destructive" : "outline"}
                      onClick={() => requestDelete(selectedJob)}
                      disabled={busyId !== null}
                    >
                      <Trash2 className="size-3.5" aria-hidden />{t("shell.cron.delete")}
                    </Button>
                  </div>
                )}
              </div>

              {selectedJob && confirmDeleteId === selectedJob.id && (
                <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-danger/35 bg-danger/8 p-3">
                  <Trash2 className="size-4 shrink-0 text-danger" aria-hidden />
                  <span className="min-w-0 flex-1 text-[11px] font-medium text-secondary">
                    {t("shell.cron.confirmDelete", { name: selectedJob.name })}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteId(null)}>{t("common.cancel")}</Button>
                  <Button size="sm" variant="destructive" onClick={() => void remove(selectedJob)} disabled={busyId !== null}>
                    {t("common.delete")}
                  </Button>
                </div>
              )}

              <form className="mt-5 grid gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
                <label className="grid gap-1.5 text-[11px] text-secondary">
                  <span>{t("shell.cron.name")}</span>
                  <Input
                    value={draft.name}
                    onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                    placeholder={t("shell.cron.namePlaceholder")}
                    disabled={busyId !== null}
                  />
                </label>
                <label className="grid gap-1.5 text-[11px] text-secondary">
                  <span>{t("shell.cron.prompt")}</span>
                  <Textarea
                    value={draft.prompt}
                    onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
                    placeholder={t("shell.cron.promptPlaceholder")}
                    className="min-h-28 resize-y"
                    disabled={busyId !== null}
                  />
                </label>
                <label className="grid gap-1.5 text-[11px] text-secondary">
                  <span>{t("shell.cron.schedule")}</span>
                  <Input
                    value={draft.schedule}
                    onChange={(event) => setDraft((current) => ({ ...current, schedule: event.target.value }))}
                    className="font-mono"
                    spellCheck={false}
                    aria-invalid={validationError || undefined}
                    disabled={busyId !== null}
                  />
                  <span className="text-[9.5px] leading-4 text-muted">{t("shell.cron.scheduleHint")}</span>
                </label>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-soft pt-4">
                  <label className="flex items-center gap-2 text-[11px] font-medium text-secondary">
                    <Switch
                      checked={draft.enabled}
                      onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
                      disabled={busyId !== null}
                      aria-label={t("shell.cron.enabled")}
                    />
                    {t("shell.cron.enabled")}
                  </label>
                  <Button type="submit" size="sm" disabled={busyId !== null}>
                    {busyId ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <Save className="size-3.5" aria-hidden />}
                    {t("shell.cron.save")}
                  </Button>
                </div>
                {validationError && (
                  <div className="rounded-md border border-warning/30 bg-warning/8 px-3 py-2 text-[10px] text-warning">
                    {t("shell.cron.validationRequired")}
                  </div>
                )}
              </form>

              {selectedJob && mode === "edit" && (
                <section className="mt-7 border-t border-border-soft pt-5">
                  <div className="mb-3 flex items-center gap-2">
                    <History className="size-3.5 text-muted" aria-hidden />
                    <h4 className="text-[12px] font-semibold text-foreground">{t("shell.cron.history")}</h4>
                    {runs.length > 0 && <span className="ml-auto font-mono text-[9px] text-muted">{runs.length}</span>}
                  </div>
                  {runsLoading ? (
                    <LoadingState label={t("shell.cron.history")} compact />
                  ) : runs.length === 0 ? (
                    <div className="rounded-lg border border-border-soft bg-bg/25 px-4 py-6 text-center text-[10px] text-muted">
                      {t("shell.cron.noHistory")}
                    </div>
                  ) : (
                    <div className="divide-y divide-border-soft overflow-hidden rounded-lg border border-border-soft bg-bg/25">
                      {runs.map((run, index) => (
                        <RunRow
                          key={`${run.startedAt}:${index}`}
                          run={run}
                          label={formatDate(run.startedAt, date, t("shell.cron.never"))}
                          statusLabel={runStatusLabel(run.status, t)}
                          openSessionLabel={t("shell.cron.openSession")}
                          onOpenSession={onOpenSession}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )}
            </div>
          </main>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function JobRow({ job, active, busy, onSelect, nextLabel, nextValue }: {
  job: CronJob;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  nextLabel: string;
  nextValue: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "mb-1 flex w-full min-w-0 items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
        active
          ? "border-border bg-elevated text-foreground"
          : "border-transparent text-secondary hover:border-border-soft hover:bg-(--ui-row-hover)",
      )}
    >
      <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", job.enabled ? "bg-success" : "bg-muted")} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[11px] font-medium">{job.name}</span>
          {busy && <LoaderCircle className="size-3 shrink-0 animate-spin text-primary" aria-hidden />}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[9px] text-muted">{job.schedule}</span>
        <span className="mt-1 block truncate text-[8.5px] text-faint">{nextLabel}: {nextValue}</span>
      </span>
    </button>
  );
}

function RunRow({ run, label, statusLabel, openSessionLabel, onOpenSession }: {
  run: CronRun;
  label: string;
  statusLabel: string;
  openSessionLabel: string;
  onOpenSession?: (id: string) => void;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2.5 px-3 py-2.5">
      <RunStatusIcon status={run.status} label={statusLabel} />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[9.5px] text-secondary">{label}</div>
        {(run.error || run.result) && (
          <p className={cn("mt-0.5 line-clamp-2 text-[9px] leading-4 text-muted", run.error && "text-danger")}>
            {run.error || run.result}
          </p>
        )}
      </div>
      {run.status === "running" && <Clock3 className="size-3 shrink-0 text-muted" aria-hidden />}
      {run.sessionId && onOpenSession && (
        <button
          type="button"
          className="shell-icon-button"
          onClick={() => onOpenSession(run.sessionId!)}
          aria-label={openSessionLabel}
          title={openSessionLabel}
        >
          <ArrowUpRight className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

function runStatusLabel(status: CronRun["status"], t: ReturnType<typeof useI18n>["t"]): string {
  switch (status) {
    case "running": return t("shell.cron.status.running");
    case "complete": return t("shell.cron.status.complete");
    case "failed": return t("shell.cron.status.failed");
    default: return t("shell.cron.status.interrupted");
  }
}

function RunStatusIcon({ status, label }: { status: CronRun["status"]; label: string }) {
  const common = "mt-0.5 size-3.5 shrink-0";
  let icon: ReactNode;
  switch (status) {
    case "running": icon = <LoaderCircle className={`${common} animate-spin text-primary`} />; break;
    case "complete": icon = <CheckCircle2 className={`${common} text-success`} />; break;
    case "failed": icon = <AlertCircle className={`${common} text-danger`} />; break;
    default: icon = <CircleDashed className={`${common} text-warning`} />; break;
  }
  return <span role="img" aria-label={label}>{icon}</span>;
}

function LoadingState({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <div role="status" aria-label={label} className={cn("grid place-items-center", compact ? "min-h-20" : "min-h-48")}>
      <LoaderCircle className="size-4 animate-spin text-muted" aria-hidden />
    </div>
  );
}

function jobToDraft(job: CronJob): CronDraft {
  return { name: job.name, prompt: job.prompt, schedule: job.schedule, enabled: job.enabled };
}

function normalizeDraft(draft: CronDraft): CronDraft | null {
  const name = draft.name.trim();
  const prompt = draft.prompt.trim();
  const schedule = draft.schedule.trim().replace(/\s+/g, " ");
  return name && prompt && schedule ? { name, prompt, schedule, enabled: draft.enabled } : null;
}

function upsertJob(jobs: CronJob[], next: CronJob): CronJob[] {
  const index = jobs.findIndex((job) => job.id === next.id);
  if (index === -1) return [next, ...jobs];
  return jobs.map((job) => job.id === next.id ? next : job);
}

function formatDate(
  value: string | undefined,
  format: ReturnType<typeof useI18n>["date"],
  fallback: string,
): string {
  if (!value) return fallback;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return fallback;
  return format(timestamp, { dateStyle: "medium", timeStyle: "short" });
}

function isValidCronExpression(expression: string): boolean {
  const definitions = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== definitions.length) return false;
  return fields.every((field, index) => isValidCronField(field, definitions[index][0], definitions[index][1]));
}

function isValidCronField(field: string, minimum: number, maximum: number): boolean {
  if (!field || !/^[0-9*/,\-]+$/.test(field)) return false;
  return field.split(",").every((part) => {
    if (!part) return false;
    const stepParts = part.split("/");
    if (stepParts.length > 2 || !stepParts[0]) return false;
    const step = stepParts[1] === undefined ? 1 : Number(stepParts[1]);
    if (!Number.isInteger(step) || step < 1) return false;
    const base = stepParts[0];
    if (base === "*") return step <= maximum - minimum + 1;
    if (base.includes("-")) {
      const bounds = base.split("-").map(Number);
      return bounds.length === 2
        && bounds.every(Number.isInteger)
        && bounds[0] >= minimum
        && bounds[1] <= maximum
        && bounds[0] <= bounds[1]
        && step <= bounds[1] - bounds[0] + 1;
    }
    const value = Number(base);
    return stepParts.length === 1 && Number.isInteger(value) && value >= minimum && value <= maximum;
  });
}
