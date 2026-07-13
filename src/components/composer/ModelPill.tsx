import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, RefreshCw, Search } from "lucide-react";
import { gateway, type ModelCatalogEntry } from "@/lib/gateway";
import { supportsModelTuning } from "@/lib/model-capabilities";
import { displayModelName, formatModelStatusLabel, modelDisplayParts, reasoningEffortLabel } from "@/lib/model-status-label";
import type { ProviderProfile, ProviderProtocol } from "@/lib/types";
import { setModelPreset, useModelPreset } from "@/store/model-presets";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Switch,
  dropdownMenuRow,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import type { ChatTranslationKey } from "@/lib/slash-commands";

const EFFORTS = [
  { value: "minimal", labelKey: "chat.model.effort.minimal" },
  { value: "low", labelKey: "chat.model.effort.low" },
  { value: "medium", labelKey: "chat.model.effort.medium" },
  { value: "high", labelKey: "chat.model.effort.high" },
  { value: "max", labelKey: "chat.model.effort.max" },
] as const satisfies readonly { value: string; labelKey: ChatTranslationKey }[];

/** Per-model options are shown only where the engine can serialize them. */
function ModelOptions({ provider, model, protocol }: { provider: string; model: string; protocol?: ProviderProtocol }) {
  const { t } = useI18n();
  const preset = useModelPreset(provider, model);
  const thinking = preset.thinking !== false;
  const effort = preset.effort || "medium";
  if (!supportsModelTuning(protocol)) {
    return (
      <DropdownMenuSubContent className="w-52">
        <DropdownMenuLabel>{t("chat.model.options")}</DropdownMenuLabel>
        <p className="px-2 py-1.5 text-[11px] leading-4 text-muted">{t("chat.model.tuningUnavailable")}</p>
      </DropdownMenuSubContent>
    );
  }
  return (
    <DropdownMenuSubContent className="w-44">
      <DropdownMenuLabel>{t("chat.model.options")}</DropdownMenuLabel>
      <div className={cn(dropdownMenuRow, "justify-between")} onClick={(e) => e.stopPropagation()}>
        <span>{t("chat.model.thinking")}</span>
        <Switch
          size="xs"
          checked={thinking}
          onCheckedChange={(v) => setModelPreset(provider, model, { thinking: v, ...(!v ? { fast: false } : {}) })}
          aria-label={t("chat.model.thinking")}
        />
      </div>
      <div className={cn(dropdownMenuRow, "justify-between")} onClick={(e) => e.stopPropagation()}>
        <span>{t("chat.model.fast")}</span>
        <Switch
          size="xs"
          checked={Boolean(preset.fast)}
          onCheckedChange={(v) => setModelPreset(provider, model, {
            fast: v,
            ...(v ? { thinking: true, effort: "minimal" } : {}),
          })}
          aria-label={t("chat.model.fast")}
        />
      </div>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{t("chat.model.effort")}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={effort} onValueChange={(v) => setModelPreset(provider, model, { effort: v, thinking: true, fast: false })}>
        {EFFORTS.map((o) => (
          <DropdownMenuRadioItem key={o.value} value={o.value} onSelect={(e) => e.preventDefault()}>
            {t(o.labelKey)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuSubContent>
  );
}

/** A single model row: click selects; hover opens its Options submenu. */
function ModelRow({
  entry,
  protocol,
  active,
  onSelect,
  closeMenu,
}: {
  entry: ModelCatalogEntry;
  protocol?: ProviderProtocol;
  active: boolean;
  onSelect: (providerId: string, modelId: string) => void;
  closeMenu: () => void;
}) {
  const { t } = useI18n();
  const preset = useModelPreset(entry.provider, entry.id);
  const tuningSupported = supportsModelTuning(protocol);
  const meta = tuningSupported
    ? [
        preset.fast ? t("chat.model.fast") : null,
        preset.thinking === false
          ? t("chat.model.effort.off")
          : reasoningEffortLabel(preset.effort || "", t) || t("chat.model.effort.medium"),
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        hideChevron
        className={cn(active && "text-foreground")}
        onClick={() => { onSelect(entry.provider, entry.id); closeMenu(); }}
      >
        <span className="min-w-0 flex-1 truncate">
          {modelDisplayParts(entry.id, t).name}
          <span className="text-muted"> {meta}</span>
        </span>
        {active && <Check className="ml-auto size-3.5 text-primary" aria-hidden />}
      </DropdownMenuSubTrigger>
      <ModelOptions provider={entry.provider} model={entry.id} protocol={protocol} />
    </DropdownMenuSub>
  );
}

export function ModelPill({
  model,
  provider,
  providers,
  disabled,
  onModelChange,
}: {
  model: string;
  provider: string;
  providers: readonly ProviderProfile[];
  disabled?: boolean;
  onModelChange: (providerId: string, modelId: string) => void;
}) {
  const { t } = useI18n();
  const preset = useModelPreset(provider, model);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [models, setModels] = useState<ModelCatalogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const protocols = useMemo(
    () => new Map(providers.map((profile) => [profile.id, profile.protocol] as const)),
    [providers],
  );

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("kyrei:open-model-picker", onOpen);
    return () => window.removeEventListener("kyrei:open-model-picker", onOpen);
  }, []);

  const load = () => {
    setLoading(true);
    gateway.getModels().then((r) => setModels(r.models)).catch(() => setModels([])).finally(() => setLoading(false));
  };
  useEffect(() => { if (open) load(); }, [open]);

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const byProvider = new Map<string, ModelCatalogEntry[]>();
    for (const m of models) {
      if (q && !`${m.id} ${m.provider}`.toLowerCase().includes(q)) continue;
      const list = byProvider.get(m.provider) ?? [];
      list.push(m);
      byProvider.set(m.provider, list);
    }
    return [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [models, search]);

  const label = supportsModelTuning(protocols.get(provider))
    ? formatModelStatusLabel(model, t, { fastMode: preset.fast, reasoningEffort: preset.thinking === false ? "none" : preset.effort })
    : displayModelName(model, t);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button disabled={disabled} variant="ghost" size="sm" className="max-w-52 gap-1 text-muted hover:text-foreground">
          <span className="truncate">{model.trim() ? label : t("chat.model.choose")}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-72 p-0">
        <div className="flex items-center gap-2 border-b border-border-soft px-2.5 py-2">
          <Search className="size-3.5 shrink-0 text-muted" />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("chat.model.search")}
            aria-label={t("chat.model.search")}
            className="w-full bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted"
          />
        </div>

        <div className="max-h-[max(180px,42dvh)] overflow-y-auto p-1">
          {loading && models.length === 0 ? (
            <div className="px-2 py-2 text-[12px] text-muted">{t("chat.model.loading")}</div>
          ) : groups.length === 0 ? (
            <div className="px-2 py-2 text-[12px] text-muted">
              {models.length === 0 ? t("chat.model.catalogUnavailable") : t("chat.model.noResults")}
            </div>
          ) : (
            groups.map(([prov, list]) => (
              <div key={prov} className="py-0.5">
                <DropdownMenuLabel>{list[0]?.providerName ?? prov}</DropdownMenuLabel>
                {list.map((m) => (
                  <ModelRow
                    key={`${m.provider}:${m.id}`}
                    entry={m}
                    protocol={protocols.get(m.provider)}
                    active={m.id === model && m.provider === provider}
                    onSelect={onModelChange}
                    closeMenu={() => setOpen(false)}
                  />
                ))}
              </div>
            ))
          )}
        </div>

        <DropdownMenuSeparator className="my-0" />
        <div className="p-1">
          <DropdownMenuItem className={cn(dropdownMenuRow, "text-muted")} disabled={loading} onSelect={(e) => { e.preventDefault(); load(); }}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} /> {t("chat.model.refresh")}
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
