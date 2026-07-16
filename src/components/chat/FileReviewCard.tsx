import { useState } from "react";
import { Check, ChevronDown, ChevronRight, FileDiff, Loader2, RotateCcw, X } from "lucide-react";

import { Button } from "@/components/ui";
import { useI18n } from "@/i18n";
import type { FileReviewFile, FileReviewHunk, FileReviewState } from "@/lib/types";
import { cn } from "@/lib/utils";

export function FileReviewCard({
  review,
  onDecision,
  onFileDecision,
  onHunkDecision,
}: {
  review: FileReviewState;
  onDecision?: (accept: boolean) => Promise<void> | void;
  onFileDecision?: (path: string, accept: boolean) => Promise<void> | void;
  onHunkDecision?: (path: string, hunkId: string, accept: boolean) => Promise<void> | void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const pending = review.status === "pending" || review.status === "partial";
  const pendingCount = review.files.filter((f) => f.status === "pending").length;

  const decideAll = async (accept: boolean) => {
    if (!onDecision || busy || !pending) return;
    setBusy(true);
    try {
      await onDecision(accept);
    } finally {
      setBusy(false);
    }
  };

  const decideFile = async (file: FileReviewFile, accept: boolean) => {
    if (!onFileDecision || busy || file.status !== "pending") return;
    setBusy(true);
    try {
      await onFileDecision(file.path, accept);
    } finally {
      setBusy(false);
    }
  };

  const decideHunk = async (file: FileReviewFile, hunk: FileReviewHunk, accept: boolean) => {
    if (!onHunkDecision || busy || file.status !== "pending" || hunk.status !== "pending") return;
    setBusy(true);
    try {
      await onHunkDecision(file.path, hunk.id, accept);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className={cn(
        "my-2 overflow-hidden rounded-lg border bg-surface/65",
        pending ? "border-primary/35" : "border-border-soft",
      )}
      aria-label={t("chat.fileReview.title")}
    >
      <div className="flex items-start gap-3 px-3.5 py-3">
        <span className={cn(
          "mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border",
          pending
            ? "border-primary/30 bg-primary/10 text-primary"
            : review.status === "accepted"
              ? "border-success/25 bg-success/8 text-success"
              : "border-danger/25 bg-danger/8 text-danger",
        )}>
          {busy ? <Loader2 className="size-3.5 animate-spin" />
            : review.status === "accepted" ? <Check className="size-3.5" />
              : review.status === "rejected" ? <RotateCcw className="size-3.5" />
                : <FileDiff className="size-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[11.5px] font-semibold text-foreground">
              {t("chat.fileReview.title")}
            </span>
            <span className="rounded border border-border-soft bg-elevated/70 px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-muted">
              {t("chat.fileReview.supervised")}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-secondary">
            {pending
              ? t("chat.fileReview.pendingHint", { count: pendingCount || review.files.length })
              : review.status === "accepted"
                ? t("chat.fileReview.acceptedHint")
                : review.status === "partial"
                  ? t("chat.fileReview.partialHint")
                  : t("chat.fileReview.rejectedHint")}
          </p>
          <ul className="mt-2 space-y-1">
            {review.files.map((file, index) => {
              const open = openPath === file.path;
              const hunks = Array.isArray(file.hunks) ? file.hunks : [];
              const pendingHunks = hunks.filter((h) => h.status === "pending").length;
              return (
                <li
                  key={`${file.path}-${index}`}
                  className="rounded-md border border-border-soft/80 bg-elevated/30"
                >
                  <div className="flex items-center gap-1.5 px-2 py-1.5">
                    <button
                      type="button"
                      className="grid size-5 shrink-0 place-items-center text-muted"
                      onClick={() => setOpenPath(open ? null : file.path)}
                      aria-expanded={open}
                      title={t("chat.fileReview.toggleDiff")}
                    >
                      {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    </button>
                    <span className={cn(
                      "rounded px-1 py-0.5 text-[9px] uppercase",
                      file.status === "pending" && "bg-primary/10 text-primary",
                      file.status === "accepted" && "bg-success/10 text-success",
                      file.status === "rejected" && "bg-danger/10 text-danger",
                    )}>
                      {file.status}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted">
                      <span className="text-secondary">{file.tool}</span>
                      {" · "}
                      {file.path}
                      {hunks.length > 0 && (
                        <span className="ml-1 text-[9.5px] text-muted">
                          · {t("chat.fileReview.hunkCount", { count: hunks.length })}
                          {pendingHunks > 0 ? ` (${pendingHunks})` : ""}
                        </span>
                      )}
                    </span>
                    {file.status === "pending" && onFileDecision && (
                      <span className="flex shrink-0 gap-1">
                        <Button size="sm" variant="ghost" className="h-6 px-1.5" disabled={busy} onClick={() => void decideFile(file, true)} title={t("chat.fileReview.acceptFile")}>
                          <Check className="size-3" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-6 px-1.5" disabled={busy} onClick={() => void decideFile(file, false)} title={t("chat.fileReview.rejectFile")}>
                          <X className="size-3" />
                        </Button>
                      </span>
                    )}
                  </div>
                  {open && (
                    <div className="border-t border-border-soft">
                      {hunks.length > 0 ? (
                        <ul className="divide-y divide-border-soft/80">
                          {hunks.map((hunk) => (
                            <li key={hunk.id} className="px-2 py-1.5">
                              <div className="mb-1 flex items-center gap-1.5">
                                <span className={cn(
                                  "rounded px-1 py-0.5 text-[9px] uppercase",
                                  hunk.status === "pending" && "bg-primary/10 text-primary",
                                  hunk.status === "accepted" && "bg-success/10 text-success",
                                  hunk.status === "rejected" && "bg-danger/10 text-danger",
                                )}>
                                  {hunk.id} · {hunk.status}
                                </span>
                                {file.status === "pending" && hunk.status === "pending" && onHunkDecision && (
                                  <span className="ml-auto flex shrink-0 gap-1">
                                    <Button size="sm" variant="ghost" className="h-6 px-1.5" disabled={busy} onClick={() => void decideHunk(file, hunk, true)} title={t("chat.fileReview.acceptHunk")}>
                                      <Check className="size-3" />
                                    </Button>
                                    <Button size="sm" variant="ghost" className="h-6 px-1.5" disabled={busy} onClick={() => void decideHunk(file, hunk, false)} title={t("chat.fileReview.rejectHunk")}>
                                      <X className="size-3" />
                                    </Button>
                                  </span>
                                )}
                              </div>
                              <pre className="max-h-28 overflow-auto font-mono text-[10px] leading-snug text-secondary whitespace-pre-wrap">
                                {hunk.preview}
                              </pre>
                            </li>
                          ))}
                        </ul>
                      ) : file.diffPreview ? (
                        <pre className="max-h-40 overflow-auto px-2 py-1.5 font-mono text-[10px] leading-snug text-secondary whitespace-pre-wrap">
                          {file.diffPreview}
                        </pre>
                      ) : (
                        <p className="px-2 py-1.5 text-[10.5px] text-muted">{t("chat.fileReview.noDiff")}</p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {pending && onDecision && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={() => void decideAll(true)}>
                <Check className="size-3.5" />
                {t("chat.fileReview.accept")}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void decideAll(false)}>
                <X className="size-3.5" />
                {t("chat.fileReview.reject")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
