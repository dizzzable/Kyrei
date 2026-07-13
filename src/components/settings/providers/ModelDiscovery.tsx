import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Button, Input, Textarea } from "@/components/ui";
import { useI18n } from "@/i18n";
import type { ProviderModel } from "@/lib/types";

interface ModelDiscoveryProps {
  models: ProviderModel[];
  selectedIds: ReadonlySet<string>;
  manualModel: string;
  disabled?: boolean;
  onSelectedIdsChange: (ids: Set<string>) => void;
  onManualModelChange: (value: string) => void;
}

export function ModelDiscovery({
  models,
  selectedIds,
  manualModel,
  disabled,
  onSelectedIdsChange,
  onManualModelChange,
}: ModelDiscoveryProps) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? models.filter((model) => `${model.id} ${model.name ?? ""}`.toLowerCase().includes(query)) : models;
  }, [models, search]);

  const toggle = (modelId: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) next.add(modelId);
    else next.delete(modelId);
    onSelectedIdsChange(next);
  };

  return (
    <fieldset className="space-y-2">
      <legend className="text-[11px] font-medium text-secondary">{t("settings.providers.models")}</legend>
      {models.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-border-soft bg-bg/25">
          <div className="flex items-center gap-2 border-b border-border-soft px-2.5 py-1.5">
            <Search className="size-3.5 text-muted" aria-hidden />
            <Input
              value={search}
              disabled={disabled}
              onChange={(event) => setSearch(event.target.value)}
              aria-label={t("settings.providers.discovery.search")}
              placeholder={t("settings.providers.discovery.search")}
              className="h-7 border-0 bg-transparent px-0 focus:ring-0"
            />
            <span className="shrink-0 font-mono text-[9.5px] text-muted">{selectedIds.size}/{models.length}</span>
          </div>
          <div className="flex items-center gap-1 border-b border-border-soft px-2 py-1">
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onSelectedIdsChange(new Set(models.map((model) => model.id)))}>
              {t("settings.providers.discovery.selectAll")}
            </Button>
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onSelectedIdsChange(new Set())}>
              {t("settings.providers.discovery.clear")}
            </Button>
          </div>
          <div className="max-h-44 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-[11px] text-muted">{t("settings.providers.discovery.noResults")}</p>
            ) : filtered.map((model) => (
              <label key={model.id} className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-(--ui-row-hover)">
                <input
                  type="checkbox"
                  checked={selectedIds.has(model.id)}
                  disabled={disabled}
                  onChange={(event) => toggle(model.id, event.target.checked)}
                  className="mt-0.5 accent-(--color-primary)"
                />
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[10.5px] text-foreground">{model.id}</span>
                  {model.name && model.name !== model.id ? <span className="block truncate text-[9.5px] text-muted">{model.name}</span> : null}
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-border-soft px-3 py-2 text-[11px] text-muted">{t("settings.providers.discovery.emptyHint")}</p>
      )}
      <label className="block space-y-1">
        <span className="text-[10.5px] text-muted">{t("settings.providers.manualModels")}</span>
        <Textarea
          rows={2}
          disabled={disabled}
          value={manualModel}
          onChange={(event) => onManualModelChange(event.target.value)}
          placeholder={t("settings.providers.manualModelsPlaceholder")}
          className="min-h-14 font-mono text-[11px]"
        />
      </label>
    </fieldset>
  );
}
