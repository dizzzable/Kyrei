import { CheckCircle2, CircleAlert, KeyRound, LaptopMinimal, LoaderCircle, LogOut, RefreshCw, Smartphone, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Badge, Button, IconButton, SegmentedControl } from "@/components/ui";
import { useI18n, type TranslationKey } from "@/i18n";
import { desktopShell } from "@/lib/desktop";
import { GatewayRequestError, gateway } from "@/lib/gateway";
import type { AppConfig, CodexChatgptConnectorStatus, CodexChatgptLoginMode, CodexChatgptLoginSnapshot } from "@/lib/types";
import { cn } from "@/lib/utils";

interface CodexChatgptConnectorCardProps {
  onActivated: (config: AppConfig) => void;
}

type BusyOperation = "refresh" | "browser" | "device" | "cancel" | "logout" | "activate" | null;

const LOGIN_STATUS_LABELS: Record<CodexChatgptLoginSnapshot["status"], TranslationKey> = {
  running: "settings.providers.codex.login.running",
  succeeded: "settings.providers.codex.login.succeeded",
  failed: "settings.providers.codex.login.failed",
  cancelled: "settings.providers.codex.login.cancelled",
  "timed-out": "settings.providers.codex.login.timedOut",
};

function errorKey(reason: unknown): TranslationKey {
  if (!(reason instanceof GatewayRequestError)) return "settings.providers.codex.error.operationFailed";
  switch (reason.serverCode) {
    case "codex_app_server_not_installed": return "settings.providers.codex.error.notInstalled";
    case "codex_app_server_not_authenticated": return "settings.providers.codex.error.notAuthenticated";
    case "codex_app_server_login_active": return "settings.providers.codex.error.loginActive";
    case "codex_app_server_login_timed_out": return "settings.providers.codex.error.loginTimedOut";
    case "codex_app_server_login_failed": return "settings.providers.codex.error.loginFailed";
    default: return "settings.providers.codex.error.operationFailed";
  }
}

function running(login: CodexChatgptLoginSnapshot | null): boolean {
  return login?.status === "running";
}

export function CodexChatgptConnectorCard({ onActivated }: CodexChatgptConnectorCardProps) {
  const { t } = useI18n();
  const [connector, setConnector] = useState<CodexChatgptConnectorStatus | null>(null);
  const [login, setLogin] = useState<CodexChatgptLoginSnapshot | null>(null);
  const [busy, setBusy] = useState<BusyOperation>("refresh");
  const [error, setError] = useState<TranslationKey | null>(null);

  const refresh = useCallback(async (showBusy = false) => {
    if (showBusy) setBusy("refresh");
    try {
      const next = await gateway.getCodexChatgptConnector();
      setConnector(next);
      if (next.activeLogin) setLogin(next.activeLogin);
    } catch (reason) {
      setError(errorKey(reason));
    } finally {
      setBusy((current) => current === "refresh" ? null : current);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!login || login.status !== "running") return;
    const loginId = login.id;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await gateway.getCodexChatgptLogin(loginId);
        if (disposed) return;
        setLogin(next);
        if (next.status === "running") {
          timer = setTimeout(() => void poll(), 1_000);
          return;
        }
        await refresh();
      } catch (reason) {
        if (!disposed) setError(errorKey(reason));
      }
    };
    timer = setTimeout(() => void poll(), 750);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [login?.id, login?.status, refresh]);

  const startLogin = async (mode: CodexChatgptLoginMode) => {
    if (!connector?.installed || running(login)) return;
    setBusy(mode);
    setError(null);
    try {
      const next = await gateway.startCodexChatgptLogin(mode);
      setLogin(next);
      if (mode === "browser" && next.authUrl) {
        try {
          if (desktopShell.available()) {
            await desktopShell.openExternal(next.authUrl, { codexAuthUri: next.authUrl });
          } else {
            window.open(next.authUrl, "_blank", "noopener,noreferrer");
          }
        } catch {
          setError("settings.providers.codex.error.browserOpenFailed");
        }
      }
    } catch (reason) {
      setError(errorKey(reason));
    } finally {
      setBusy(null);
    }
  };

  const cancelLogin = async () => {
    if (!login || !running(login)) return;
    setBusy("cancel");
    try {
      setLogin(await gateway.cancelCodexChatgptLogin(login.id));
      await refresh();
    } catch (reason) {
      setError(errorKey(reason));
    } finally {
      setBusy(null);
    }
  };

  const activate = async () => {
    setBusy("activate");
    setError(null);
    try {
      onActivated(await gateway.activateCodexChatgpt());
    } catch (reason) {
      setError(errorKey(reason));
    } finally {
      setBusy(null);
    }
  };

  const logout = async () => {
    if (!window.confirm(t("settings.providers.codex.logoutConfirm"))) return;
    setBusy("logout");
    setError(null);
    try {
      await gateway.logoutCodexChatgpt();
      setLogin(null);
      await refresh();
    } catch (reason) {
      setError(errorKey(reason));
    } finally {
      setBusy(null);
    }
  };

  const [mode, setMode] = useState<CodexChatgptLoginMode>("browser");
  const connected = connector?.authenticated === true;
  const actionBusy = busy !== null;
  const modeOptions: Array<{ value: CodexChatgptLoginMode; label: string }> = [
    { value: "browser", label: t("settings.providers.codex.mode.browser") },
    { value: "device", label: t("settings.providers.codex.mode.device") },
  ];
  const LoginIcon = mode === "device" ? Smartphone : KeyRound;
  const loginActionLabel = mode === "browser"
    ? "settings.providers.codex.login.openBrowser"
    : "settings.providers.codex.login.startDevice";
  return (
    <section aria-labelledby="codex-chatgpt-connector-title" className="overflow-hidden rounded-lg border border-border-soft bg-surface/35">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-soft px-3 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border-soft bg-surface text-muted">
            <LaptopMinimal className="size-3.5" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id="codex-chatgpt-connector-title" className="text-[12px] font-semibold text-foreground">
                {t("settings.providers.codex.title")}
              </h3>
              {connector?.installed ? (
                <Badge tone={connected ? "success" : "neutral"}>
                  {connected ? t("settings.providers.codex.connected") : t("settings.providers.codex.installed")}
                </Badge>
              ) : connector ? <Badge tone="warning">{t("settings.providers.codex.notInstalled")}</Badge> : null}
              {connector?.version ? <span className="font-mono text-[9px] text-faint">v{connector.version}</span> : null}
            </div>
            <p className="mt-1 max-w-3xl text-[10.5px] leading-4 text-muted">{t("settings.providers.codex.description")}</p>
          </div>
        </div>
        <IconButton size="icon-sm" tip={t("settings.providers.codex.refresh")} disabled={actionBusy} onClick={() => void refresh(true)}>
          <RefreshCw className={cn("size-3.5", busy === "refresh" && "animate-spin")} aria-hidden />
        </IconButton>
      </div>

      <div className="space-y-3 px-3 py-3">
        {error ? (
          <div className="flex items-start gap-2 rounded-md border border-danger/25 bg-danger/5 px-3 py-2 text-[10.5px] text-danger" role="alert">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{t(error)}</span>
          </div>
        ) : null}

        {connector && !connector.installed ? (
          <div className="flex items-start gap-3 rounded-md border border-dashed border-border px-3 py-3">
            <KeyRound className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <div>
              <p className="text-[11px] font-medium text-foreground">{t("settings.providers.codex.installTitle")}</p>
              <p className="mt-1 text-[10px] leading-4 text-muted">{t("settings.providers.codex.installHint")}</p>
            </div>
          </div>
        ) : null}

        {connector?.installed && connected ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-success/20 bg-success/5 px-3 py-2.5">
            <div className="flex min-w-0 items-start gap-2">
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
              <div>
                <p className="text-[11px] font-medium text-foreground">{t("settings.providers.codex.authenticated")}</p>
                <p className="mt-0.5 text-[9.5px] text-muted">
                  {connector.planType ? t("settings.providers.codex.plan", { plan: connector.planType }) : t("settings.providers.codex.planUnknown")}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={actionBusy} onClick={() => void activate()}>
                {busy === "activate" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <CheckCircle2 className="size-3.5" aria-hidden />}
                {t("settings.providers.codex.activate")}
              </Button>
              <Button variant="ghost" size="sm" disabled={actionBusy} onClick={() => void logout()}>
                {busy === "logout" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <LogOut className="size-3.5" aria-hidden />}
                {t("settings.providers.codex.logout")}
              </Button>
            </div>
          </div>
        ) : null}

        {connector?.installed && !connected && !running(login) ? (
          <div className="rounded-md border border-border-soft bg-bg/25 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="max-w-xl">
                <p className="text-[11px] font-medium text-foreground">{t("settings.providers.codex.login.title")}</p>
                <p className="mt-1 text-[9.5px] leading-4 text-muted">
                  {mode === "browser" ? t("settings.providers.codex.login.browserHint") : t("settings.providers.codex.login.deviceHint")}
                </p>
              </div>
              <SegmentedControl value={mode} options={modeOptions} onChange={setMode} size="sm" />
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-2xl text-[9.5px] leading-4 text-muted">{t("settings.providers.codex.privacy")}</p>
              <Button size="sm" disabled={actionBusy} onClick={() => void startLogin(mode)}>
                {busy === mode ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <LoginIcon className="size-3.5" aria-hidden />}
                {t(loginActionLabel)}
              </Button>
            </div>
          </div>
        ) : null}

        {login ? (
          <div className="rounded-md border border-border-soft bg-bg/45 px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-[10.5px] font-medium text-secondary">
                {login.status === "running" ? <LoaderCircle className="size-3.5 animate-spin text-primary" aria-hidden /> : null}
                {t(LOGIN_STATUS_LABELS[login.status])}
              </span>
              {login.status === "running" ? (
                <Button variant="ghost" size="sm" disabled={busy === "cancel"} onClick={() => void cancelLogin()}>
                  {busy === "cancel" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <X className="size-3.5" aria-hidden />}
                  {t("settings.providers.codex.login.cancel")}
                </Button>
              ) : null}
            </div>
            {login.mode === "device" && login.userCode ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted">
                <span>{t("settings.providers.codex.login.deviceCode")}</span>
                <code className="rounded border border-border bg-surface px-2 py-1 font-mono text-foreground">{login.userCode}</code>
                {login.verificationUrl ? (
                  <Button variant="outline" size="sm" onClick={() => {
                    if (desktopShell.available()) void desktopShell.openExternal(login.verificationUrl!, { codexAuthUri: login.verificationUrl });
                    else window.open(login.verificationUrl, "_blank", "noopener,noreferrer");
                  }}>
                    {t("settings.providers.codex.login.openDevicePage")}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
