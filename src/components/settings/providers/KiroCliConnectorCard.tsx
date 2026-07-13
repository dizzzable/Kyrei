import {
  CheckCircle2,
  CircleAlert,
  KeyRound,
  LoaderCircle,
  LogOut,
  RefreshCw,
  TerminalSquare,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { Badge, Button, IconButton, Input, SegmentedControl } from "@/components/ui";
import { useI18n, type TranslationKey } from "@/i18n";
import { GatewayRequestError, gateway } from "@/lib/gateway";
import type {
  KiroCliAccountType,
  KiroCliAuthenticationMethod,
  KiroCliConnectorStatus,
  KiroCliLoginInput,
  KiroCliLoginMethod,
  KiroCliLoginMode,
  KiroCliLoginSnapshot,
  KiroCliModel,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const LOGIN_METHODS: ReadonlyArray<{ value: KiroCliLoginMethod; label: TranslationKey }> = [
  { value: "unified", label: "settings.providers.kiro.method.unified" },
  { value: "free", label: "settings.providers.kiro.method.free" },
  { value: "github", label: "settings.providers.kiro.method.github" },
  { value: "google", label: "settings.providers.kiro.method.google" },
  { value: "identity-center", label: "settings.providers.kiro.method.identityCenter" },
];

const AUTH_METHOD_LABELS: Record<KiroCliAuthenticationMethod, TranslationKey> = {
  none: "settings.providers.kiro.auth.none",
  github: "settings.providers.kiro.auth.github",
  google: "settings.providers.kiro.auth.google",
  "builder-id": "settings.providers.kiro.auth.builderId",
  "identity-center": "settings.providers.kiro.auth.identityCenter",
  "api-key": "settings.providers.kiro.auth.apiKey",
};

const ACCOUNT_TYPE_LABELS: Record<KiroCliAccountType, TranslationKey> = {
  none: "settings.providers.kiro.account.none",
  free: "settings.providers.kiro.account.free",
  enterprise: "settings.providers.kiro.account.enterprise",
  "api-key": "settings.providers.kiro.account.apiKey",
};

const LOGIN_STATUS_LABELS: Record<KiroCliLoginSnapshot["status"], TranslationKey> = {
  running: "settings.providers.kiro.login.running",
  succeeded: "settings.providers.kiro.login.succeeded",
  failed: "settings.providers.kiro.login.failed",
  cancelled: "settings.providers.kiro.login.cancelled",
  "timed-out": "settings.providers.kiro.login.timedOut",
};

const KIRO_ERROR_KEYS: Readonly<Record<string, TranslationKey>> = {
  kiro_cli_not_found: "settings.providers.kiro.error.notInstalled",
  kiro_cli_auth_busy: "settings.providers.kiro.error.loginActive",
  kiro_cli_login_active: "settings.providers.kiro.error.loginActive",
  kiro_cli_identity_provider_invalid: "settings.providers.kiro.error.identityProviderInvalid",
  kiro_cli_region_invalid: "settings.providers.kiro.error.regionInvalid",
  kiro_cli_login_timeout: "settings.providers.kiro.error.loginTimedOut",
  kiro_cli_login_failed: "settings.providers.kiro.error.loginFailed",
  kiro_cli_models_malformed: "settings.providers.kiro.error.modelsFailed",
  kiro_cli_models_limit: "settings.providers.kiro.error.modelsFailed",
  kiro_cli_model_id_invalid: "settings.providers.kiro.error.modelsFailed",
  kiro_cli_model_id_missing: "settings.providers.kiro.error.modelsFailed",
};

type BusyOperation = "refresh" | "login" | "cancel" | "models" | "logout" | null;

function connectorErrorKey(reason: unknown): TranslationKey {
  if (reason instanceof GatewayRequestError) {
    if (reason.code === "capability_unavailable") return "settings.providers.kiro.error.gatewayUnavailable";
    if (reason.serverCode && KIRO_ERROR_KEYS[reason.serverCode]) return KIRO_ERROR_KEYS[reason.serverCode];
  }
  return "settings.providers.kiro.error.operationFailed";
}

function isRunning(login: KiroCliLoginSnapshot | null): boolean {
  return login?.status === "running";
}

export function KiroCliConnectorCard() {
  const { t } = useI18n();
  const [connector, setConnector] = useState<KiroCliConnectorStatus | null>(null);
  const [login, setLogin] = useState<KiroCliLoginSnapshot | null>(null);
  const [models, setModels] = useState<KiroCliModel[]>([]);
  const [mode, setMode] = useState<KiroCliLoginMode>("browser");
  const [method, setMethod] = useState<KiroCliLoginMethod>("unified");
  const [identityProvider, setIdentityProvider] = useState("");
  const [region, setRegion] = useState("");
  const [busy, setBusy] = useState<BusyOperation>("refresh");
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  const refreshStatus = useCallback(async (showBusy = false) => {
    if (showBusy) setBusy("refresh");
    setErrorKey(null);
    try {
      const next = await gateway.getKiroCliConnector();
      setConnector(next);
      if (next.activeLogin) setLogin(next.activeLogin);
    } catch (reason) {
      setErrorKey(connectorErrorKey(reason));
    } finally {
      setBusy((current) => current === "refresh" ? null : current);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (login?.status !== "running") return;
    const loginId = login.id;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const next = await gateway.getKiroCliLogin(loginId);
        if (disposed) return;
        setLogin(next);
        if (next.status === "running") {
          timer = setTimeout(() => void poll(), 1_250);
          return;
        }
        await refreshStatus();
      } catch (reason) {
        if (!disposed) setErrorKey(connectorErrorKey(reason));
      }
    };

    timer = setTimeout(() => void poll(), 800);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [login?.id, login?.status, refreshStatus]);

  const modeOptions = useMemo(() => [
    { value: "browser" as const, label: t("settings.providers.kiro.mode.browser") },
    { value: "device" as const, label: t("settings.providers.kiro.mode.device") },
  ], [t]);

  const identityCenter = method === "identity-center";
  const loginReady = !identityCenter || (identityProvider.trim().length > 0 && region.trim().length > 0);

  const startLogin = async (event: FormEvent) => {
    event.preventDefault();
    if (!connector?.installed || !loginReady || isRunning(login)) return;
    setBusy("login");
    setErrorKey(null);
    const input: KiroCliLoginInput = {
      mode,
      method,
      ...(identityCenter ? {
        identityProvider: identityProvider.trim(),
        region: region.trim(),
      } : {}),
    };
    try {
      setLogin(await gateway.startKiroCliLogin(input));
    } catch (reason) {
      setErrorKey(connectorErrorKey(reason));
    } finally {
      setBusy(null);
    }
  };

  const cancelLogin = async () => {
    if (!login || login.status !== "running") return;
    setBusy("cancel");
    setErrorKey(null);
    try {
      setLogin(await gateway.cancelKiroCliLogin(login.id));
      await refreshStatus();
    } catch (reason) {
      setErrorKey(connectorErrorKey(reason));
    } finally {
      setBusy(null);
    }
  };

  const discoverModels = async () => {
    setBusy("models");
    setErrorKey(null);
    try {
      const catalog = await gateway.getKiroCliModels();
      setModels(catalog.models);
    } catch (reason) {
      setErrorKey(connectorErrorKey(reason));
    } finally {
      setBusy(null);
    }
  };

  const logout = async () => {
    if (!window.confirm(t("settings.providers.kiro.logoutConfirm"))) return;
    setBusy("logout");
    setErrorKey(null);
    try {
      await gateway.logoutKiroCli();
      setModels([]);
      setLogin(null);
      await refreshStatus();
    } catch (reason) {
      setErrorKey(connectorErrorKey(reason));
    } finally {
      setBusy(null);
    }
  };

  const authenticated = connector?.authenticated === true;
  const loading = connector === null && busy === "refresh" && !errorKey;
  const actionBusy = busy !== null;

  return (
    <section
      aria-labelledby="kiro-cli-connector-title"
      className="overflow-hidden rounded-lg border border-border-soft bg-surface/35"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-soft px-3 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border-soft bg-surface text-muted">
            <TerminalSquare className="size-3.5" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id="kiro-cli-connector-title" className="text-[12px] font-semibold text-foreground">
                {t("settings.providers.kiro.title")}
              </h3>
              {connector?.installed ? (
                <Badge tone={authenticated ? "success" : "neutral"}>
                  {authenticated ? t("settings.providers.kiro.connected") : t("settings.providers.kiro.installed")}
                </Badge>
              ) : connector ? (
                <Badge tone="warning">{t("settings.providers.kiro.notInstalled")}</Badge>
              ) : null}
              {connector?.version ? <span className="font-mono text-[9px] text-faint">v{connector.version}</span> : null}
            </div>
            <p className="mt-1 max-w-3xl text-[10.5px] leading-4 text-muted">
              {t("settings.providers.kiro.description")}
            </p>
          </div>
        </div>
        <IconButton
          size="icon-sm"
          tip={t("settings.providers.kiro.refresh")}
          disabled={actionBusy}
          onClick={() => void refreshStatus(true)}
        >
          <RefreshCw className={cn("size-3.5", busy === "refresh" && "animate-spin")} aria-hidden />
        </IconButton>
      </div>

      <div className="space-y-3 px-3 py-3">
        <div className="flex items-start gap-2 rounded-md border border-warning/20 bg-warning/5 px-3 py-2 text-[10px] leading-4 text-warning">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <p>{t("settings.providers.kiro.transportPending")}</p>
        </div>

        {errorKey ? (
          <div className="flex items-start gap-2 rounded-md border border-danger/25 bg-danger/5 px-3 py-2 text-[10.5px] text-danger" role="alert">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{t(errorKey)}</span>
          </div>
        ) : null}

        {loading ? (
          <div className="flex min-h-20 items-center justify-center gap-2 text-[10.5px] text-muted" role="status">
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
            {t("settings.providers.kiro.loading")}
          </div>
        ) : null}

        {connector && !connector.installed ? (
          <div className="flex items-start gap-3 rounded-md border border-dashed border-border px-3 py-3">
            <KeyRound className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <div>
              <p className="text-[11px] font-medium text-foreground">{t("settings.providers.kiro.installTitle")}</p>
              <p className="mt-1 text-[10px] leading-4 text-muted">{t("settings.providers.kiro.installHint")}</p>
            </div>
          </div>
        ) : null}

        {connector?.installed && authenticated ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-success/20 bg-success/5 px-3 py-2.5">
              <div className="flex min-w-0 items-start gap-2">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-foreground">{t("settings.providers.kiro.authenticated")}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[9.5px] text-muted">
                    <span>{t(AUTH_METHOD_LABELS[connector.method])}</span>
                    <span aria-hidden>{"\u00b7"}</span>
                    <span>{t(ACCOUNT_TYPE_LABELS[connector.accountType])}</span>
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" disabled={actionBusy} onClick={() => void discoverModels()}>
                  {busy === "models" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
                  {t("settings.providers.kiro.models.discover")}
                </Button>
                <Button variant="ghost" size="sm" disabled={actionBusy} onClick={() => void logout()}>
                  {busy === "logout" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <LogOut className="size-3.5" aria-hidden />}
                  {t("settings.providers.kiro.logout")}
                </Button>
              </div>
            </div>

            {models.length > 0 ? (
              <div className="rounded-md border border-border-soft bg-bg/25">
                <div className="flex items-center justify-between gap-3 border-b border-border-soft px-3 py-2">
                  <span className="text-[10.5px] font-medium text-secondary">{t("settings.providers.kiro.models.title")}</span>
                  <span className="font-mono text-[9px] text-muted">{t("settings.providers.kiro.models.count", { count: models.length })}</span>
                </div>
                <ul className="grid max-h-40 gap-px overflow-y-auto bg-border-soft sm:grid-cols-2" aria-label={t("settings.providers.kiro.models.title")}>
                  {models.map((model) => (
                    <li key={model.id} className="min-w-0 bg-surface/85 px-3 py-1.5">
                      <span className="block truncate font-mono text-[9.5px] text-secondary" title={model.id}>
                        {model.name || model.id}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {connector?.installed && !authenticated && !isRunning(login) ? (
          <form className="space-y-3 rounded-md border border-border-soft bg-bg/25 p-3" onSubmit={(event) => void startLogin(event)}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="max-w-xl">
                <p className="text-[11px] font-medium text-foreground">{t("settings.providers.kiro.login.title")}</p>
                <p className="mt-1 text-[9.5px] leading-4 text-muted">
                  {mode === "browser" ? t("settings.providers.kiro.login.browserHint") : t("settings.providers.kiro.login.deviceHint")}
                </p>
              </div>
              <SegmentedControl value={mode} options={modeOptions} onChange={setMode} size="sm" />
            </div>

            <label className="block">
              <span className="text-[10px] font-medium text-secondary">{t("settings.providers.kiro.method.label")}</span>
              <select
                value={method}
                disabled={actionBusy}
                onChange={(event) => setMethod(event.target.value as KiroCliLoginMethod)}
                className="mt-1 h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[11px] text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/25 disabled:opacity-50"
              >
                {LOGIN_METHODS.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
              </select>
            </label>

            {identityCenter ? (
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem]">
                <label>
                  <span className="text-[10px] font-medium text-secondary">{t("settings.providers.kiro.identityProvider")}</span>
                  <Input
                    type="url"
                    required
                    value={identityProvider}
                    disabled={actionBusy}
                    onChange={(event) => setIdentityProvider(event.target.value)}
                    placeholder={t("settings.providers.kiro.identityProviderPlaceholder")}
                    autoComplete="url"
                    spellCheck={false}
                    className="mt-1"
                  />
                </label>
                <label>
                  <span className="text-[10px] font-medium text-secondary">{t("settings.providers.kiro.region")}</span>
                  <Input
                    required
                    value={region}
                    disabled={actionBusy}
                    onChange={(event) => setRegion(event.target.value)}
                    placeholder={t("settings.providers.kiro.regionPlaceholder")}
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-1 font-mono"
                  />
                </label>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-2xl text-[9.5px] leading-4 text-muted">{t("settings.providers.kiro.singleAccountHint")}</p>
              <Button type="submit" size="sm" disabled={actionBusy || !loginReady}>
                {busy === "login" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <KeyRound className="size-3.5" aria-hidden />}
                {t(mode === "browser" ? "settings.providers.kiro.login.openBrowser" : "settings.providers.kiro.login.startDevice")}
              </Button>
            </div>
          </form>
        ) : null}

        {login ? (
          <div className="overflow-hidden rounded-md border border-border-soft bg-bg/45">
            <div className="flex items-center justify-between gap-3 border-b border-border-soft px-3 py-2">
              <span className="flex items-center gap-2 text-[10.5px] font-medium text-secondary">
                {login.status === "running" ? <LoaderCircle className="size-3.5 animate-spin text-primary" aria-hidden /> : null}
                {t(LOGIN_STATUS_LABELS[login.status])}
              </span>
              {login.status === "running" ? (
                <Button variant="ghost" size="sm" disabled={busy === "cancel"} onClick={() => void cancelLogin()}>
                  {busy === "cancel" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <X className="size-3.5" aria-hidden />}
                  {t("settings.providers.kiro.login.cancel")}
                </Button>
              ) : null}
            </div>
            <pre
              className="max-h-40 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[9px] leading-4 text-muted"
              aria-live="polite"
              aria-atomic="false"
            >
              {login.progress.trim() || t("settings.providers.kiro.login.waiting")}
            </pre>
          </div>
        ) : null}
      </div>
    </section>
  );
}
