import { useEffect, useMemo, useState } from "react";
import { ChevronDown, RefreshCw, Search } from "lucide-react";
import { gateway, type ModelCatalogEntry } from "@/lib/gateway";
import { formatModelStatusLabel, modelDisplayParts, reasoningEffortLabel } from "@/lib/model-status-label";
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

const EFFORTS = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

/** Per-model Options submenu — Thinking toggle + Effort radio (Hermes parity). */
function ModelOptions({ provider, model }: { provider: string; model: string }) {
  const preset = useModelPreset(provider, model);
  const thinking = preset.thinking !== false;
  const effort = preset.effort || "medium";
  return (
    <DropdownMenuSubContent className="w-44">
      <DropdownMenuLabel>Options</DropdownMenuLabel>
      <div className={cn(dropdownMenuRow, "justify-between")} onClick={(e) => e.stopPropagation()}>
        <span>Thinking</span>
        <Switch
          size="xs"
          checked={thinking}
          onCheckedChange={(v) => setModelPreset(provider, model, { thinking: v })}
          aria-label="Thinking"
        />
      </div>
      <div className={cn(dropdownMenuRow, "justify-between")} onClick={(e) => e.stopPropagation()}>
        <span>Fast</span>
        <Switch
          size="xs"
          checked={Boolean(preset.fast)}
          onCheckedChange={(v) => setModelPreset(provider, model, { fast: v })}
          aria-label="Fast"
        />
      </div>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Effort</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={effort} onValueChange={(v) => setModelPreset(provider, model, { effort: v, thinking: true })}>
        {EFFORTS.map((o) => (
          <DropdownMenuRadioItem key={o.value} value={o.value} onSelect={(e) => e.preventDefault()}>
            {o.label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuSubContent>
  );
}

/** A single model row: click selects; hover opens its Options submenu. */
function ModelRow({
  entry,
  active,
  onSelect,
  closeMenu,
}: {
  entry: ModelCatalogEntry;
  active: boolean;
  onSelect: (id: string) => void;
  closeMenu: () => void;
}) {
  const preset = useModelPreset(entry.provider, entry.id);
  const meta = [
    preset.fast ? "Fast" : null,
    preset.thinking === false ? "Off" : reasoningEffortLabel(preset.effort || "") || "Med",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        hideChevron
        className={cn(active && "text-foreground")}
        onClick={() => { onSelect(entry.id); closeMenu(); }}
      >
        <span className="min-w-0 flex-1 truncate">
          {modelDisplayParts(entry.id).name}
          <span className="text-muted"> {meta}</span>
        </span>
        {active && <span className="ml-auto text-[11px] text-primary">✓</span>}
      </DropdownMenuSubTrigger>
      <ModelOptions provider={entry.provider} model={entry.id} />
    </DropdownMenuSub>
  );
}

export function ModelPill({
  model,
  provider,
  onModelChange,
}: {
  model: string;
  provider: string;
  onModelChange: (model: string) => void;
}) {
  const preset = useModelPreset(provider, model);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [models, setModels] = useState<ModelCatalogEntry[]>([]);
  const [loading, setLoading] = useState(false);

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

  const label = formatModelStatusLabel(model, { fastMode: preset.fast, reasoningEffort: preset.thinking === false ? "none" : preset.effort });

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="max-w-52 gap-1 text-muted hover:text-foreground">
          <span className="truncate">{model.trim() ? label : "Выбрать модель"}</span>
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
            placeholder="Поиск моделей"
            className="w-full bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted"
          />
        </div>

        <div className="max-h-[max(180px,42dvh)] overflow-y-auto p-1">
          {loading && models.length === 0 ? (
            <div className="px-2 py-2 text-[12px] text-muted">Загрузка…</div>
          ) : groups.length === 0 ? (
            <div className="px-2 py-2 text-[12px] text-muted">
              {models.length === 0 ? "Каталог недоступен — введите модель в настройках." : "Ничего не найдено"}
            </div>
          ) : (
            groups.map(([prov, list]) => (
              <div key={prov} className="py-0.5">
                <DropdownMenuLabel>{prov}</DropdownMenuLabel>
                {list.map((m) => (
                  <ModelRow
                    key={`${m.provider}:${m.id}`}
                    entry={m}
                    active={m.id === model}
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
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} /> Обновить модели
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
