import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, KeyRound, Link2, LoaderCircle, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui";
import { ExperimentalRiskBadge } from "@/components/settings/ExperimentalRiskBadge";
import { useI18n } from "@/i18n";
import { desktopShell } from "@/lib/desktop";
import { gateway } from "@/lib/gateway";
import { isExperimentalFeatureEnabled } from "@/lib/experimental";
import type { AppConfig } from "@/lib/types";

interface BrowserSubscriptionAuthCardProps {
  config: AppConfig;
  onSaved: (config: AppConfig) => void;
}

interface BsSession {
  id: string;
  vendorId: string;
  label: string;
  status: string;
  flow?: string;
  providerId?: string | null;
  hasStoredToken?: boolean;
  updatedAt?: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  pollIntervalSec?: number;
  deviceExpiresAt?: string;
  errorCode?: string;
}

interface BsProfile {
  id: string;
  label: string;
  vendorId?: string;
  clientId: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  scope?: string;
  hasClientSecret?: boolean;
}

interface BsSnapshot {
  allowed: boolean;
  vendors: Array<{ id: string; label: string; defaultBaseURL: string; docsHint?: string }>;
  sessions: BsSession[];
  profiles?: BsProfile[];
  activeProfileId?: string;
}

export function BrowserSubscriptionAuthCard({ config, onSaved }: BrowserSubscriptionAuthCardProps) {
  const { t } = useI18n();
  const allowed = isExperimentalFeatureEnabled(config, "browserSubscriptionAuth");
  const [snapshot, setSnapshot] = useState<BsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState("custom-openai-compatible");
  const [flow, setFlow] = useState<"manual" | "device">("manual");
  const [clientId, setClientId] = useState("");
  const [deviceAuthUrl, setDeviceAuthUrl] = useState("");
  const [tokenUrl, setTokenUrl] = useState("");
  const [scope, setScope] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [profileLabel, setProfileLabel] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [tokenDraft, setTokenDraft] = useState<Record<string, string>>({});
  const [linkDraft, setLinkDraft] = useState<Record<string, string>>({});
  const pollTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const applyProfile = useCallback((profile: BsProfile | undefined) => {
    if (!profile) return;
    setSelectedProfileId(profile.id);
    setClientId(profile.clientId);
    setDeviceAuthUrl(profile.deviceAuthorizationEndpoint);
    setTokenUrl(profile.tokenEndpoint);
    setScope(profile.scope ?? "");
    setProfileLabel(profile.label);
    if (profile.vendorId) setVendorId(profile.vendorId);
    setFlow("device");
    setClientSecret("");
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await gateway.getBrowserSubscriptionAuth();
      setSnapshot(next);
      if (next.vendors[0] && !next.vendors.some((v) => v.id === vendorId)) {
        setVendorId(next.vendors[0].id);
      }
      if (next.activeProfileId && !selectedProfileId) {
        const active = next.profiles?.find((p) => p.id === next.activeProfileId);
        if (active) applyProfile(active);
      }
      return next;
    } catch {
      setSnapshot(null);
      return null;
    }
  }, [applyProfile, selectedProfileId, vendorId]);

  useEffect(() => {
    if (allowed) void refresh();
  }, [allowed, refresh, config.experimental]);

  useEffect(() => {
    const timers = pollTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const schedulePoll = useCallback((session: BsSession) => {
    if (session.flow !== "device" || session.status !== "awaiting_browser") return;
    const existing = pollTimers.current.get(session.id);
    if (existing) clearTimeout(existing);
    const delay = Math.max(3, session.pollIntervalSec ?? 5) * 1_000;
    const timer = setTimeout(async () => {
      try {
        const result = await gateway.pollBrowserSubscriptionSession(session.id);
        if (result.pollStatus === "ready") {
          onSaved(await gateway.getConfig());
        }
        const next = await refresh();
        const updated = next?.sessions.find((row) => row.id === session.id);
        if (updated && updated.status === "awaiting_browser") {
          schedulePoll(updated);
        }
      } catch {
        /* keep manual poll button */
      }
    }, delay);
    pollTimers.current.set(session.id, timer);
  }, [onSaved, refresh]);

  useEffect(() => {
    for (const session of snapshot?.sessions ?? []) {
      if (session.flow === "device" && session.status === "awaiting_browser") {
        schedulePoll(session);
      }
    }
  }, [snapshot, schedulePoll]);

  if (!allowed) return null;

  const saveProfile = async () => {
    if (!clientId.trim() || !deviceAuthUrl.trim() || !tokenUrl.trim()) {
      setError(t("settings.experimental.browserAuth.deviceFieldsRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await gateway.saveBrowserSubscriptionProfile({
        ...(selectedProfileId ? { id: selectedProfileId } : {}),
        label: profileLabel.trim() || clientId.trim(),
        vendorId,
        clientId: clientId.trim(),
        deviceAuthorizationEndpoint: deviceAuthUrl.trim(),
        tokenEndpoint: tokenUrl.trim(),
        ...(scope.trim() ? { scope: scope.trim() } : {}),
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      });
      setClientSecret("");
      setSelectedProfileId(result.profile.id);
      setProfileLabel(result.profile.label);
      await refresh();
      onSaved(await gateway.getConfig());
    } catch {
      setError(t("settings.experimental.browserAuth.error"));
    } finally {
      setBusy(false);
    }
  };

  const deleteProfile = async () => {
    if (!selectedProfileId) return;
    setBusy(true);
    setError(null);
    try {
      await gateway.deleteBrowserSubscriptionProfile(selectedProfileId);
      setSelectedProfileId("");
      setProfileLabel("");
      await refresh();
      onSaved(await gateway.getConfig());
    } catch {
      setError(t("settings.experimental.browserAuth.error"));
    } finally {
      setBusy(false);
    }
  };

  const startSession = async () => {
    setBusy(true);
    setError(null);
    try {
      if (flow === "device") {
        if (selectedProfileId) {
          await gateway.startBrowserSubscriptionSession({
            vendorId,
            flow: "device",
            profileId: selectedProfileId,
            ...(clientSecret.trim()
              ? { deviceFlow: { clientSecret: clientSecret.trim() } }
              : {}),
          });
        } else {
          if (!clientId.trim() || !deviceAuthUrl.trim() || !tokenUrl.trim()) {
            setError(t("settings.experimental.browserAuth.deviceFieldsRequired"));
            return;
          }
          await gateway.startBrowserSubscriptionSession({
            vendorId,
            flow: "device",
            deviceFlow: {
              clientId: clientId.trim(),
              deviceAuthorizationEndpoint: deviceAuthUrl.trim(),
              tokenEndpoint: tokenUrl.trim(),
              ...(scope.trim() ? { scope: scope.trim() } : {}),
              ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
            },
          });
        }
        setClientSecret("");
      } else {
        await gateway.startBrowserSubscriptionSession({ vendorId, flow: "manual" });
      }
      await refresh();
      onSaved(await gateway.getConfig());
    } catch {
      setError(t("settings.experimental.browserAuth.error"));
    } finally {
      setBusy(false);
    }
  };

  const bindToken = async (sessionId: string) => {
    const accessToken = (tokenDraft[sessionId] ?? "").trim();
    if (!accessToken) return;
    setBusy(true);
    setError(null);
    try {
      await gateway.bindBrowserSubscriptionToken(sessionId, { accessToken });
      setTokenDraft((current) => ({ ...current, [sessionId]: "" }));
      await refresh();
      onSaved(await gateway.getConfig());
    } catch {
      setError(t("settings.experimental.browserAuth.error"));
    } finally {
      setBusy(false);
    }
  };

  const pollNow = async (sessionId: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await gateway.pollBrowserSubscriptionSession(sessionId);
      if (result.pollStatus === "ready") onSaved(await gateway.getConfig());
      await refresh();
    } catch {
      setError(t("settings.experimental.browserAuth.error"));
    } finally {
      setBusy(false);
    }
  };

  const openVerification = async (uri: string) => {
    try {
      if (desktopShell.available()) {
        // Pass the session URI so custom OAuth hosts (not on the static allowlist)
        // can open when they exactly match this experimental session.
        await desktopShell.openExternal(uri, { sessionVerificationUri: uri });
      } else if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(uri);
      }
    } catch {
      try {
        await navigator.clipboard?.writeText(uri);
      } catch {
        setError(t("settings.experimental.browserAuth.openFailed"));
      }
    }
  };

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      /* ignore */
    }
  };

  const linkProvider = async (sessionId: string) => {
    const providerId = (linkDraft[sessionId] ?? "").trim();
    if (!providerId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await gateway.linkBrowserSubscriptionSession(sessionId, providerId);
      if (result.config) onSaved(result.config);
      await refresh();
    } catch {
      setError(t("settings.experimental.browserAuth.error"));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (sessionId: string) => {
    setBusy(true);
    setError(null);
    try {
      await gateway.revokeBrowserSubscriptionSession(sessionId);
      await refresh();
      onSaved(await gateway.getConfig());
    } catch {
      setError(t("settings.experimental.browserAuth.error"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (sessionId: string) => {
    setBusy(true);
    setError(null);
    try {
      await gateway.deleteBrowserSubscriptionSession(sessionId);
      await refresh();
      onSaved(await gateway.getConfig());
    } catch {
      setError(t("settings.experimental.browserAuth.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-warning/25 bg-surface/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="size-4 text-warning" aria-hidden />
        <h4 className="text-[12px] font-semibold text-foreground">
          {t("settings.experimental.browserAuth.title")}
        </h4>
        <ExperimentalRiskBadge />
      </div>
      <p className="text-[10.5px] leading-4 text-muted">
        {t("settings.experimental.browserAuth.hint")}
      </p>
      <p className="text-[10px] leading-4 text-muted">
        {t("settings.experimental.browserAuth.deviceHint")}
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-[10px] text-muted">{t("settings.experimental.browserAuth.vendor")}</span>
          <select
            value={vendorId}
            disabled={busy}
            className="h-8 w-full rounded-md border border-border bg-bg px-2 text-[11px] text-foreground"
            onChange={(event) => setVendorId(event.target.value)}
          >
            {(snapshot?.vendors ?? []).map((vendor) => (
              <option key={vendor.id} value={vendor.id}>{vendor.label}</option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-[10px] text-muted">{t("settings.experimental.browserAuth.flow")}</span>
          <select
            value={flow}
            disabled={busy}
            className="h-8 w-full rounded-md border border-border bg-bg px-2 text-[11px] text-foreground"
            onChange={(event) => setFlow(event.target.value as "manual" | "device")}
          >
            <option value="manual">{t("settings.experimental.browserAuth.flow.manual")}</option>
            <option value="device">{t("settings.experimental.browserAuth.flow.device")}</option>
          </select>
        </label>
      </div>

      {flow === "device" ? (
        <div className="grid gap-2 rounded-md border border-border-soft bg-bg/40 p-2 sm:grid-cols-2">
          <label className="block space-y-1 sm:col-span-2">
            <span className="text-[10px] text-muted">{t("settings.experimental.browserAuth.savedProfiles")}</span>
            <div className="flex flex-wrap gap-2">
              <select
                value={selectedProfileId}
                disabled={busy}
                className="h-8 min-w-[12rem] flex-1 rounded-md border border-border bg-bg px-2 text-[11px]"
                onChange={(event) => {
                  const id = event.target.value;
                  if (!id) {
                    setSelectedProfileId("");
                    return;
                  }
                  const profile = snapshot?.profiles?.find((row) => row.id === id);
                  applyProfile(profile);
                }}
              >
                <option value="">{t("settings.experimental.browserAuth.profileNew")}</option>
                {(snapshot?.profiles ?? []).map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label}{profile.hasClientSecret ? " · 🔑" : ""}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void saveProfile()}>
                {t("settings.experimental.browserAuth.saveProfile")}
              </Button>
              {selectedProfileId ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void deleteProfile()}>
                  {t("settings.experimental.browserAuth.deleteProfile")}
                </Button>
              ) : null}
            </div>
          </label>
          <label className="block space-y-1 sm:col-span-2">
            <span className="text-[10px] text-muted">{t("settings.experimental.browserAuth.profileLabel")}</span>
            <input
              value={profileLabel}
              onChange={(event) => setProfileLabel(event.target.value)}
              disabled={busy}
              placeholder={t("settings.experimental.browserAuth.profileLabelPlaceholder")}
              className="h-8 w-full rounded-md border border-border bg-bg px-2 text-[11px]"
            />
          </label>
          <label className="block space-y-1 sm:col-span-2">
            <span className="text-[10px] text-muted">{t("settings.experimental.browserAuth.clientId")}</span>
            <input
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              disabled={busy}
              spellCheck={false}
              className="h-8 w-full rounded-md border border-border bg-bg px-2 font-mono text-[11px]"
            />
          </label>
          <label className="block space-y-1 sm:col-span-2">
            <span className="text-[10px] text-muted">{t("settings.experimental.browserAuth.deviceAuthUrl")}</span>
            <input
              value={deviceAuthUrl}
              onChange={(event) => setDeviceAuthUrl(event.target.value)}
              disabled={busy}
              spellCheck={false}
              placeholder="https://…/oauth/device/code"
              className="h-8 w-full rounded-md border border-border bg-bg px-2 font-mono text-[11px]"
            />
          </label>
          <label className="block space-y-1 sm:col-span-2">
            <span className="text-[10px] text-muted">{t("settings.experimental.browserAuth.tokenUrl")}</span>
            <input
              value={tokenUrl}
              onChange={(event) => setTokenUrl(event.target.value)}
              disabled={busy}
              spellCheck={false}
              placeholder="https://…/oauth/token"
              className="h-8 w-full rounded-md border border-border bg-bg px-2 font-mono text-[11px]"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] text-muted">{t("settings.experimental.browserAuth.scope")}</span>
            <input
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              disabled={busy}
              spellCheck={false}
              className="h-8 w-full rounded-md border border-border bg-bg px-2 font-mono text-[11px]"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] text-muted">{t("settings.experimental.browserAuth.clientSecret")}</span>
            <input
              type="password"
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
              disabled={busy}
              autoComplete="off"
              className="h-8 w-full rounded-md border border-border bg-bg px-2 font-mono text-[11px]"
            />
          </label>
        </div>
      ) : null}

      <Button size="sm" disabled={busy} onClick={() => void startSession()}>
        {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
        {t("settings.experimental.browserAuth.start")}
      </Button>

      <ul className="divide-y divide-border-soft rounded-md border border-border-soft">
        {(snapshot?.sessions ?? []).length === 0 ? (
          <li className="px-2.5 py-3 text-[10.5px] text-muted">
            {t("settings.experimental.browserAuth.empty")}
          </li>
        ) : (
          (snapshot?.sessions ?? []).map((session) => (
            <li key={session.id} className="space-y-2 px-2.5 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[11px] font-medium text-foreground">{session.label}</p>
                  <p className="font-mono text-[10px] text-muted">
                    {session.id} · {session.flow ?? "manual"} · {session.status}
                    {session.providerId ? ` · → ${session.providerId}` : ""}
                    {session.errorCode ? ` · ${session.errorCode}` : ""}
                  </p>
                </div>
                <div className="flex gap-1">
                  {session.status !== "revoked" ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void revoke(session.id)}>
                      {t("settings.experimental.browserAuth.revoke")}
                    </Button>
                  ) : null}
                  <Button size="icon-sm" variant="ghost" disabled={busy} onClick={() => void remove(session.id)} aria-label={t("settings.experimental.browserAuth.delete")}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>

              {session.flow === "device" && session.status === "awaiting_browser" ? (
                <div className="space-y-2 rounded-md border border-warning/20 bg-warning/5 p-2">
                  {session.userCode ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] text-muted">{t("settings.experimental.browserAuth.userCode")}</span>
                      <code className="rounded bg-bg px-2 py-1 font-mono text-[13px] font-semibold tracking-wider text-foreground">
                        {session.userCode}
                      </code>
                      <Button size="icon-sm" variant="ghost" onClick={() => void copyText(session.userCode!)} aria-label={t("settings.experimental.browserAuth.copy")}>
                        <Copy className="size-3.5" />
                      </Button>
                    </div>
                  ) : null}
                  {session.verificationUri ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void openVerification(session.verificationUriComplete || session.verificationUri!)}
                      >
                        <ExternalLink className="size-3.5" />
                        {t("settings.experimental.browserAuth.openVerify")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void copyText(session.verificationUri!)}>
                        <Copy className="size-3.5" />
                        {t("settings.experimental.browserAuth.copyUrl")}
                      </Button>
                      <Button size="sm" disabled={busy} onClick={() => void pollNow(session.id)}>
                        {t("settings.experimental.browserAuth.poll")}
                      </Button>
                    </div>
                  ) : null}
                  <p className="text-[10px] text-muted">{t("settings.experimental.browserAuth.polling")}</p>
                </div>
              ) : null}

              {(session.status === "pending_token" || (session.status === "awaiting_browser" && session.flow !== "device")) ? (
                <div className="flex flex-wrap gap-2">
                  <input
                    type="password"
                    value={tokenDraft[session.id] ?? ""}
                    onChange={(event) => setTokenDraft((current) => ({
                      ...current,
                      [session.id]: event.target.value,
                    }))}
                    placeholder={t("settings.experimental.browserAuth.tokenPlaceholder")}
                    className="h-8 min-w-[14rem] flex-1 rounded-md border border-border bg-bg px-2 font-mono text-[11px]"
                    disabled={busy}
                    autoComplete="off"
                  />
                  <Button size="sm" disabled={busy} onClick={() => void bindToken(session.id)}>
                    {t("settings.experimental.browserAuth.bind")}
                  </Button>
                </div>
              ) : null}

              {session.status === "ready" ? (
                <div className="flex flex-wrap gap-2">
                  <select
                    value={linkDraft[session.id] ?? ""}
                    onChange={(event) => setLinkDraft((current) => ({
                      ...current,
                      [session.id]: event.target.value,
                    }))}
                    disabled={busy}
                    className="h-8 min-w-[12rem] rounded-md border border-border bg-bg px-2 text-[11px]"
                  >
                    <option value="">{t("settings.experimental.browserAuth.pickProvider")}</option>
                    {(config.providers ?? []).map((provider) => (
                      <option key={provider.id} value={provider.id}>{provider.name}</option>
                    ))}
                  </select>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void linkProvider(session.id)}>
                    <Link2 className="size-3.5" />
                    {t("settings.experimental.browserAuth.link")}
                  </Button>
                </div>
              ) : null}
            </li>
          ))
        )}
      </ul>

      {error ? <p className="text-[10.5px] text-danger">{error}</p> : null}
    </section>
  );
}
