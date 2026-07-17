import { Bot, ChevronRight, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui";
import { useI18n } from "@/i18n";
import type { ModelRef, ProviderProfile } from "@/lib/types";
import { modelOptionsForProvider, resolveModelAssignment, selectableModelProviders } from "./model-options";

interface ModelAssignmentRowProps {
  main: ModelRef;
  assignment?: ModelRef;
  providers: ProviderProfile[];
  busy?: boolean;
  onChange: (assignment: ModelRef | undefined) => void;
  /** i18n keys; default worker assignment copy. */
  labelKey?: string;
  badgeKey?: string;
  descriptionKey?: string;
  dialogTitleKey?: string;
  dialogDescriptionKey?: string;
}

export function ModelAssignmentRow({
  main,
  assignment,
  providers,
  busy,
  onChange,
  labelKey = "settings.model.worker.label",
  badgeKey = "settings.model.worker.badge",
  descriptionKey = "settings.model.worker.description",
  dialogTitleKey = "settings.model.worker.dialogTitle",
  dialogDescriptionKey = "settings.model.worker.dialogDescription",
}: ModelAssignmentRowProps) {
  const { t } = useI18n();
  const resolved = resolveModelAssignment(assignment, main);
  const provider = providers.find((candidate) => candidate.id === resolved.ref.providerId);
  const model = provider?.models.find((candidate) => candidate.id === resolved.ref.modelId);
  const selectableProviders = useMemo(() => selectableModelProviders(providers), [providers]);
  const [open, setOpen] = useState(false);
  const [providerId, setProviderId] = useState(resolved.ref.providerId);
  const [modelId, setModelId] = useState(resolved.ref.modelId);

  useEffect(() => {
    if (!open) return;
    const initialProvider = selectableProviders.find((candidate) => candidate.id === resolved.ref.providerId)
      ?? selectableProviders[0];
    setProviderId(initialProvider?.id ?? "");
    setModelId(initialProvider?.id === resolved.ref.providerId
      ? resolved.ref.modelId
      : initialProvider?.models[0]?.id ?? "");
  }, [open, resolved.ref.providerId, resolved.ref.modelId, selectableProviders]);

  const models = useMemo(() => modelOptionsForProvider(selectableProviders, providerId), [selectableProviders, providerId]);
  const chooseProvider = (nextProviderId: string) => {
    setProviderId(nextProviderId);
    setModelId(modelOptionsForProvider(selectableProviders, nextProviderId)[0]?.id ?? "");
  };

  return (
    <>
      <div className="flex min-h-17 items-center gap-3 border-t border-border-soft py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border-soft text-muted"><Bot className="size-3.5" aria-hidden /></span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-foreground">{t(labelKey as never)}</span>
            <span className="rounded bg-elevated px-1.5 py-0.5 text-[9px] text-muted">{t(badgeKey as never)}</span>
          </span>
          <span className="mt-0.5 block text-[10px] leading-4 text-muted">{t(descriptionKey as never)}</span>
          <span className="mt-1 block truncate font-mono text-[9.5px] text-secondary">
            {resolved.inherited ? `${t("settings.model.inherited")} · ` : ""}{provider?.name ?? resolved.ref.providerId} / {model?.name ?? resolved.ref.modelId}
          </span>
        </span>
        {!resolved.inherited ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onChange(undefined)}>
            <RotateCcw className="size-3.5" aria-hidden /> {t("settings.model.useMain")}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" disabled={busy || selectableProviders.length === 0} onClick={() => setOpen(true)}>
          {t("settings.model.change")} <ChevronRight className="size-3.5" aria-hidden />
        </Button>
      </div>

      <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
        <DialogContent className="w-[min(92vw,30rem)] border border-border">
          <DialogHeader>
            <DialogTitle>{t(dialogTitleKey as never)}</DialogTitle>
            <DialogDescription>{t(dialogDescriptionKey as never)}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-[11px] text-secondary">{t("settings.model.provider")}</span>
              <select value={providerId} disabled={busy} onChange={(event) => chooseProvider(event.target.value)} className="h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[12px] text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/25">
                {selectableProviders.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-secondary">{t("settings.model.model")}</span>
              <select value={modelId} disabled={busy} onChange={(event) => setModelId(event.target.value)} className="h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[12px] text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/25">
                {models.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name ?? candidate.id}</option>)}
              </select>
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            <Button disabled={busy || !providerId || !modelId} onClick={() => { onChange({ providerId, modelId }); setOpen(false); }}>{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
