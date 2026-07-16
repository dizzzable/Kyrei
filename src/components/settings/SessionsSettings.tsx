import { Archive, ArchiveRestore, BrainCircuit, Check, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui";
import { useI18n } from "@/i18n";
import { gateway } from "@/lib/gateway";
import { sessionTitle } from "@/lib/session-search";
import type { SessionInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

type ProposalRow = {
  fileName: string;
  path: string;
  sessionId: string;
  title?: string;
  via?: string;
  applyMode?: string;
  status?: string;
  at?: string;
  applied?: string[];
  proposalCount: number;
  preview: Array<{ target: string; rationale?: string; contentPreview: string }>;
};

/**
 * Archived sessions panel (Hermes sessions-settings analogue).
 * Soft-archive keeps messages for hybrid memory FTS; permanent delete drops them.
 * Curator batch + proposal review apply recommended memory routing.
 */
export function SessionsSettings({
  onRestored,
}: {
  /** Called after unarchive so the main sidebar can refresh. */
  onRestored?: () => void | Promise<void>;
}) {
  const { t, date } = useI18n();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [curateNote, setCurateNote] = useState<string | null>(null);
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [proposalsLoading, setProposalsLoading] = useState(false);

  const loadProposals = useCallback(async () => {
    setProposalsLoading(true);
    try {
      const result = await gateway.listCuratorProposals(30);
      setProposals(result.proposals ?? []);
    } catch {
      setProposals([]);
    } finally {
      setProposalsLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await gateway.listSessions({ archived: "only" });
      setSessions(list);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSessions([]);
    } finally {
      setLoading(false);
    }
    void loadProposals();
  }, [loadProposals]);

  useEffect(() => {
    void load();
  }, [load]);

  const unarchive = async (session: SessionInfo) => {
    setBusyId(session.id);
    setError(null);
    try {
      await gateway.setSessionArchived(session.id, false);
      setSessions((prev) => prev.filter((s) => s.id !== session.id));
      await onRestored?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId(null);
    }
  };

  const permanentDelete = async (session: SessionInfo) => {
    const title = sessionTitle(session, t("shell.session.untitled"));
    if (!window.confirm(t("settings.sessions.deleteConfirm", { title }))) return;
    setBusyId(session.id);
    setError(null);
    try {
      await gateway.deleteSession(session.id);
      setSessions((prev) => prev.filter((s) => s.id !== session.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId(null);
    }
  };

  const curate = async (session: SessionInfo, applyMode?: "propose" | "apply_safe" | "apply_all") => {
    setBusyId(session.id);
    setError(null);
    setCurateNote(null);
    try {
      const result = await gateway.curateSessionMemory(session.id, applyMode ? { applyMode } : undefined);
      setCurateNote(
        result.summary
          || (result.ok
            ? t("settings.sessions.curateOk", { applied: (result.applied ?? []).join(", ") || "—" })
            : t("settings.sessions.curateFailed", { error: result.error ?? "failed" })),
      );
      void loadProposals();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId(null);
    }
  };

  const batchCurate = async (applyMode: "propose" | "apply_safe" = "apply_safe") => {
    if (!sessions.length) return;
    setBatchBusy(true);
    setError(null);
    setCurateNote(null);
    try {
      const result = await gateway.curateSessionMemoryBatch({ applyMode });
      setCurateNote(
        t("settings.sessions.batchCurateOk", {
          ok: result.succeeded,
          total: result.count,
        }),
      );
      void loadProposals();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBatchBusy(false);
    }
  };

  const applyProposal = async (fileName: string, applyMode: "apply_safe" | "apply_all") => {
    if (applyMode === "apply_all") {
      if (!window.confirm(t("settings.sessions.applyAllConfirm"))) return;
    }
    setBusyId(fileName);
    setError(null);
    try {
      const result = await gateway.applyCuratorProposal(fileName, applyMode);
      if (!result.ok) {
        setError(result.error ?? "apply_failed");
      } else {
        setCurateNote(
          t("settings.sessions.proposalApplied", {
            applied: (result.applied ?? []).join(", ") || "—",
          }),
        );
        void loadProposals();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border-soft bg-elevated/30 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <Archive className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-foreground">{t("settings.sessions.introTitle")}</p>
            <p className="mt-1 text-[12px] leading-snug text-muted">{t("settings.sessions.introHint")}</p>
            <p className="mt-1.5 text-[11px] leading-snug text-secondary">{t("settings.sessions.curatorHint")}</p>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-danger/35 bg-danger/8 px-2.5 py-2 text-[11px] text-danger">
          {error}
        </div>
      )}
      {curateNote && (
        <div className="rounded-md border border-border-soft bg-elevated/40 px-2.5 py-2 text-[11px] text-muted">
          {curateNote}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={batchBusy || loading || sessions.length === 0}
          onClick={() => void batchCurate("apply_safe")}
        >
          {batchBusy ? <Loader2 className="size-3.5 animate-spin" /> : <BrainCircuit className="size-3.5" />}
          {t("settings.sessions.batchCurateSafe")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={batchBusy || loading || sessions.length === 0}
          onClick={() => void batchCurate("propose")}
        >
          {t("settings.sessions.batchCuratePropose")}
        </Button>
        <Button size="sm" variant="outline" disabled={loading || batchBusy} onClick={() => void load()}>
          {t("settings.sessions.refresh")}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-[12px] text-muted">
          <Loader2 className="size-3.5 animate-spin" />
          {t("settings.sessions.loading")}
        </div>
      ) : sessions.length === 0 ? (
        <p className="py-6 text-center text-[12px] text-muted">{t("settings.sessions.empty")}</p>
      ) : (
        <ul className="divide-y divide-border-soft rounded-lg border border-border-soft">
          {sessions.map((session) => {
            const title = sessionTitle(session, t("shell.session.untitled"));
            const busy = busyId === session.id || batchBusy;
            return (
              <li key={session.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-foreground">{title}</p>
                  <p className="mt-0.5 font-mono text-[10px] text-muted">
                    {session.id.slice(0, 18)}…
                    {session.archivedAt && Number.isFinite(Date.parse(session.archivedAt)) && (
                      <span className="ml-2 text-secondary">
                        {t("settings.sessions.archivedAt", {
                          date: date(Date.parse(session.archivedAt), { dateStyle: "medium", timeStyle: "short" }),
                        })}
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void curate(session, "propose")}
                    title={t("settings.sessions.curatePropose")}
                  >
                    {busyId === session.id ? <Loader2 className="size-3.5 animate-spin" /> : <BrainCircuit className="size-3.5 opacity-70" />}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void curate(session, "apply_safe")}
                    title={t("settings.sessions.curate")}
                  >
                    <Check className="size-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void unarchive(session)}
                  >
                    {busyId === session.id ? <Loader2 className="size-3.5 animate-spin" /> : <ArchiveRestore className="size-3.5" />}
                    {t("settings.sessions.restore")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={cn("text-danger hover:text-danger")}
                    disabled={busy}
                    onClick={() => void permanentDelete(session)}
                    title={t("settings.sessions.deletePermanently")}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <section className="space-y-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          {t("settings.sessions.proposalsTitle")}
        </h4>
        <p className="text-[11px] leading-snug text-muted">{t("settings.sessions.proposalsHint")}</p>
        {proposalsLoading ? (
          <div className="flex items-center gap-2 py-3 text-[12px] text-muted">
            <Loader2 className="size-3.5 animate-spin" />
            {t("settings.sessions.loading")}
          </div>
        ) : proposals.length === 0 ? (
          <p className="py-3 text-[12px] text-muted">{t("settings.sessions.proposalsEmpty")}</p>
        ) : (
          <ul className="space-y-2">
            {proposals.map((p) => {
              const busy = busyId === p.fileName;
              const pending = p.status !== "applied";
              return (
                <li
                  key={p.fileName}
                  className="rounded-md border border-border-soft bg-elevated/25 px-2.5 py-2"
                >
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-medium text-foreground">
                        {p.title || p.sessionId.slice(0, 16)}
                        <span className="ml-2 text-[10px] font-normal uppercase text-muted">
                          {p.status || "pending"} · {p.via || "?"}
                        </span>
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {p.preview.map((row, i) => (
                          <li key={i} className="truncate font-mono text-[10px] text-secondary">
                            <span className="text-primary">{row.target}</span>
                            {" · "}
                            {row.contentPreview}
                          </li>
                        ))}
                      </ul>
                    </div>
                    {pending && (
                      <div className="flex shrink-0 gap-1">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void applyProposal(p.fileName, "apply_safe")}
                        >
                          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                          {t("settings.sessions.applySafe")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void applyProposal(p.fileName, "apply_all")}
                        >
                          {t("settings.sessions.applyAll")}
                        </Button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
