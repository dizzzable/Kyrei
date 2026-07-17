/**
 * Wave H — LTM decisions browser: pin toggle + SUPERSEDE history.
 * Ledger remains under workspace/ltm/; this is a read/pin UI only.
 */
import { useCallback, useEffect, useState } from "react";
import { Pin, PinOff, History, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { gateway } from "@/lib/gateway";
import type { LtmDecisionRow } from "@/lib/types";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

export function LtmDecisionsPanel() {
  const { t } = useI18n();
  const [rows, setRows] = useState<LtmDecisionRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [historyById, setHistoryById] = useState<Record<string, LtmDecisionRow[]>>({});
  const [pinBusyId, setPinBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await gateway.listLtmDecisions(showHistory);
      if (!result.ok) {
        setError(result.error ?? "error");
        setRows([]);
        return;
      }
      setRows(result.decisions ?? []);
    } catch (e) {
      setError((e as Error).message ?? "request_failed");
      setRows([]);
    } finally {
      setBusy(false);
    }
  }, [showHistory]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (historyById[id]) return;
    try {
      const result = await gateway.fetchLtmDecision(id);
      if (result.ok && result.history) {
        setHistoryById((prev) => ({ ...prev, [id]: result.history ?? [] }));
      }
    } catch {
      /* optional */
    }
  };

  const togglePin = async (row: LtmDecisionRow) => {
    if (!row.active) return;
    setPinBusyId(row.id);
    setNote(null);
    try {
      const result = await gateway.pinLtmDecision(row.id, !row.pinned);
      if (!result.ok) {
        setNote(result.error ?? "pin_failed");
        return;
      }
      setNote(
        result.unchanged
          ? t("settings.ltmDecisions.pinUnchanged")
          : t(
              result.pinned
                ? "settings.ltmDecisions.pinOkOn"
                : "settings.ltmDecisions.pinOkOff",
              { id: result.id ?? row.id },
            ),
      );
      await load();
    } catch (e) {
      setNote((e as Error).message ?? "pin_failed");
    } finally {
      setPinBusyId(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] leading-snug text-muted">{t("settings.ltmDecisions.hint")}</p>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[12px] text-muted">
            <input
              type="checkbox"
              checked={showHistory}
              onChange={(e) => setShowHistory(e.target.checked)}
              className="size-3.5 rounded border-border"
            />
            {t("settings.ltmDecisions.showSuperseded")}
          </label>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
            <RefreshCw className={`mr-1 size-3.5 ${busy ? "animate-spin" : ""}`} />
            {busy ? t("settings.ltmDecisions.loading") : t("settings.ltmDecisions.refresh")}
          </Button>
        </div>
      </div>

      {error && (
        <p className="rounded-md border border-border-soft bg-elevated/40 px-2.5 py-1.5 text-[12px] text-muted" role="status">
          {t("settings.ltmDecisions.error", { error })}
        </p>
      )}
      {note && !error && (
        <p className="text-[12px] text-muted" role="status">
          {note}
        </p>
      )}

      {!error && rows.length === 0 && !busy && (
        <p className="text-[12px] text-muted">{t("settings.ltmDecisions.empty")}</p>
      )}

      <ul className="divide-y divide-border-soft rounded-lg border border-border-soft">
        {rows.map((row) => {
          const open = expandedId === row.id;
          const history = historyById[row.id] ?? [];
          return (
            <li key={row.id} className="px-3 py-2.5">
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  className="mt-0.5 shrink-0 text-muted hover:text-foreground"
                  onClick={() => void toggleExpand(row.id)}
                  aria-expanded={open}
                  title={t("settings.ltmDecisions.historyToggle")}
                >
                  {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[11px] text-muted">{row.id}</span>
                    {row.pinned && (
                      <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        {t("settings.ltmDecisions.badgePinned")}
                      </span>
                    )}
                    {!row.active && (
                      <span className="rounded bg-elevated px-1.5 py-0.5 text-[10px] text-muted">
                        {t("settings.ltmDecisions.badgeSuperseded")}
                      </span>
                    )}
                    <span className="text-[10px] uppercase tracking-wide text-muted">{row.kind}</span>
                  </div>
                  <p className="mt-0.5 text-[13px] leading-snug text-foreground">{clip(row.decision, 280)}</p>
                  {row.rationale ? (
                    <p className="mt-0.5 text-[11px] leading-snug text-muted">{clip(row.rationale, 200)}</p>
                  ) : null}
                  {row.supersedes ? (
                    <p className="mt-0.5 font-mono text-[10px] text-muted">
                      ← {row.supersedes}
                    </p>
                  ) : null}
                </div>
                {row.active && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={pinBusyId === row.id}
                    onClick={() => void togglePin(row)}
                    title={row.pinned ? t("settings.ltmDecisions.unpin") : t("settings.ltmDecisions.pin")}
                    aria-label={row.pinned ? t("settings.ltmDecisions.unpin") : t("settings.ltmDecisions.pin")}
                  >
                    {row.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                  </Button>
                )}
              </div>
              {open && (
                <div className="mt-2 ml-6 rounded-md border border-border-soft bg-elevated/30 px-2.5 py-2">
                  <p className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted">
                    <History className="size-3.5" />
                    {t("settings.ltmDecisions.historyTitle")}
                  </p>
                  {history.length === 0 ? (
                    <p className="text-[11px] text-muted">{t("settings.ltmDecisions.historyEmpty")}</p>
                  ) : (
                    <ul className="space-y-1">
                      {history.map((h) => (
                        <li key={h.id} className="text-[11px] leading-snug text-muted">
                          <span className="font-mono">{h.id}</span>
                          {h.validTo ? ` · ${t("settings.ltmDecisions.badgeSuperseded")}` : ""}: {clip(h.decision, 160)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
