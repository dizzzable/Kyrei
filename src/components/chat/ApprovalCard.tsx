import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, ShieldAlert, X } from "lucide-react";

import { Button } from "@/components/ui";
import { useI18n } from "@/i18n";
import { buildToolView } from "@/lib/tool-view";
import type { ApprovalPart } from "@/lib/types";
import { cn } from "@/lib/utils";

function boundedArgs(args: unknown): string {
  try {
    const value = JSON.stringify(args);
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  } catch {
    return "";
  }
}

function ApprovalStatusIcon({ status, busy }: { status: ApprovalPart["status"]; busy: boolean }) {
  if (busy) return <Loader2 className="size-3.5 animate-spin" />;
  if (status === "approved") return <Check className="size-3.5" />;
  if (status === "denied" || status === "expired") return <X className="size-3.5" />;
  return <ShieldAlert className="size-3.5" />;
}

export function ApprovalCard({
  part,
  onDecision,
}: {
  part: ApprovalPart;
  onDecision?: (approvalId: string, approved: boolean) => Promise<void> | void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const expiresAtMs = part.expiresAt ? Date.parse(part.expiresAt) : Number.NaN;
  const expired = part.status === "expired"
    || (part.status === "pending" && Number.isFinite(expiresAtMs) && expiresAtMs <= now);
  const effectiveStatus: ApprovalPart["status"] = expired ? "expired" : part.status;

  useEffect(() => {
    const currentTime = Date.now();
    setNow(currentTime);
    if (part.status !== "pending" || !Number.isFinite(expiresAtMs) || expiresAtMs <= currentTime) return;

    const timer = window.setTimeout(() => setNow(Date.now()), expiresAtMs - currentTime + 25);
    return () => window.clearTimeout(timer);
  }, [expiresAtMs, part.status]);

  const view = useMemo(() => buildToolView({
    type: "tool",
    toolCallId: part.toolCallId,
    name: part.name,
    args: part.args,
    running: false,
  }, t), [part.args, part.name, part.toolCallId, t]);
  const detail = view.subtitle || boundedArgs(part.args);
  const resolved = effectiveStatus !== "pending";
  // A saved decision can be retried after a renderer/gateway interruption.
  // Expired requests resume as a denial, so they cannot strand the session.
  const waitingForContinuation = resolved && !part.consumedAt;

  const decide = async (approved: boolean) => {
    if (!onDecision || busy) return;
    setBusy(true);
    try {
      await onDecision(part.approvalId, approved);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className={cn(
        "my-2 overflow-hidden rounded-lg border bg-surface/65",
        effectiveStatus === "pending" ? "border-primary/35" : "border-border-soft",
      )}
      aria-label={t("chat.approval.title")}
    >
      <div className="flex items-start gap-3 px-3.5 py-3">
        <span className={cn(
          "mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border",
          effectiveStatus === "pending"
            ? "border-primary/30 bg-primary/10 text-primary"
            : effectiveStatus === "approved"
              ? "border-success/25 bg-success/8 text-success"
              : "border-danger/25 bg-danger/8 text-danger",
        )}>
          <ApprovalStatusIcon status={effectiveStatus} busy={busy} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[11.5px] font-semibold text-foreground">{t("chat.approval.title")}</span>
            <span className="rounded border border-border-soft bg-elevated/70 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wide text-muted">
              {view.title}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-secondary">
            {expired
              ? t("chat.approval.reason.expired")
              : part.reason === "permission_rule_requires_confirmation"
                ? t("chat.approval.reason.policy")
                : t("chat.approval.reason.fallback")}
          </p>
          {detail && (
            <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border-soft bg-bg/70 px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-secondary">
              {detail}
            </pre>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-soft bg-bg/35 px-3.5 py-2">
        <span className="text-[10px] text-muted">
          {part.consumedAt
            ? effectiveStatus === "approved" ? t("chat.approval.status.approved") : t("chat.approval.status.denied")
            : expired
              ? t("chat.approval.status.expired")
              : waitingForContinuation
                ? t("chat.approval.status.waiting")
                : t("chat.approval.scope.once")}
        </span>
        {!resolved && (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" disabled={busy || !onDecision} onClick={() => void decide(false)}>
              {t("chat.approval.deny")}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy || !onDecision} onClick={() => void decide(true)}>
              {t("chat.approval.allowOnce")}
            </Button>
          </div>
        )}
        {waitingForContinuation && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !onDecision}
            onClick={() => void decide(expired ? false : effectiveStatus === "approved")}
          >
            {t(expired ? "chat.approval.denyAndContinue" : "chat.approval.continue")}
          </Button>
        )}
      </div>
    </section>
  );
}
