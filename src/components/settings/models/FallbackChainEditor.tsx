import { ArrowDown, ArrowUp, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui";
import { useI18n } from "@/i18n";
import type { ModelRef, ProviderProfile } from "@/lib/types";
import {
  MAX_FALLBACK_MODELS,
  moveFallbackModel,
  nextFallbackModel,
  normalizeFallbackModels,
} from "./fallback-chain";
import { modelOptionsForProvider, selectableModelProviders } from "./model-options";

interface FallbackChainEditorProps {
  main: ModelRef;
  values: readonly ModelRef[];
  providers: ProviderProfile[];
  busy?: boolean;
  onChange: (values: ModelRef[]) => void;
}

export function FallbackChainEditor({ main, values, providers, busy, onChange }: FallbackChainEditorProps) {
  const { t } = useI18n();
  const selectableProviders = useMemo(() => selectableModelProviders(providers), [providers]);
  const normalized = useMemo(() => normalizeFallbackModels(values, providers), [providers, values]);
  const candidate = nextFallbackModel(normalized, providers, main);

  const replace = (index: number, value: ModelRef) => {
    const next = normalized.map((entry, entryIndex) => entryIndex === index ? value : entry);
    onChange(normalizeFallbackModels(next, providers));
  };

  return (
    <section className="max-w-4xl" aria-labelledby="fallback-models-title">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="fallback-models-title" className="text-[12px] font-semibold text-foreground">{t("settings.model.fallback.title")}</h3>
          <p className="mt-1 max-w-3xl text-[10.5px] leading-4 text-muted">{t("settings.model.fallback.hint")}</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !candidate || normalized.length >= MAX_FALLBACK_MODELS}
          onClick={() => candidate && onChange([...normalized, candidate])}
        >
          <Plus className="size-3.5" aria-hidden />{t("settings.model.fallback.add")}
        </Button>
      </div>

      {normalized.length === 0 ? (
        <div className="flex min-h-20 items-center gap-3 rounded-lg border border-dashed border-border-soft px-4 py-3 text-[10.5px] text-muted">
          <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden />
          <span>{t("settings.model.fallback.empty")}</span>
        </div>
      ) : (
        <ol className="divide-y divide-border-soft border-y border-border-soft">
          {normalized.map((value, index) => {
            const models = modelOptionsForProvider(selectableProviders, value.providerId);
            return (
              <li key={`${value.providerId}\0${value.modelId}`} className="grid items-end gap-2 py-3 sm:grid-cols-[2rem_minmax(0,12rem)_minmax(0,1fr)_auto]">
                <span className="grid h-8 place-items-center font-mono text-[10px] text-faint" aria-label={t("settings.model.fallback.position", { count: index + 1 })}>{index + 1}</span>
                <label className="space-y-1">
                  <span className="text-[10px] text-muted">{t("settings.model.provider")}</span>
                  <select
                    value={value.providerId}
                    disabled={busy}
                    onChange={(event) => {
                      const providerId = event.target.value;
                      const modelId = modelOptionsForProvider(selectableProviders, providerId)[0]?.id ?? "";
                      if (modelId) replace(index, { providerId, modelId });
                    }}
                    className="h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[11px] text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
                  >
                    {selectableProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-[10px] text-muted">{t("settings.model.model")}</span>
                  <select
                    value={value.modelId}
                    disabled={busy}
                    onChange={(event) => replace(index, { providerId: value.providerId, modelId: event.target.value })}
                    className="h-8 w-full rounded-md border border-border bg-surface px-2.5 font-mono text-[10.5px] text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
                  >
                    {models.map((model) => <option key={model.id} value={model.id}>{model.name ?? model.id}</option>)}
                  </select>
                </label>
                <div className="flex items-center justify-end gap-0.5">
                  <Button size="icon-sm" variant="ghost" disabled={busy || index === 0} onClick={() => onChange(moveFallbackModel(normalized, index, index - 1))} aria-label={t("settings.model.fallback.moveUp")} title={t("settings.model.fallback.moveUp")}><ArrowUp className="size-3.5" aria-hidden /></Button>
                  <Button size="icon-sm" variant="ghost" disabled={busy || index === normalized.length - 1} onClick={() => onChange(moveFallbackModel(normalized, index, index + 1))} aria-label={t("settings.model.fallback.moveDown")} title={t("settings.model.fallback.moveDown")}><ArrowDown className="size-3.5" aria-hidden /></Button>
                  <Button size="icon-sm" variant="ghost" disabled={busy} onClick={() => onChange(normalized.filter((_, entryIndex) => entryIndex !== index))} aria-label={t("settings.model.fallback.remove")} title={t("settings.model.fallback.remove")}><Trash2 className="size-3.5" aria-hidden /></Button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
