import { Check, ChevronRight, KeyRound, Network, Search, Server } from "lucide-react";
import { useState } from "react";

import { Button, IconButton, Input } from "@/components/ui";
import { useI18n } from "@/i18n";
import { providerTemplateDescriptionKey, selectVisibleProviderTemplates } from "@/lib/provider-templates";
import type { ProviderProfile, ProviderTemplate } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ProviderCatalogProps {
  configured: ProviderProfile[];
  templates: ProviderTemplate[];
  activeProviderId: string;
  busy?: boolean;
  onConfigure: (provider: ProviderProfile) => void;
  onManageAccounts: (provider: ProviderProfile) => void;
  onConfigureTemplate: (template: ProviderTemplate) => void;
  onUseDefault: (provider: ProviderProfile) => void;
}

export function ProviderCatalog({
  configured,
  templates,
  activeProviderId,
  busy,
  onConfigure,
  onManageAccounts,
  onConfigureTemplate,
  onUseDefault,
}: ProviderCatalogProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const configuredIds = new Set(configured.map((provider) => provider.id));
  const available = templates.filter((template) => template.custom || !configuredIds.has(template.id));
  const description = (template: ProviderTemplate): string => {
    const key = providerTemplateDescriptionKey(template);
    return key ? t(key) : template.protocol ?? "";
  };
  const visible = selectVisibleProviderTemplates(available, { query, expanded, limit: 10, description });

  return (
    <div className="space-y-7">
      <section aria-labelledby="configured-providers-title">
        <div className="mb-2 flex items-end justify-between gap-3">
          <div>
            <h3 id="configured-providers-title" className="text-[13px] font-semibold text-foreground">{t("settings.providers.configured")}</h3>
            <p className="mt-1 text-[11px] leading-4 text-muted">{t("settings.providers.configuredHint")}</p>
          </div>
          <span className="font-mono text-[10px] text-muted">{configured.length}</span>
        </div>
        <div className="border-y border-border-soft">
          {configured.map((provider, index) => {
            const active = provider.id === activeProviderId;
            const ready = provider.enabled && (!provider.requiresApiKey || provider.hasKey);
            const statusLabel = !provider.enabled
              ? t("settings.providers.unavailable")
              : provider.requiresApiKey && !provider.hasKey
                ? t("settings.providers.needsKey")
                : t("settings.providers.ready");
            return (
              <div key={provider.id} className={cn("flex min-h-14 items-center gap-2 px-3", index > 0 && "border-t border-border-soft")}>
                <button
                  type="button"
                  className="group flex min-w-0 flex-1 items-center gap-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
                  onClick={() => onConfigure(provider)}
                  disabled={busy}
                  aria-label={t("settings.providers.editNamed", { name: provider.name })}
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border-soft bg-surface text-muted">
                    <Server className="size-3.5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[12px] font-medium text-foreground">{provider.name}</span>
                      {active ? <span className="rounded bg-primary/12 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary">{t("settings.providers.defaultBadge")}</span> : null}
                    </span>
                    <span className="mt-0.5 flex items-center gap-2 font-mono text-[9.5px] text-muted">
                      <span className="truncate">{provider.id}</span>
                      <span aria-hidden>·</span>
                      <span className={cn("inline-flex items-center gap-1", ready ? "text-success" : "text-warning")}>
                        {ready ? <Check className="size-2.5" aria-hidden /> : <KeyRound className="size-2.5" aria-hidden />}
                        {statusLabel}
                      </span>
                    </span>
                  </span>
                  <ChevronRight className="size-3.5 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
                </button>
                <IconButton
                  size="icon-sm"
                  tip={t("settings.providers.accounts.manageNamed", { name: provider.name })}
                  disabled={busy}
                  onClick={() => onManageAccounts(provider)}
                  className={cn(provider.accountPool?.enabled && "text-primary")}
                >
                  <Network className="size-3.5" aria-hidden />
                </IconButton>
                {!active ? (
                  <Button variant="ghost" size="sm" disabled={busy || !ready} onClick={() => onUseDefault(provider)}>
                    {t("settings.providers.useDefault")}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="available-providers-title">
        <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
          <div className="max-w-2xl">
            <h3 id="available-providers-title" className="text-[13px] font-semibold text-foreground">{t("settings.providers.available")}</h3>
            <p className="mt-1 text-[11px] leading-4 text-muted">{t("settings.providers.availableHint")}</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="relative block w-52 max-w-full">
              <span className="sr-only">{t("settings.providers.search")}</span>
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("settings.providers.search")}
                className="h-8 pl-8"
              />
            </label>
            {!query && (visible.hiddenCount > 0 || expanded) ? (
              <Button variant="ghost" size="sm" onClick={() => setExpanded((value) => !value)}>
                {expanded ? t("settings.providers.showFewer") : t("settings.providers.showAll", { count: visible.hiddenCount })}
              </Button>
            ) : null}
          </div>
        </div>
        <div className="border-y border-border-soft">
          {visible.items.map((template, index) => (
            <button
              key={template.id}
              type="button"
              disabled={busy}
              onClick={() => onConfigureTemplate(template)}
              className={cn(
                "group flex min-h-13 w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors hover:bg-(--ui-row-hover) focus-visible:ring-2 focus-visible:ring-primary/45",
                index > 0 && "border-t border-border-soft",
              )}
            >
              <span className={cn(
                "grid size-8 shrink-0 place-items-center rounded-md border border-border-soft bg-surface text-muted",
                template.custom && "border-dashed text-primary",
              )}>
                <Server className="size-3.5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-foreground">
                  {template.custom ? t("settings.providers.custom") : template.name}
                </span>
                <span className="mt-0.5 flex min-w-0 items-center gap-2 text-[10px] text-muted">
                  <span className="min-w-0 flex-1 truncate">{template.custom ? t("settings.providers.customHint") : description(template)}</span>
                  {!template.custom && template.protocol ? (
                    <span className="hidden shrink-0 font-mono text-[9px] text-faint sm:inline">{template.protocol}</span>
                  ) : null}
                </span>
              </span>
              <ChevronRight className="size-3.5 text-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
