import { BarChart3, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AccessTokensSettings } from "@/components/settings/AccessTokensSettings";
import { Button, Input, Switch } from "@/components/ui";
import { useI18n } from "@/i18n";
import { gateway, type UsageBudgetConfig, type UsageSummary } from "@/lib/gateway";
import type { AppConfig } from "@/lib/types";
import { cn } from "@/lib/utils";

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function budgetFromEngine(engine: Record<string, unknown> | undefined): UsageBudgetConfig {
  const raw = engine && typeof engine.usageBudget === "object" && engine.usageBudget
    ? engine.usageBudget as Record<string, unknown>
    : {};
  const num = (value: unknown): number | null => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    enabled: raw.enabled === true,
    window: raw.window === "month" ? "month" : "day",
    softCostUsd: num(raw.softCostUsd),
    hardCostUsd: num(raw.hardCostUsd),
    softTokens: num(raw.softTokens) != null ? Math.floor(num(raw.softTokens)!) : null,
    hardTokens: num(raw.hardTokens) != null ? Math.floor(num(raw.hardTokens)!) : null,
  };
}

interface UsageSettingsProps {
  config?: AppConfig | null;
  onSaved?: (config: AppConfig) => void;
}

export function UsageSettings({ config, onSaved }: UsageSettingsProps) {
  const { t } = useI18n();
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [budgetDraft, setBudgetDraft] = useState<UsageBudgetConfig>(() => budgetFromEngine(config?.engine));
  const [budgetBusy, setBudgetBusy] = useState(false);
  const [budgetSaved, setBudgetSaved] = useState(false);
  const [budgetFailed, setBudgetFailed] = useState(false);

  useEffect(() => {
    setBudgetDraft(budgetFromEngine(config?.engine));
  }, [config?.engine]);

  const load = useCallback(async (windowDays: number) => {
    setStatus("loading");
    try {
      const next = await gateway.getUsageSummary(windowDays);
      setSummary(next);
      setStatus("ready");
    } catch {
      setSummary(null);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  const saveBudget = async () => {
    if (!config) return;
    setBudgetBusy(true);
    setBudgetFailed(false);
    try {
      const engine = {
        ...(config.engine ?? {}),
        usageBudget: {
          enabled: budgetDraft.enabled,
          window: budgetDraft.window,
          softCostUsd: budgetDraft.softCostUsd,
          hardCostUsd: budgetDraft.hardCostUsd,
          softTokens: budgetDraft.softTokens,
          hardTokens: budgetDraft.hardTokens,
        },
      };
      const next = await gateway.setConfig({ engine });
      onSaved?.(next);
      setBudgetSaved(true);
      window.setTimeout(() => setBudgetSaved(false), 1400);
      void load(days);
    } catch {
      setBudgetFailed(true);
    } finally {
      setBudgetBusy(false);
    }
  };

  const setLimit = (key: keyof UsageBudgetConfig, raw: string) => {
    if (key === "enabled" || key === "window") return;
    const trimmed = raw.trim();
    if (!trimmed) {
      setBudgetDraft((current) => ({ ...current, [key]: null }));
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) return;
    setBudgetDraft((current) => ({
      ...current,
      [key]: key === "softTokens" || key === "hardTokens" ? Math.floor(n) : n,
    }));
  };

  const budget = summary?.budget;
  const level = budget?.level ?? "ok";

  return (
    <section className="max-w-4xl space-y-4" aria-labelledby="usage-settings-title">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-border-soft bg-surface text-muted">
          <BarChart3 className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="usage-settings-title" className="text-[12px] font-semibold text-foreground">
            {t("settings.usage.title")}
          </h3>
          <p className="mt-1 max-w-2xl text-[10.5px] leading-4 text-muted">{t("settings.usage.hint")}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <select
            value={days}
            className="h-8 rounded-md border border-border bg-surface px-2 text-[11px] text-foreground"
            onChange={(event) => setDays(Number(event.target.value) || 30)}
            aria-label={t("settings.usage.window")}
          >
            <option value={7}>{t("settings.usage.days", { count: 7 })}</option>
            <option value={30}>{t("settings.usage.days", { count: 30 })}</option>
            <option value={90}>{t("settings.usage.days", { count: 90 })}</option>
          </select>
          <Button variant="outline" size="icon-sm" disabled={status === "loading"} onClick={() => void load(days)} aria-label={t("settings.usage.refresh")}>
            {status === "loading" ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </Button>
        </div>
      </div>

      {status === "error" ? (
        <p className="rounded-md border border-border-soft bg-surface/40 px-3 py-2 text-[11px] text-muted">{t("settings.usage.loadFailed")}</p>
      ) : null}

      {budget ? (
        <div
          className={cn(
            "rounded-lg border px-3 py-2.5 text-[11px]",
            level === "hard" && "border-danger/40 bg-danger/5 text-danger",
            level === "soft" && "border-warning/40 bg-warning/5 text-foreground",
            level === "ok" && "border-border-soft bg-surface/45 text-muted",
          )}
          role="status"
        >
          <span className="font-medium text-foreground">{t(`settings.usage.budget.level.${level}`)}</span>
          <span className="mt-0.5 block text-[10.5px] leading-4">
            {t("settings.usage.budget.windowUsed", {
              window: t(`settings.usage.budget.window.${budget.usage.window}`),
              tokens: formatTokens(budget.usage.totalTokens),
              cost: formatUsd(budget.usage.costUsd),
            })}
          </span>
          {budget.blocked ? (
            <span className="mt-1 block text-[10.5px]">{t("settings.usage.budget.blockedHint")}</span>
          ) : null}
        </div>
      ) : null}

      {config ? (
        <div className="space-y-3 rounded-lg border border-border-soft bg-surface/45 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="text-[11px] font-semibold text-foreground">{t("settings.usage.budget.title")}</h4>
              <p className="mt-0.5 text-[10px] leading-4 text-muted">{t("settings.usage.budget.hint")}</p>
            </div>
            <div className="inline-flex items-center gap-2 text-[10.5px] text-secondary">
              <span>{budgetDraft.enabled ? t("settings.usage.budget.on") : t("settings.usage.budget.off")}</span>
              <Switch
                checked={budgetDraft.enabled}
                disabled={budgetBusy}
                onCheckedChange={(enabled) => setBudgetDraft((current) => ({ ...current, enabled }))}
                aria-label={t("settings.usage.budget.toggle")}
              />
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <label className="space-y-1">
              <span className="text-[10px] text-muted">{t("settings.usage.budget.windowLabel")}</span>
              <select
                value={budgetDraft.window}
                disabled={budgetBusy || !budgetDraft.enabled}
                className="h-8 w-full rounded-md border border-border bg-surface px-2 text-[11px]"
                onChange={(event) => setBudgetDraft((current) => ({
                  ...current,
                  window: event.target.value === "month" ? "month" : "day",
                }))}
              >
                <option value="day">{t("settings.usage.budget.window.day")}</option>
                <option value="month">{t("settings.usage.budget.window.month")}</option>
              </select>
            </label>
            {([
              ["softCostUsd", "settings.usage.budget.softCost"],
              ["hardCostUsd", "settings.usage.budget.hardCost"],
              ["softTokens", "settings.usage.budget.softTokens"],
              ["hardTokens", "settings.usage.budget.hardTokens"],
            ] as const).map(([key, labelKey]) => (
              <label key={key} className="space-y-1">
                <span className="text-[10px] text-muted">{t(labelKey)}</span>
                <Input
                  type="number"
                  min={0}
                  step={key.includes("Cost") ? "0.01" : "1"}
                  disabled={budgetBusy || !budgetDraft.enabled}
                  value={budgetDraft[key] ?? ""}
                  placeholder={t("settings.usage.budget.unlimited")}
                  onChange={(event) => setLimit(key, event.target.value)}
                />
              </label>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <Button size="sm" disabled={budgetBusy || !config} onClick={() => void saveBudget()}>
              {budgetBusy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
              {t("settings.usage.budget.save")}
            </Button>
            {budgetSaved ? <span className="text-[10.5px] text-success">{t("settings.saved")}</span> : null}
            {budgetFailed ? <span className="text-[10.5px] text-danger">{t("settings.saveFailed")}</span> : null}
          </div>
        </div>
      ) : null}

      {summary ? (
        <>
          <div className="grid gap-2 sm:grid-cols-4">
            {[
              { label: t("settings.usage.requests"), value: String(summary.requestCount) },
              { label: t("settings.usage.tokens"), value: formatTokens(summary.totalTokens) },
              { label: t("settings.usage.input"), value: formatTokens(summary.inputTokens) },
              { label: t("settings.usage.cost"), value: formatUsd(summary.costUsd) },
            ].map((card) => (
              <div key={card.label} className="rounded-lg border border-border-soft bg-surface/45 px-3 py-2.5">
                <span className="block text-[10px] uppercase tracking-[0.08em] text-muted">{card.label}</span>
                <span className="mt-1 block text-[15px] font-semibold tabular-nums text-foreground">{card.value}</span>
              </div>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <UsageTable
              title={t("settings.usage.byProvider")}
              rows={summary.byProvider.map((row) => ({
                key: row.key,
                tokens: row.totalTokens,
                cost: row.costUsd,
                requests: row.requestCount,
              }))}
              empty={t("settings.usage.empty")}
            />
            <UsageTable
              title={t("settings.usage.byModel")}
              rows={summary.byModel.map((row) => ({
                key: row.key,
                tokens: row.totalTokens,
                cost: row.costUsd,
                requests: row.requestCount,
              }))}
              empty={t("settings.usage.empty")}
            />
          </div>

          <UsageTable
            title={t("settings.usage.byDay")}
            rows={summary.byDay.map((row) => ({
              key: row.day,
              tokens: row.totalTokens,
              cost: row.costUsd,
              requests: row.requestCount,
            }))}
            empty={t("settings.usage.empty")}
          />
        </>
      ) : status === "loading" ? (
        <p className="text-[11px] text-muted">{t("settings.usage.loading")}</p>
      ) : null}

      <p className="text-[10px] leading-4 text-faint">{t("settings.usage.governanceNote")}</p>

      <AccessTokensSettings config={config} onSaved={onSaved} />
    </section>
  );
}

function UsageTable({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: Array<{ key: string; tokens: number; cost: number; requests: number }>;
  empty: string;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-border-soft bg-surface/35">
      <div className="border-b border-border-soft px-3 py-2 text-[11px] font-medium text-foreground">{title}</div>
      {rows.length === 0 ? (
        <p className="px-3 py-3 text-[10.5px] text-muted">{empty}</p>
      ) : (
        <ul className="max-h-56 divide-y divide-border-soft overflow-auto">
          {rows.slice(0, 24).map((row) => (
            <li key={row.key} className={cn("grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-2 px-3 py-1.5 text-[10.5px]")}>
              <span className="min-w-0 truncate text-foreground" title={row.key}>{row.key}</span>
              <span className="tabular-nums text-muted" title={t("settings.usage.requests")}>{row.requests}</span>
              <span className="tabular-nums text-muted">{formatTokens(row.tokens)}</span>
              <span className="tabular-nums text-secondary">{formatUsd(row.cost)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
