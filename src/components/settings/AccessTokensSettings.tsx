import { Copy, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button, Input, Switch } from "@/components/ui";
import { useI18n } from "@/i18n";
import {
  gateway,
  type AccessControlPublic,
  type AccessPrincipal,
  type AccessTokenUsage,
  type CompanyGatewayInfo,
} from "@/lib/gateway";
import type { AppConfig } from "@/lib/types";
import { cn } from "@/lib/utils";

interface AccessTokensSettingsProps {
  config?: AppConfig | null;
  onSaved?: (config: AppConfig) => void;
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function AccessTokensSettings({ config, onSaved }: AccessTokensSettingsProps) {
  const { t } = useI18n();
  const [control, setControl] = useState<AccessControlPublic | null>(null);
  const [company, setCompany] = useState<CompanyGatewayInfo | null>(null);
  const [usage, setUsage] = useState<AccessTokenUsage[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [scopeAllModels, setScopeAllModels] = useState(false);
  const [allowedModels, setAllowedModels] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState("");
  const [revealed, setRevealed] = useState<{ id: string; token: string } | null>(null);
  const [editingScopeId, setEditingScopeId] = useState<string | null>(null);
  const [editingScopeAll, setEditingScopeAll] = useState(false);
  const [editingAllowedModels, setEditingAllowedModels] = useState<string[]>([]);
  const [editingExpiresAt, setEditingExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [proxyDraft, setProxyDraft] = useState(() => ({
    enabled: config?.proxy?.enabled !== false,
    listenLan: config?.proxy?.listenLan === true,
    requireAccessToken: config?.proxy?.requireAccessToken === true || config?.proxy?.listenLan === true,
  }));

  useEffect(() => {
    setProxyDraft({
      enabled: config?.proxy?.enabled !== false,
      listenLan: config?.proxy?.listenLan === true,
      requireAccessToken: config?.proxy?.requireAccessToken === true || config?.proxy?.listenLan === true,
    });
  }, [config?.proxy]);

  const modelRoutes = useMemo(() => (config?.providers ?? []).flatMap((provider) => (
    provider.enabled === false
      ? []
      : (provider.models ?? []).map((model) => ({
        ref: `${provider.id}/${model.id}`,
        label: `${provider.name} · ${model.name || model.id}`,
      }))
  )), [config?.providers]);

  useEffect(() => {
    if (allowedModels.length || !config?.activeProviderId || !config.activeModelId) return;
    const activeRef = `${config.activeProviderId}/${config.activeModelId}`;
    if (modelRoutes.some((route) => route.ref === activeRef)) setAllowedModels([activeRef]);
  }, [allowedModels.length, config?.activeModelId, config?.activeProviderId, modelRoutes]);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const [next, companyInfo, usageInfo] = await Promise.all([
        gateway.getAccessControl(),
        gateway.getCompanyGateway(),
        gateway.getAccessTokenUsage(),
      ]);
      setControl(next);
      setCompany(companyInfo);
      setUsage(usageInfo.principals);
      setStatus("ready");
    } catch {
      setControl(null);
      setCompany(null);
      setUsage([]);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await gateway.createAccessToken({
        label: label.trim() || t("settings.accessTokens.defaultLabel"),
        ...(scopeAllModels ? {} : { allowedModels }),
        ...(expiresAt ? { expiresAt: new Date(`${expiresAt}T00:00:00`).toISOString() } : {}),
      });
      setControl(result.accessControl);
      setRevealed({ id: result.principal.id, token: result.token });
      setLabel("");
      void load();
    } catch {
      setError(t("settings.accessTokens.failed"));
    } finally {
      setBusy(false);
    }
  };

  const toggleRequire = async (requireToken: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = await gateway.setAccessControlRequireToken(requireToken);
      setControl(next);
    } catch {
      setError(t("settings.accessTokens.failed"));
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (principal: AccessPrincipal, enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await gateway.patchAccessToken(principal.id, { enabled });
      setControl(result.accessControl);
    } catch {
      setError(t("settings.accessTokens.failed"));
    } finally {
      setBusy(false);
    }
  };

  const startScopeEdit = (principal: AccessPrincipal) => {
    setEditingScopeId(principal.id);
    setEditingScopeAll(principal.allowedModels.length === 0);
    setEditingAllowedModels(principal.allowedModels.filter((ref) => modelRoutes.some((route) => route.ref === ref)));
    setEditingExpiresAt(principal.expiresAt?.slice(0, 10) ?? "");
  };

  const saveScope = async (principal: AccessPrincipal) => {
    if (!editingScopeAll && editingAllowedModels.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await gateway.patchAccessToken(principal.id, {
        allowedModels: editingScopeAll ? [] : editingAllowedModels,
        expiresAt: editingExpiresAt ? new Date(`${editingExpiresAt}T00:00:00`).toISOString() : null,
      });
      setControl(result.accessControl);
      setEditingScopeId(null);
      void load();
    } catch {
      setError(t("settings.accessTokens.failed"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (principal: AccessPrincipal) => {
    setBusy(true);
    setError(null);
    try {
      const result = await gateway.deleteAccessToken(principal.id);
      setControl(result.accessControl);
      if (revealed?.id === principal.id) setRevealed(null);
    } catch {
      setError(t("settings.accessTokens.failed"));
    } finally {
      setBusy(false);
    }
  };

  const regen = async (principal: AccessPrincipal) => {
    setBusy(true);
    setError(null);
    try {
      const result = await gateway.regenerateAccessToken(principal.id);
      setControl(result.accessControl);
      setRevealed({ id: result.principal.id, token: result.token });
    } catch {
      setError(t("settings.accessTokens.failed"));
    } finally {
      setBusy(false);
    }
  };

  const copyToken = async () => {
    if (!revealed?.token) return;
    await copyValue(revealed.token);
  };

  const copyValue = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      /* ignore */
    }
  };

  const saveProxy = async () => {
    if (!config) return;
    setBusy(true);
    setError(null);
    try {
      const next = await gateway.setConfig({
        proxy: {
          enabled: proxyDraft.enabled,
          listenLan: proxyDraft.listenLan,
          requireAccessToken: proxyDraft.listenLan ? true : proxyDraft.requireAccessToken,
        },
      } as Parameters<typeof gateway.setConfig>[0]);
      onSaved?.(next);
      void load();
    } catch {
      setError(t("settings.accessTokens.failed"));
    } finally {
      setBusy(false);
    }
  };

  const usageByPrincipal = new Map(usage.map((summary) => [summary.id, summary]));
  const toggleAllowedModel = (ref: string, checked: boolean) => {
    setAllowedModels((current) => (
      checked
        ? [...new Set([...current, ref])]
        : current.filter((value) => value !== ref)
    ));
  };
  const toggleEditingAllowedModel = (ref: string, checked: boolean) => {
    setEditingAllowedModels((current) => (
      checked
        ? [...new Set([...current, ref])]
        : current.filter((value) => value !== ref)
    ));
  };

  return (
    <section className="max-w-4xl space-y-4" aria-labelledby="access-tokens-title">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-border-soft bg-surface text-muted">
          <KeyRound className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="access-tokens-title" className="text-[14px] font-semibold text-foreground">
            {t("settings.accessTokens.title")}
          </h2>
          <p className="mt-1 max-w-2xl text-[10.5px] leading-4 text-muted">{t("settings.accessTokens.hint")}</p>
        </div>
        <Button variant="outline" size="icon-sm" disabled={status === "loading"} onClick={() => void load()} aria-label={t("settings.accessTokens.refresh")}>
          {status === "loading" ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        </Button>
      </div>

      {control ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border-soft bg-surface/45 px-3 py-2.5">
          <div>
            <span className="block text-[11px] font-medium text-foreground">{t("settings.accessTokens.requireTitle")}</span>
            <span className="mt-0.5 block text-[10px] leading-4 text-muted">{t("settings.accessTokens.requireHint")}</span>
          </div>
          <div className="inline-flex items-center gap-2 text-[10.5px] text-secondary">
            <span>{control.requireToken ? t("settings.accessTokens.on") : t("settings.accessTokens.off")}</span>
            <Switch
              checked={control.requireToken}
              disabled={busy}
              onCheckedChange={(value) => void toggleRequire(value)}
              aria-label={t("settings.accessTokens.requireTitle")}
            />
          </div>
        </div>
      ) : null}

      {config ? (
        <div className="space-y-2 rounded-lg border border-border-soft bg-surface/45 p-3">
          <h4 className="text-[11px] font-semibold text-foreground">{t("settings.proxy.title")}</h4>
          <p className="text-[10px] leading-4 text-muted">{t("settings.proxy.hint")}</p>
          <div className="space-y-1.5">
            {(company?.endpoints ?? []).map((endpoint) => (
              <div key={endpoint.baseUrl} className="flex items-center gap-2 rounded-md border border-border-soft bg-bg/40 px-2 py-1.5">
                <code className="min-w-0 flex-1 truncate font-mono text-[10px] text-secondary">{endpoint.baseUrl}</code>
                <Button size="sm" variant="ghost" onClick={() => void copyValue(endpoint.baseUrl)}>{t("settings.accessTokens.copy")}</Button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <label className="inline-flex items-center gap-2 text-[10.5px] text-secondary">
              <Switch
                checked={proxyDraft.enabled}
                disabled={busy}
                onCheckedChange={(enabled) => setProxyDraft((c) => ({ ...c, enabled }))}
              />
              {t("settings.proxy.enabled")}
            </label>
            <label className="inline-flex items-center gap-2 text-[10.5px] text-secondary">
              <Switch
                checked={proxyDraft.listenLan}
                disabled={busy}
                onCheckedChange={(listenLan) => setProxyDraft((c) => ({
                  ...c,
                  listenLan,
                  requireAccessToken: listenLan ? true : c.requireAccessToken,
                }))}
              />
              {t("settings.proxy.listenLan")}
            </label>
            <label className="inline-flex items-center gap-2 text-[10.5px] text-secondary">
              <Switch
                checked={proxyDraft.requireAccessToken || proxyDraft.listenLan}
                disabled={busy || proxyDraft.listenLan}
                onCheckedChange={(requireAccessToken) => setProxyDraft((c) => ({ ...c, requireAccessToken }))}
              />
              {t("settings.proxy.requireAccessToken")}
            </label>
            <Button size="sm" disabled={busy} onClick={() => void saveProxy()}>
              {t("settings.proxy.save")}
            </Button>
          </div>
          <p className="text-[10px] leading-4 text-faint">{t("settings.proxy.restartHint")}</p>
          {company?.proxy.restartRequired ? <p className="text-[10.5px] text-warning">{t("settings.proxy.restartRequired")}</p> : null}
        </div>
      ) : null}

      <div className="space-y-3 rounded-lg border border-border-soft bg-surface/35 p-3">
        <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[12rem] flex-1 space-y-1">
          <span className="text-[10px] text-muted">{t("settings.accessTokens.label")}</span>
          <Input
            value={label}
            disabled={busy}
            placeholder={t("settings.accessTokens.labelPlaceholder")}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <label className="min-w-[10rem] space-y-1">
          <span className="text-[10px] text-muted">{t("settings.accessTokens.expiresAt")}</span>
          <Input type="date" value={expiresAt} disabled={busy} onChange={(event) => setExpiresAt(event.target.value)} />
        </label>
        <Button size="sm" disabled={busy || (!scopeAllModels && allowedModels.length === 0)} onClick={() => void create()}>
          <Plus className="size-3.5" aria-hidden />
          {t("settings.accessTokens.create")}
        </Button>
        </div>
        <div className="rounded-md border border-border-soft bg-bg/25 p-2.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <span className="block text-[10.5px] font-medium text-foreground">{t("settings.accessTokens.scopeTitle")}</span>
              <span className="mt-0.5 block text-[10px] leading-4 text-muted">{t("settings.accessTokens.scopeHint")}</span>
            </div>
            <label className="inline-flex shrink-0 items-center gap-2 text-[10px] text-secondary">
              {t("settings.accessTokens.scopeAll")}
              <Switch checked={scopeAllModels} disabled={busy} onCheckedChange={setScopeAllModels} />
            </label>
          </div>
          {!scopeAllModels ? (
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              {modelRoutes.map((route) => (
                <label key={route.ref} className="flex min-w-0 items-center gap-2 rounded px-1.5 py-1 text-[10px] text-secondary hover:bg-elevated">
                  <input
                    type="checkbox"
                    checked={allowedModels.includes(route.ref)}
                    disabled={busy}
                    onChange={(event) => toggleAllowedModel(route.ref, event.target.checked)}
                  />
                  <span className="truncate" title={route.ref}>{route.label}</span>
                </label>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {revealed ? (
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5" role="status">
          <p className="text-[11px] font-medium text-foreground">{t("settings.accessTokens.revealTitle")}</p>
          <p className="mt-0.5 text-[10px] text-muted">{t("settings.accessTokens.revealHint")}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="max-w-full truncate rounded-md border border-border-soft bg-bg px-2 py-1 text-[11px] text-foreground">
              {revealed.token}
            </code>
            <Button size="sm" variant="outline" onClick={() => void copyToken()}>
              <Copy className="size-3.5" aria-hidden />
              {t("settings.accessTokens.copy")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRevealed(null)}>
              {t("settings.accessTokens.dismiss")}
            </Button>
          </div>
        </div>
      ) : null}

      {error ? <p className="text-[11px] text-danger">{error}</p> : null}
      {status === "error" ? <p className="text-[11px] text-muted">{t("settings.accessTokens.loadFailed")}</p> : null}

      <ul className="divide-y divide-border-soft rounded-lg border border-border-soft">
        {(control?.principals ?? []).length === 0 ? (
          <li className="px-3 py-3 text-[10.5px] text-muted">{t("settings.accessTokens.empty")}</li>
        ) : (
          control?.principals.map((principal) => (
            <li key={principal.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <span className={cn("block text-[12px] font-medium", principal.enabled ? "text-foreground" : "text-muted line-through")}>
                  {principal.label}
                </span>
                <span className="mt-0.5 block text-[10px] text-muted">
                  {principal.prefix} · {principal.id}
                  {principal.lastUsedAt ? ` · ${t("settings.accessTokens.lastUsed")}: ${principal.lastUsedAt.slice(0, 10)}` : ""}
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-muted" title={principal.allowedModels.join(", ")}>
                  {principal.allowedModels.length
                    ? principal.allowedModels.join(" · ")
                    : t("settings.accessTokens.scopeAll")}
                  {principal.expiresAt ? ` · ${t("settings.accessTokens.expiresAt")}: ${principal.expiresAt.slice(0, 10)}` : ""}
                </span>
                <span className="mt-0.5 block text-[10px] text-faint">
                  {(() => {
                    const summary = usageByPrincipal.get(principal.id);
                    return t("settings.accessTokens.usage", {
                      requests: summary?.requestCount ?? 0,
                      tokens: formatTokens(summary?.totalTokens ?? 0),
                    });
                  })()}
                </span>
              </div>
              <Switch
                checked={principal.enabled}
                disabled={busy}
                onCheckedChange={(enabled) => void setEnabled(principal, enabled)}
                aria-label={t("settings.accessTokens.enable", { name: principal.label })}
              />
              <Button size="icon-sm" variant="ghost" disabled={busy} onClick={() => void regen(principal)} aria-label={t("settings.accessTokens.regenerate")}>
                <RefreshCw className="size-3.5" />
              </Button>
              <Button size="icon-sm" variant="ghost" disabled={busy} onClick={() => startScopeEdit(principal)} aria-label={t("settings.accessTokens.manageScope")}>
                <Pencil className="size-3.5" />
              </Button>
              <Button size="icon-sm" variant="ghost" disabled={busy} onClick={() => void remove(principal)} aria-label={t("settings.accessTokens.delete")}>
                <Trash2 className="size-3.5" />
              </Button>
              {editingScopeId === principal.id ? (
                <div className="w-full space-y-2 rounded-md border border-border-soft bg-bg/35 p-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[10.5px] font-medium text-foreground">{t("settings.accessTokens.scopeTitle")}</span>
                    <label className="inline-flex items-center gap-2 text-[10px] text-secondary">
                      {t("settings.accessTokens.scopeAll")}
                      <Switch checked={editingScopeAll} disabled={busy} onCheckedChange={setEditingScopeAll} />
                    </label>
                  </div>
                  {!editingScopeAll ? (
                    <div className="grid gap-1 sm:grid-cols-2">
                      {modelRoutes.map((route) => (
                        <label key={route.ref} className="flex min-w-0 items-center gap-2 rounded px-1.5 py-1 text-[10px] text-secondary hover:bg-elevated">
                          <input
                            type="checkbox"
                            checked={editingAllowedModels.includes(route.ref)}
                            disabled={busy}
                            onChange={(event) => toggleEditingAllowedModel(route.ref, event.target.checked)}
                          />
                          <span className="truncate" title={route.ref}>{route.label}</span>
                        </label>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="space-y-1">
                      <span className="text-[10px] text-muted">{t("settings.accessTokens.expiresAt")}</span>
                      <Input type="date" value={editingExpiresAt} disabled={busy} onChange={(event) => setEditingExpiresAt(event.target.value)} />
                    </label>
                    <Button size="sm" disabled={busy || (!editingScopeAll && editingAllowedModels.length === 0)} onClick={() => void saveScope(principal)}>
                      {t("settings.save")}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditingScopeId(null)}>
                      {t("common.cancel")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
