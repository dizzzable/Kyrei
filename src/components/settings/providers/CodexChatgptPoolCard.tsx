import {
  CheckCircle2,
  CircleAlert,
  KeyRound,
  LoaderCircle,
  LogOut,
  Plus,
  RefreshCw,
  Trash2,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge, Button, IconButton, Switch } from "@/components/ui";
import { useI18n, type TranslationKey } from "@/i18n";
import { desktopShell } from "@/lib/desktop";
import { GatewayRequestError, gateway } from "@/lib/gateway";
import type {
  AppConfig,
  CodexChatgptLoginSnapshot,
  CodexChatgptPoolSnapshot,
  ProviderAccountPoolStrategy,
} from "@/lib/types";
import { cn } from "@/lib/utils";

interface CodexChatgptPoolCardProps {
  onActivated: (config: AppConfig) => void;
}

type Busy = "load" | "create" | "save" | "activate" | "delete" | "logout" | "login" | null;

const STRATEGIES: ProviderAccountPoolStrategy[] = ["balanced", "round-robin", "fill-first", "least-used"];

function errorKey(reason: unknown): TranslationKey {
  if (reason instanceof GatewayRequestError) {
    if (reason.serverCode === "codex_chatgpt_pool_accounts_unavailable") return "settings.providers.codexPool.error.accountsUnavailable";
    if (reason.serverCode === "codex_app_server_not_installed") return "settings.providers.codex.error.notInstalled";
    if (reason.serverCode === "codex_app_server_login_active") return "settings.providers.codex.error.loginActive";
  }
  return "settings.providers.codexPool.error.operationFailed";
}

function slug(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function statusTone(status: string): "success" | "warning" | "neutral" | "danger" {
  if (status === "ready") return "success";
  if (status === "auth-required") return "warning";
  if (status === "disabled") return "neutral";
  return "danger";
}

export function CodexChatgptPoolCard({ onActivated }: CodexChatgptPoolCardProps) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<CodexChatgptPoolSnapshot | null>(null);
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [logins, setLogins] = useState<Record<string, CodexChatgptLoginSnapshot>>({});
  const [busy, setBusy] = useState<Busy>("load");
  const [error, setError] = useState<TranslationKey | null>(null);

  const load = useCallback(async (showBusy = true) => {
    if (showBusy) setBusy("load");
    try {
      setSnapshot(await gateway.getCodexChatgptPool());
      setError(null);
    } catch (reason) {
      setError(errorKey(reason));
    } finally {
      setBusy((current) => current === "load" ? null : current);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const running = Object.entries(logins).filter(([, login]) => login.status === "running");
    if (!running.length) return;
    const poll = async () => {
      for (const [id, login] of running) {
        try {
          const next = await gateway.getCodexChatgptPoolLogin(id, login.id);
          setLogins((current) => ({ ...current, [id]: next }));
          if (next.status === "succeeded") {
            const refreshed = await gateway.refreshCodexChatgptPoolAccount(id);
            setSnapshot(refreshed.pool);
          }
        } catch (reason) {
          setError(errorKey(reason));
        }
      }
    };
    const timer = setInterval(() => { void poll(); }, 1_000);
    return () => clearInterval(timer);
  }, [logins]);

  const ready = useMemo(() => snapshot?.accounts.filter((account) => account.enabled && account.status === "ready").length ?? 0, [snapshot]);

  const create = async () => {
    const id = accountId || slug(name);
    if (!name.trim() || !id) {
      setError("settings.providers.codexPool.error.accountRequired");
      return;
    }
    setBusy("create");
    try {
      setSnapshot(await gateway.createCodexChatgptPoolAccount({ id, name: name.trim() }));
      setName("");
      setAccountId("");
      setError(null);
    } catch (reason) {
      setError(errorKey(reason));
    } finally {
      setBusy(null);
    }
  };

  const savePool = async (next: Pick<CodexChatgptPoolSnapshot, "enabled" | "strategy" | "sessionAffinity">) => {
    setBusy("save");
    try {
      setSnapshot(await gateway.updateCodexChatgptPool(next));
      setError(null);
    } catch (reason) {
      setError(errorKey(reason));
    } finally {
      setBusy(null);
    }
  };

  const startLogin = async (id: string) => {
    setBusy("login");
    try {
      const login = await gateway.startCodexChatgptPoolLogin(id, "browser");
      setLogins((current) => ({ ...current, [id]: login }));
      if (login.authUrl) {
        if (desktopShell.available()) await desktopShell.openExternal(login.authUrl, { codexAuthUri: login.authUrl });
        else window.open(login.authUrl, "_blank", "noopener,noreferrer");
      }
      setError(null);
    } catch (reason) {
      setError(errorKey(reason));
    } finally {
      setBusy(null);
    }
  };

  const refreshAccount = async (id: string) => {
    setBusy("load");
    try {
      const next = await gateway.refreshCodexChatgptPoolAccount(id);
      setSnapshot(next.pool);
      setError(null);
    } catch (reason) {
      setError(errorKey(reason));
    } finally {
      setBusy(null);
    }
  };

  const logout = async (id: string) => {
    setBusy("logout");
    try {
      const next = await gateway.logoutCodexChatgptPoolAccount(id);
      setSnapshot(next.pool);
      setError(null);
    } catch (reason) {
      setError(errorKey(reason));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string, label: string) => {
    if (!window.confirm(t("settings.providers.codexPool.deleteConfirm", { name: label }))) return;
    setBusy("delete");
    try {
      setSnapshot(await gateway.deleteCodexChatgptPoolAccount(id));
      setLogins((current) => {
        const { [id]: _removed, ...rest } = current;
        return rest;
      });
      setError(null);
    } catch (reason) {
      setError(errorKey(reason));
    } finally {
      setBusy(null);
    }
  };

  const activate = async () => {
    setBusy("activate");
    try {
      onActivated(await gateway.activateCodexChatgptPool());
      setError(null);
    } catch (reason) {
      setError(errorKey(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="codex-chatgpt-pool-title" className="overflow-hidden rounded-lg border border-border-soft bg-surface/35">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-soft px-3 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-md border border-primary/25 bg-primary/8 text-primary">
            <UsersRound className="size-3.5" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id="codex-chatgpt-pool-title" className="text-[12px] font-semibold text-foreground">{t("settings.providers.codexPool.title")}</h3>
              {snapshot ? <Badge tone={snapshot.enabled ? "primary" : "neutral"}>{t(snapshot.enabled ? "settings.providers.codexPool.enabled" : "settings.providers.codexPool.disabled")}</Badge> : null}
            </div>
            <p className="mt-1 max-w-3xl text-[10.5px] leading-4 text-muted">{t("settings.providers.codexPool.description")}</p>
          </div>
        </div>
        <IconButton size="icon-sm" tip={t("settings.providers.codexPool.refresh")} disabled={busy !== null} onClick={() => void load(true)}>
          <RefreshCw className={cn("size-3.5", busy === "load" && "animate-spin")} aria-hidden />
        </IconButton>
      </div>

      <div className="space-y-3 px-3 py-3">
        {error ? <div className="flex items-start gap-2 rounded-md border border-danger/25 bg-danger/5 px-3 py-2 text-[10.5px] text-danger" role="alert"><CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /><span>{t(error)}</span></div> : null}

        {snapshot ? <>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
            <label>
              <span className="block text-[9px] uppercase tracking-[0.1em] text-muted">{t("settings.providers.codexPool.strategy")}</span>
              <select value={snapshot.strategy} disabled={busy !== null} onChange={(event) => void savePool({ ...snapshot, strategy: event.target.value as ProviderAccountPoolStrategy })} className="mt-1 h-8 w-full rounded-md border border-border bg-surface px-2 text-[11px] text-foreground">
                {STRATEGIES.map((strategy) => <option key={strategy} value={strategy}>{t(`settings.providers.codexPool.strategy.${strategy}` as TranslationKey)}</option>)}
              </select>
            </label>
            <div className="flex items-center justify-between gap-3 rounded-md border border-border-soft px-2.5 py-1.5">
              <div><span className="block text-[10px] font-medium text-secondary">{t("settings.providers.codexPool.enabled")}</span><span className="block text-[9px] text-muted">{t("settings.providers.codexPool.enabledHint")}</span></div>
              <Switch checked={snapshot.enabled} disabled={busy !== null} onCheckedChange={(enabled) => void savePool({ ...snapshot, enabled })} aria-label={t("settings.providers.codexPool.enabled")} />
            </div>
            <Button size="sm" disabled={busy !== null || ready === 0} onClick={() => void activate()}>
              {busy === "activate" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <CheckCircle2 className="size-3.5" aria-hidden />}
              {t("settings.providers.codexPool.activate")}
            </Button>
          </div>

          <div className="grid gap-2 rounded-md border border-border-soft bg-bg/25 p-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <label><span className="block text-[9px] text-muted">{t("settings.providers.codexPool.accountName")}</span><input value={name} disabled={busy !== null} onChange={(event) => { setName(event.target.value); if (!accountId) setAccountId(slug(event.target.value)); }} className="mt-1 h-8 w-full rounded-md border border-border bg-surface px-2 text-[11px] text-foreground" /></label>
            <label><span className="block text-[9px] text-muted">{t("settings.providers.codexPool.accountId")}</span><input value={accountId} disabled={busy !== null} onChange={(event) => setAccountId(slug(event.target.value))} className="mt-1 h-8 w-full rounded-md border border-border bg-surface px-2 font-mono text-[11px] text-foreground" /></label>
            <Button size="sm" disabled={busy !== null || !name.trim() || !accountId} onClick={() => void create()}><Plus className="size-3.5" aria-hidden />{t("settings.providers.codexPool.add")}</Button>
          </div>

          <div className="space-y-2">
            {snapshot.accounts.length === 0 ? <p className="rounded-md border border-dashed border-border px-3 py-3 text-[10.5px] text-muted">{t("settings.providers.codexPool.empty")}</p> : null}
            {snapshot.accounts.map((account) => {
              const login = logins[account.id];
              const loginRunning = login?.status === "running";
              const accountSubtitle = account.planType
                ? t("settings.providers.codex.plan", { plan: account.planType })
                : t("settings.providers.codexPool.profileHint");
              const loginState = loginRunning ? (
                <p className="mt-1 flex items-center gap-1 text-[9.5px] text-primary"><LoaderCircle className="size-3 animate-spin" aria-hidden />{t("settings.providers.codex.login.running")}</p>
              ) : null;
              return <div key={account.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-soft bg-bg/20 px-3 py-2.5">
                <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-[11px] font-medium text-foreground">{account.name}</span><code className="font-mono text-[9px] text-muted">{account.id}</code><Badge tone={statusTone(account.status)}>{t(`settings.providers.codexPool.status.${account.status}` as TranslationKey)}</Badge></div><p className="mt-1 text-[9.5px] text-muted">{accountSubtitle}</p>{loginState}</div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button variant="ghost" size="sm" disabled={busy !== null || loginRunning} onClick={() => void startLogin(account.id)}><KeyRound className="size-3.5" aria-hidden />{t("settings.providers.codexPool.login")}</Button>
                  <IconButton size="icon-sm" tip={t("settings.providers.codexPool.refreshAccount")} disabled={busy !== null} onClick={() => void refreshAccount(account.id)}><RefreshCw className="size-3.5" aria-hidden /></IconButton>
                  {account.status === "ready" && (
                    <IconButton size="icon-sm" tip={t("settings.providers.codex.logout")} disabled={busy !== null} onClick={() => void logout(account.id)}>
                      <LogOut className="size-3.5" aria-hidden />
                    </IconButton>
                  )}
                  <IconButton size="icon-sm" tip={t("settings.providers.codexPool.delete")} disabled={busy !== null || loginRunning} onClick={() => void remove(account.id, account.name)}><Trash2 className="size-3.5" aria-hidden /></IconButton>
                </div>
              </div>;
            })}
          </div>

          <p className="flex items-start gap-2 rounded-md border border-primary/15 bg-primary/5 px-3 py-2 text-[9.5px] leading-4 text-secondary"><KeyRound className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />{t("settings.providers.codexPool.security")}</p>
        </> : <div className="flex min-h-16 items-center justify-center gap-2 text-[10.5px] text-muted"><LoaderCircle className="size-3.5 animate-spin" aria-hidden />{t("settings.providers.codexPool.loading")}</div>}
      </div>
    </section>
  );
}
