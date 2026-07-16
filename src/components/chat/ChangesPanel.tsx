import { FileDiff, Loader2, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui";
import { useI18n } from "@/i18n";
import { gateway } from "@/lib/gateway";
import { cn } from "@/lib/utils";

export type SessionChangeRow = {
  messageId: string;
  path: string;
  tool: string;
  snapshotId?: string;
  at?: string;
  diffPreview?: string;
};

export function ChangesPanel({
  open,
  sessionId,
  onClose,
  onReverted,
}: {
  open: boolean;
  sessionId: string | null;
  onClose: () => void;
  onReverted?: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const [loading, setLoading] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<SessionChangeRow[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmRevert, setConfirmRevert] = useState(false);

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await gateway.getSessionChanges(sessionId);
      setChanges(result.changes ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setChanges([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!open) {
      setConfirmRevert(false);
      setExpanded(null);
      setError(null);
      return;
    }
    void load();
  }, [open, load]);

  const revertAll = async () => {
    if (!sessionId || reverting) return;
    setReverting(true);
    setError(null);
    try {
      await gateway.revertAllSessionChanges(sessionId);
      setConfirmRevert(false);
      await onReverted?.();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setReverting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex max-h-[min(80vh,36rem)] w-[min(94vw,28rem)] flex-col gap-0 p-0" showClose>
        <DialogHeader className="border-b border-border-soft px-4 py-3 mb-0">
          <DialogTitle id={titleId} className="flex items-center gap-2 text-[14px]">
            <FileDiff className="size-4 text-primary" />
            {t("chat.changes.panelTitle")}
          </DialogTitle>
          <DialogDescription className="text-[11.5px]">
            {t("chat.changes.panelHint")}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {loading && (
            <div className="flex items-center gap-2 px-1 py-6 text-[12px] text-muted">
              <Loader2 className="size-3.5 animate-spin" />
              {t("chat.changes.loading")}
            </div>
          )}
          {!loading && error && (
            <div className="rounded-md border border-danger/35 bg-danger/8 px-2.5 py-2 text-[11px] text-danger">
              {error}
            </div>
          )}
          {!loading && !error && changes.length === 0 && (
            <p className="px-1 py-6 text-center text-[12px] text-muted">
              {t("chat.changes.empty")}
            </p>
          )}
          {!loading && changes.length > 0 && (
            <ul className="space-y-1.5">
              {changes.map((row, index) => {
                const key = `${row.messageId}-${row.path}-${index}`;
                const openRow = expanded === key;
                return (
                  <li
                    key={key}
                    className="overflow-hidden rounded-md border border-border-soft bg-elevated/30"
                  >
                    <button
                      type="button"
                      className="flex w-full items-start gap-2 px-2.5 py-2 text-left hover:bg-(--ui-row-hover)"
                      onClick={() => setExpanded(openRow ? null : key)}
                    >
                      <span className="mt-0.5 rounded border border-border-soft bg-bg/60 px-1 py-0.5 text-[9px] uppercase text-muted">
                        {row.tool}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[11px] text-foreground">
                          {row.path}
                        </span>
                        {row.snapshotId && (
                          <span className="mt-0.5 block truncate font-mono text-[9.5px] text-muted">
                            snap · {row.snapshotId}
                          </span>
                        )}
                      </span>
                    </button>
                    {openRow && row.diffPreview && (
                      <pre className="max-h-36 overflow-auto border-t border-border-soft bg-bg/50 px-2.5 py-1.5 font-mono text-[10px] leading-snug text-secondary whitespace-pre-wrap">
                        {row.diffPreview}
                      </pre>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter className={cn("mt-0 border-t border-border-soft px-3 py-2.5", "justify-between gap-2")}>
          <span className="text-[10.5px] text-muted">
            {changes.length
              ? t("chat.changes.count", { count: changes.length })
              : null}
          </span>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={reverting}>
              <X className="size-3.5" />
              {t("common.close")}
            </Button>
            <Button
              size="sm"
              variant={confirmRevert ? "destructive" : "outline"}
              disabled={!changes.length || loading || reverting || !sessionId}
              onClick={() => {
                if (!confirmRevert) {
                  setConfirmRevert(true);
                  return;
                }
                void revertAll();
              }}
            >
              {reverting ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
              {confirmRevert ? t("chat.changes.revertConfirm") : t("chat.changes.revertAll")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
