import { AlertTriangle, Layers3, LoaderCircle, Network, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button, Switch } from "@/components/ui";
import { useI18n } from "@/i18n";
import { gateway } from "@/lib/gateway";
import type {
  AppConfig,
  CapacityConfig,
  CapacityStrategy,
  ProviderAccount,
  ProviderAccountStatus,
  SubscriptionShieldMode,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const STRATEGIES: readonly CapacityStrategy[] = [
  "spare-first",
  "fill-first",
  "round-robin",
  "least-used",
  "balanced",
  "priority",
];

const SHIELD_MODES: readonly SubscriptionShieldMode[] = ["stealth", "standard", "off"];

const FAMILIES = [
  "claude",
  "gpt",
  "grok",
  "gemini",
  "deepseek",
  "qwen",
  "mistral",
  "llama",
  "kimi",
  "glm",
] as const;

function capacityFromConfig(config: AppConfig | null | undefined): CapacityConfig {
  const raw = config?.capacity;
  const strategy = STRATEGIES.includes(raw?.strategy as CapacityStrategy)
    ? (raw!.strategy as CapacityStrategy)
    : "spare-first";
  const shieldRaw = raw?.subscriptionShield;
  const shieldMode = SHIELD_MODES.includes(shieldRaw?.mode as SubscriptionShieldMode)
    ? (shieldRaw!.mode as SubscriptionShieldMode)
    : "stealth";
  return {
    enabled: raw?.enabled !== false,
    strategy,
    preferSpare: raw?.preferSpare !== false,
    crossProviderFamily: raw?.crossProviderFamily !== false,
    subscriptionShield: {
      enabled: shieldRaw?.enabled !== false && shieldMode !== "off",
      mode: shieldMode,
      minIntervalMs: typeof shieldRaw?.minIntervalMs === "number" ? shieldRaw.minIntervalMs : 75,
      connectTimeoutMs:
        typeof shieldRaw?.connectTimeoutMs === "number"
          ? shieldRaw.connectTimeoutMs
          : (typeof shieldRaw?.headerTimeoutMs === "number" ? shieldRaw.headerTimeoutMs : 0),
      headerTimeoutMs:
        typeof shieldRaw?.headerTimeoutMs === "number"
          ? shieldRaw.headerTimeoutMs
          : (typeof shieldRaw?.connectTimeoutMs === "number" ? shieldRaw.connectTimeoutMs : 0),
      inactivityTimeoutMs:
        typeof shieldRaw?.inactivityTimeoutMs === "number"
          ? shieldRaw.inactivityTimeoutMs
          : 0,
      maxConnectionsPerOrigin:
        typeof shieldRaw?.maxConnectionsPerOrigin === "number"
          ? shieldRaw.maxConnectionsPerOrigin
          : 4,
    },
  };
}

interface CapacitySettingsProps {
  config: AppConfig;
  onSaved: (config: AppConfig) => void;
}

type AccountHealthRow = {
  providerId: string;
  providerName: string;
  accountId: string;
  accountName: string;
  status: ProviderAccountStatus;
  cooldownUntil?: number;
  inflight?: number;
  poolOn: boolean;
  strategy?: string;
};

function resolveAccountStatus(account: ProviderAccount): ProviderAccountStatus {
  if (!account.enabled) return "disabled";
  if (account.status) return account.status;
  return account.ready === false ? "auth-required" : "ready";
}

export function CapacitySettings({ config, onSaved }: CapacitySettingsProps) {
  const { t, date } = useI18n();
  const [draft, setDraft] = useState(() => capacityFromConfig(config));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const [health, setHealth] = useState<AccountHealthRow[]>([]);
  const [healthStatus, setHealthStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    setDraft(capacityFromConfig(config));
  }, [config]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(capacityFromConfig(config)),
    [config, draft],
  );

  const refreshHealth = useCallback(async () => {
    setHealthStatus("loading");
    try {
      const rows: AccountHealthRow[] = [];
      for (const provider of config.providers ?? []) {
        if (!provider.enabled) continue;
        try {
          const snapshot = await gateway.getProviderAccounts(provider.id);
          const accounts = snapshot.accounts ?? [];
          if (!accounts.length) {
            rows.push({
              providerId: provider.id,
              providerName: provider.name,
              accountId: "primary",
              accountName: t("settings.capacity.primaryAccount"),
              status: provider.hasKey || !provider.requiresApiKey ? "ready" : "auth-required",
              poolOn: false,
            });
            continue;
          }
          for (const account of accounts) {
            rows.push({
              providerId: provider.id,
              providerName: provider.name,
              accountId: account.id,
              accountName: account.name || account.id,
              status: resolveAccountStatus(account),
              cooldownUntil: account.cooldownUntil,
              inflight: account.inflight,
              poolOn: snapshot.pool?.enabled === true,
              strategy: snapshot.pool?.strategy,
            });
          }
        } catch {
          rows.push({
            providerId: provider.id,
            providerName: provider.name,
            accountId: "?",
            accountName: t("settings.capacity.healthUnavailable"),
            status: "auth-required",
            poolOn: false,
          });
        }
      }
      setHealth(rows);
      setHealthStatus("ready");
    } catch {
      setHealth([]);
      setHealthStatus("error");
    }
  }, [config.providers, t]);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  const healthCounts = useMemo(() => {
    const counts = { ready: 0, cooldown: 0, "auth-required": 0, disabled: 0 };
    for (const row of health) counts[row.status] += 1;
    return counts;
  }, [health]);

  const problemRows = useMemo(
    () => health.filter((row) => row.status !== "ready"),
    [health],
  );

  const poolSummary = useMemo(() => {
    return (config.providers ?? []).map((provider) => {
      const members = provider.accountPool?.members?.length
        ?? (provider.hasKey || !provider.requiresApiKey ? 1 : 0);
      const poolOn = provider.accountPool?.enabled === true;
      const strategy = provider.accountPool?.strategy ?? "balanced";
      return {
        id: provider.id,
        name: provider.name,
        members: poolOn ? Math.max(members, provider.accountPool?.members?.length ?? 0) : members,
        poolOn,
        strategy,
        ready: provider.enabled && (!provider.requiresApiKey || provider.hasKey),
      };
    });
  }, [config.providers]);

  const save = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const next = await gateway.setConfig({ capacity: draft });
      onSaved(next);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1400);
      void refreshHealth();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="max-w-4xl space-y-5" aria-labelledby="capacity-settings-title">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-border-soft bg-surface text-muted">
          <Layers3 className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="capacity-settings-title" className="text-[12px] font-semibold text-foreground">
            {t("settings.capacity.title")}
          </h3>
          <p className="mt-1 max-w-2xl text-[10.5px] leading-4 text-muted">{t("settings.capacity.hint")}</p>
        </div>
        <div className="inline-flex items-center gap-2 text-[10.5px] text-secondary">
          <span>{draft.enabled ? t("settings.capacity.on") : t("settings.capacity.off")}</span>
          <Switch
            checked={draft.enabled}
            disabled={busy}
            onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
            aria-label={t("settings.capacity.toggle")}
          />
        </div>
      </div>

      <div className={cn(
        "space-y-3 rounded-lg border border-border-soft bg-surface/45 p-3",
        !draft.enabled && "opacity-70",
      )}>
        <label className="block space-y-1">
          <span className="text-[10px] text-muted">{t("settings.capacity.strategy")}</span>
          <select
            value={draft.strategy}
            disabled={busy || !draft.enabled}
            className="h-8 w-full max-w-md rounded-md border border-border bg-surface px-2 text-[11px] text-foreground"
            onChange={(event) => setDraft((current) => ({
              ...current,
              strategy: event.target.value as CapacityStrategy,
            }))}
          >
            {STRATEGIES.map((strategy) => (
              <option key={strategy} value={strategy}>
                {t(`settings.capacity.strategy.${strategy}`)}
              </option>
            ))}
          </select>
          <span className="block text-[10px] leading-4 text-muted">
            {t(`settings.capacity.strategyHint.${draft.strategy}`)}
          </span>
        </label>

        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex items-start gap-2 rounded-md border border-border-soft bg-bg/30 px-2.5 py-2">
            <Switch
              checked={draft.preferSpare}
              disabled={busy || !draft.enabled}
              onCheckedChange={(preferSpare) => setDraft((current) => ({ ...current, preferSpare }))}
              className="mt-0.5"
            />
            <span>
              <span className="block text-[11px] font-medium text-foreground">{t("settings.capacity.preferSpare")}</span>
              <span className="mt-0.5 block text-[10px] leading-4 text-muted">{t("settings.capacity.preferSpareHint")}</span>
            </span>
          </label>
          <label className="flex items-start gap-2 rounded-md border border-border-soft bg-bg/30 px-2.5 py-2">
            <Switch
              checked={draft.crossProviderFamily}
              disabled={busy || !draft.enabled}
              onCheckedChange={(crossProviderFamily) => setDraft((current) => ({ ...current, crossProviderFamily }))}
              className="mt-0.5"
            />
            <span>
              <span className="block text-[11px] font-medium text-foreground">{t("settings.capacity.crossFamily")}</span>
              <span className="mt-0.5 block text-[10px] leading-4 text-muted">{t("settings.capacity.crossFamilyHint")}</span>
            </span>
          </label>
        </div>

        <div className="space-y-2 rounded-md border border-border-soft bg-bg/30 p-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <span className="block text-[11px] font-medium text-foreground">
                {t("settings.capacity.shield.title")}
              </span>
              <span className="mt-0.5 block text-[10px] leading-4 text-muted">
                {t("settings.capacity.shield.hint")}
              </span>
            </div>
            <Switch
              checked={Boolean(draft.subscriptionShield?.enabled) && draft.subscriptionShield?.mode !== "off"}
              disabled={busy}
              onCheckedChange={(enabled) => setDraft((current) => ({
                ...current,
                subscriptionShield: {
                  ...current.subscriptionShield,
                  enabled,
                  mode: enabled
                    ? (current.subscriptionShield?.mode === "off"
                      ? "stealth"
                      : current.subscriptionShield?.mode ?? "stealth")
                    : "off",
                  minIntervalMs: current.subscriptionShield?.minIntervalMs ?? 75,
                  connectTimeoutMs: current.subscriptionShield?.connectTimeoutMs ?? current.subscriptionShield?.headerTimeoutMs ?? 0,
                  headerTimeoutMs: current.subscriptionShield?.headerTimeoutMs ?? current.subscriptionShield?.connectTimeoutMs ?? 0,
                  inactivityTimeoutMs: current.subscriptionShield?.inactivityTimeoutMs ?? 0,
                  maxConnectionsPerOrigin: current.subscriptionShield?.maxConnectionsPerOrigin ?? 4,
                },
              }))}
              className="mt-0.5 shrink-0"
              aria-label={t("settings.capacity.shield.toggle")}
            />
          </div>
          <label className="block space-y-1">
            <span className="text-[10px] text-muted">{t("settings.capacity.shield.mode")}</span>
            <select
              value={draft.subscriptionShield?.mode ?? "stealth"}
              disabled={busy || !draft.subscriptionShield?.enabled || draft.subscriptionShield?.mode === "off"}
              className="h-8 w-full max-w-md rounded-md border border-border bg-surface px-2 text-[11px] text-foreground"
              onChange={(event) => {
                const mode = event.target.value as SubscriptionShieldMode;
                setDraft((current) => ({
                  ...current,
                  subscriptionShield: {
                    ...current.subscriptionShield,
                    mode,
                    enabled: mode !== "off",
                    minIntervalMs: current.subscriptionShield?.minIntervalMs ?? 75,
                    connectTimeoutMs: current.subscriptionShield?.connectTimeoutMs ?? current.subscriptionShield?.headerTimeoutMs ?? 0,
                    headerTimeoutMs: current.subscriptionShield?.headerTimeoutMs ?? current.subscriptionShield?.connectTimeoutMs ?? 0,
                    inactivityTimeoutMs: current.subscriptionShield?.inactivityTimeoutMs ?? 0,
                    maxConnectionsPerOrigin: current.subscriptionShield?.maxConnectionsPerOrigin ?? 4,
                  },
                }));
              }}
            >
              {SHIELD_MODES.filter((mode) => mode !== "off").map((mode) => (
                <option key={mode} value={mode}>
                  {t(`settings.capacity.shield.mode.${mode}`)}
                </option>
              ))}
            </select>
            <span className="block text-[10px] leading-4 text-muted">
              {t(`settings.capacity.shield.modeHint.${draft.subscriptionShield?.mode === "standard" ? "standard" : "stealth"}`)}
            </span>
          </label>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-[10px] text-muted">{t("settings.capacity.shield.headerTimeout")}</span>
              <input
                type="number"
                min={0}
                max={120_000}
                step={1_000}
                value={draft.subscriptionShield?.headerTimeoutMs ?? draft.subscriptionShield?.connectTimeoutMs ?? 0}
                disabled={busy || !draft.subscriptionShield?.enabled || draft.subscriptionShield?.mode === "off"}
                className="h-8 w-full rounded-md border border-border bg-surface px-2 font-mono text-[11px] text-foreground"
                onChange={(event) => {
                  const numeric = Number(event.target.value);
                  const nextValue = Number.isFinite(numeric) ? Math.max(0, Math.min(120_000, Math.floor(numeric))) : 0;
                  setDraft((current) => ({
                    ...current,
                    subscriptionShield: {
                      ...current.subscriptionShield,
                      enabled: current.subscriptionShield?.enabled ?? true,
                      mode: current.subscriptionShield?.mode ?? "stealth",
                      minIntervalMs: current.subscriptionShield?.minIntervalMs ?? 75,
                      connectTimeoutMs: nextValue,
                      headerTimeoutMs: nextValue,
                      inactivityTimeoutMs: current.subscriptionShield?.inactivityTimeoutMs ?? 0,
                      maxConnectionsPerOrigin: current.subscriptionShield?.maxConnectionsPerOrigin ?? 4,
                    },
                  }));
                }}
              />
              <span className="block text-[10px] leading-4 text-muted">{t("settings.capacity.shield.headerTimeoutHint")}</span>
            </label>
            <label className="block space-y-1">
              <span className="text-[10px] text-muted">{t("settings.capacity.shield.inactivityTimeout")}</span>
              <input
                type="number"
                min={0}
                max={120_000}
                step={1_000}
                value={draft.subscriptionShield?.inactivityTimeoutMs ?? 0}
                disabled={busy || !draft.subscriptionShield?.enabled || draft.subscriptionShield?.mode === "off"}
                className="h-8 w-full rounded-md border border-border bg-surface px-2 font-mono text-[11px] text-foreground"
                onChange={(event) => {
                  const numeric = Number(event.target.value);
                  const nextValue = Number.isFinite(numeric) ? Math.max(0, Math.min(120_000, Math.floor(numeric))) : 0;
                  setDraft((current) => ({
                    ...current,
                    subscriptionShield: {
                      ...current.subscriptionShield,
                      enabled: current.subscriptionShield?.enabled ?? true,
                      mode: current.subscriptionShield?.mode ?? "stealth",
                      minIntervalMs: current.subscriptionShield?.minIntervalMs ?? 75,
                      connectTimeoutMs: current.subscriptionShield?.connectTimeoutMs ?? current.subscriptionShield?.headerTimeoutMs ?? 0,
                      headerTimeoutMs: current.subscriptionShield?.headerTimeoutMs ?? current.subscriptionShield?.connectTimeoutMs ?? 0,
                      inactivityTimeoutMs: nextValue,
                      maxConnectionsPerOrigin: current.subscriptionShield?.maxConnectionsPerOrigin ?? 4,
                    },
                  }));
                }}
              />
              <span className="block text-[10px] leading-4 text-muted">{t("settings.capacity.shield.inactivityTimeoutHint")}</span>
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
            {t("settings.capacity.save")}
          </Button>
          {saved ? <span className="text-[10.5px] text-success">{t("settings.saved")}</span> : null}
          {failed ? <span className="text-[10.5px] text-danger">{t("settings.saveFailed")}</span> : null}
        </div>
      </div>

      <div className="rounded-lg border border-border-soft bg-surface/35">
        <div className="border-b border-border-soft px-3 py-2">
          <h4 className="text-[11px] font-semibold text-foreground">{t("settings.capacity.familiesTitle")}</h4>
          <p className="mt-0.5 text-[10px] leading-4 text-muted">{t("settings.capacity.familiesHint")}</p>
        </div>
        <div className="flex flex-wrap gap-1.5 p-3">
          {FAMILIES.map((family) => (
            <span
              key={family}
              className="rounded-md border border-border-soft bg-bg/40 px-2 py-1 font-mono text-[10px] text-secondary"
            >
              {family}
            </span>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-border-soft">
        <div className="flex items-center justify-between gap-2 border-b border-border-soft px-3 py-2">
          <div className="flex items-center gap-2">
            <Network className="size-3.5 text-muted" aria-hidden />
            <div>
              <h4 className="text-[11px] font-semibold text-foreground">{t("settings.capacity.healthTitle")}</h4>
              <p className="text-[10px] leading-4 text-muted">{t("settings.capacity.healthHint")}</p>
            </div>
          </div>
          <Button
            size="icon-sm"
            variant="outline"
            disabled={healthStatus === "loading"}
            onClick={() => void refreshHealth()}
            aria-label={t("settings.capacity.healthRefresh")}
          >
            {healthStatus === "loading"
              ? <LoaderCircle className="size-3.5 animate-spin" />
              : <RefreshCw className="size-3.5" />}
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-2 border-b border-border-soft p-3 sm:grid-cols-4">
          {([
            ["ready", healthCounts.ready, "text-success"],
            ["cooldown", healthCounts.cooldown, "text-warning"],
            ["auth-required", healthCounts["auth-required"], "text-danger"],
            ["disabled", healthCounts.disabled, "text-muted"],
          ] as const).map(([key, count, color]) => (
            <div key={key} className="rounded-md border border-border-soft bg-surface/40 px-2.5 py-2">
              <span className="block text-[9.5px] uppercase tracking-wide text-muted">
                {t(`settings.providers.accounts.status.${key}`)}
              </span>
              <span className={cn("mt-0.5 block text-[15px] font-semibold tabular-nums", color)}>{count}</span>
            </div>
          ))}
        </div>

        {problemRows.length > 0 ? (
          <div className="border-b border-border-soft bg-warning/5 px-3 py-2">
            <p className="inline-flex items-center gap-1.5 text-[10.5px] font-medium text-foreground">
              <AlertTriangle className="size-3.5 text-warning" aria-hidden />
              {t("settings.capacity.problemsTitle", { count: problemRows.length })}
            </p>
            <p className="mt-0.5 text-[10px] leading-4 text-muted">{t("settings.capacity.problemsHint")}</p>
          </div>
        ) : null}

        <ul className="max-h-72 divide-y divide-border-soft overflow-auto">
          {healthStatus === "error" ? (
            <li className="px-3 py-3 text-[10.5px] text-muted">{t("settings.capacity.healthError")}</li>
          ) : health.length === 0 && healthStatus !== "loading" ? (
            <li className="px-3 py-3 text-[10.5px] text-muted">{t("settings.capacity.poolsEmpty")}</li>
          ) : (
            health.map((row) => (
              <li
                key={`${row.providerId}:${row.accountId}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 px-3 py-2 text-[10.5px]"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-foreground">
                    {row.providerName}
                    <span className="font-normal text-muted"> · {row.accountName}</span>
                  </span>
                  <span className="font-mono text-[9.5px] text-muted">
                    {row.providerId}/{row.accountId}
                    {row.poolOn && row.strategy ? ` · ${row.strategy}` : ""}
                    {typeof row.inflight === "number" && row.inflight > 0
                      ? ` · ${t("settings.capacity.inflight", { count: row.inflight })}`
                      : ""}
                  </span>
                </span>
                <span className="text-right">
                  <span
                    className={cn(
                      "inline-flex rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide",
                      row.status === "ready" && "bg-success/12 text-success",
                      row.status === "cooldown" && "bg-warning/15 text-warning",
                      row.status === "auth-required" && "bg-danger/12 text-danger",
                      row.status === "disabled" && "bg-muted/20 text-muted",
                    )}
                  >
                    {t(`settings.providers.accounts.status.${row.status}`)}
                  </span>
                  {row.status === "cooldown" && row.cooldownUntil && row.cooldownUntil > Date.now() ? (
                    <span className="mt-0.5 block text-[9.5px] text-muted">
                      {t("settings.providers.accounts.cooldownUntil", {
                        time: date(row.cooldownUntil, { dateStyle: "short", timeStyle: "short" }),
                      })}
                    </span>
                  ) : null}
                  {row.status === "auth-required" ? (
                    <span className="mt-0.5 block max-w-[12rem] text-[9.5px] leading-3.5 text-danger/90">
                      {t("settings.capacity.authRequiredHint")}
                    </span>
                  ) : null}
                </span>
              </li>
            ))
          )}
        </ul>
      </div>

      <div className="rounded-lg border border-border-soft">
        <div className="flex items-center gap-2 border-b border-border-soft px-3 py-2">
          <Network className="size-3.5 text-muted" aria-hidden />
          <div>
            <h4 className="text-[11px] font-semibold text-foreground">{t("settings.capacity.poolsTitle")}</h4>
            <p className="text-[10px] leading-4 text-muted">{t("settings.capacity.poolsHint")}</p>
          </div>
        </div>
        <ul className="max-h-48 divide-y divide-border-soft overflow-auto">
          {poolSummary.length === 0 ? (
            <li className="px-3 py-3 text-[10.5px] text-muted">{t("settings.capacity.poolsEmpty")}</li>
          ) : (
            poolSummary.map((row) => (
              <li key={row.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 px-3 py-2 text-[10.5px]">
                <span className="min-w-0">
                  <span className={cn("block truncate font-medium", row.ready ? "text-foreground" : "text-muted")}>
                    {row.name}
                  </span>
                  <span className="font-mono text-[9.5px] text-muted">{row.id}</span>
                </span>
                <span className="text-muted">
                  {row.poolOn
                    ? t("settings.capacity.poolAccounts", { count: row.members })
                    : t("settings.capacity.poolSingle")}
                </span>
                <span className="font-mono text-[9.5px] text-faint">
                  {row.poolOn ? row.strategy : "—"}
                </span>
              </li>
            ))
          )}
        </ul>
      </div>

      <ol className="list-decimal space-y-1 rounded-lg border border-border-soft bg-surface/30 px-3 py-2.5 pl-7 text-[10.5px] leading-4 text-muted">
        <li>{t("settings.capacity.howto.1")}</li>
        <li>{t("settings.capacity.howto.2")}</li>
        <li>{t("settings.capacity.howto.3")}</li>
      </ol>
    </section>
  );
}
