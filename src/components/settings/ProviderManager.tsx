import { useEffect, useMemo, useState } from "react";
import { Check, KeyRound, Plus, Server, Trash2 } from "lucide-react";
import { GatewayRequestError, gateway } from "@/lib/gateway";
import type { AppConfig, ProviderCredentialsInput, ProviderProfile, ProviderProtocol } from "@/lib/types";
import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useI18n, type TranslationKey, type TranslationParams } from "@/i18n";
import {
  validateProviderCredentials,
  validateProviderDraft,
} from "./provider-validation";

interface ProviderManagerProps {
  config: AppConfig;
  onSaved: (config: AppConfig) => void;
}

interface ProviderError {
  key: TranslationKey;
  params?: TranslationParams;
}

function modelText(provider: ProviderProfile | undefined): string {
  return provider?.models.map((model) => model.id).join("\n") ?? "";
}

const PROTOCOL_OPTIONS = [
  { value: "openai-chat", labelKey: "settings.providers.protocol.openaiChat", defaultBaseURL: "https://api.openai.com/v1" },
  { value: "openai-responses", labelKey: "settings.providers.protocol.openaiResponses", defaultBaseURL: "https://api.openai.com/v1" },
  { value: "anthropic-messages", labelKey: "settings.providers.protocol.anthropic", defaultBaseURL: "https://api.anthropic.com/v1" },
  { value: "google-generative-ai", labelKey: "settings.providers.protocol.google", defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta" },
  { value: "amazon-bedrock", labelKey: "settings.providers.protocol.bedrock", defaultBaseURL: "https://bedrock-runtime.us-east-1.amazonaws.com" },
  { value: "google-vertex", labelKey: "settings.providers.protocol.vertex", defaultBaseURL: "https://aiplatform.googleapis.com" },
] as const satisfies readonly {
  value: ProviderProtocol;
  labelKey: TranslationKey;
  defaultBaseURL: string;
}[];

const PROVIDER_SERVER_ERRORS: Readonly<Record<string, TranslationKey>> = {
  provider_not_found: "settings.providers.error.notFound",
  provider_unavailable: "settings.providers.error.unavailable",
  provider_final_profile: "settings.providers.error.finalProfile",
  provider_credentials_required: "settings.providers.error.credentialsRequired",
  provider_credentials_incomplete: "settings.providers.error.credentialsIncomplete",
  provider_operation_failed: "settings.providers.error.operationFailed",
};

function requestError(cause: unknown): ProviderError {
  if (cause instanceof GatewayRequestError && cause.code === "capability_unavailable") {
    return { key: "settings.providers.gatewayUnavailable" };
  }
  if (cause instanceof GatewayRequestError && cause.serverCode) {
    const key = PROVIDER_SERVER_ERRORS[cause.serverCode];
    if (key) return { key, params: cause.serverArgs };
  }
  const detail = cause instanceof GatewayRequestError
    ? [cause.status, cause.detail].filter(Boolean).join(": ")
    : cause instanceof Error
      ? cause.message
      : String(cause);
  return { key: "settings.providers.requestFailed", params: { detail } };
}

/** Compact editor for Kyrei's built-in and unlimited custom provider transports. */
export function ProviderManager({ config, onSaved }: ProviderManagerProps) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState(config.activeProviderId);
  const selected = useMemo(
    () => config.providers.find((provider) => provider.id === selectedId)
      ?? config.providers.find((provider) => provider.id === config.activeProviderId),
    [config.providers, config.activeProviderId, selectedId],
  );
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<ProviderProtocol>("openai-chat");
  const [baseURL, setBaseURL] = useState("");
  const [models, setModels] = useState("");
  const [requiresApiKey, setRequiresApiKey] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [project, setProject] = useState("");
  const [location, setLocation] = useState("us-central1");
  const [clientEmail, setClientEmail] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ProviderError | null>(null);

  useEffect(() => {
    const next = config.providers.find((provider) => provider.id === selectedId)
      ?? config.providers.find((provider) => provider.id === config.activeProviderId);
    if (!next) return;
    setSelectedId(next.id);
    setName(next.name);
    setProtocol(next.protocol);
    setBaseURL(next.baseURL);
    setModels(modelText(next));
    setRequiresApiKey(next.requiresApiKey);
    setApiKey("");
    setRegion(next.protocol === "amazon-bedrock" && next.hasStoredCredentials ? "" : "us-east-1");
    setAccessKeyId("");
    setSecretAccessKey("");
    setSessionToken("");
    setProject("");
    setLocation(next.protocol === "google-vertex" && next.hasStoredCredentials ? "" : "us-central1");
    setClientEmail("");
    setPrivateKey("");
  }, [config.providers, config.activeProviderId, selectedId]);

  const receive = (next: AppConfig) => {
    setError(null);
    onSaved(next);
  };

  const create = async () => {
    setBusy(true);
    try {
      const next = await gateway.createProvider({
        name: t("settings.providers.newName"),
        protocol: "openai-chat",
        baseURL: "https://api.openai.com/v1",
        models: [{ id: "gpt-4o-mini" }],
        enabled: true,
        requiresApiKey: true,
      });
      receive(next);
      setSelectedId(next.activeProviderId);
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!selected) return;
    const validation = validateProviderDraft({ name, baseURL, models });
    if (!validation.ok) {
      setError({ key: validation.code });
      return;
    }
    setBusy(true);
    try {
      receive(await gateway.updateProvider(selected.id, {
        name: name.trim(),
        protocol,
        baseURL: baseURL.trim(),
        models: validation.models,
        requiresApiKey,
        enabled: true,
      }));
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  };

  const select = async (provider: ProviderProfile) => {
    setBusy(true);
    try {
      receive(await gateway.setConfig({ activeProviderId: provider.id, model: provider.models[0]?.id ?? "" }));
      setSelectedId(provider.id);
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveSecret = async () => {
    if (!selected) return;
    if (protocol !== selected.protocol) {
      setError({ key: "settings.providers.transportChanged" });
      return;
    }

    let credentials: ProviderCredentialsInput;
    if (protocol === "amazon-bedrock") {
      credentials = {
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        region: region.trim(),
        ...(accessKeyId.trim() ? { accessKeyId: accessKeyId.trim() } : {}),
        ...(secretAccessKey.trim() ? { secretAccessKey: secretAccessKey.trim() } : {}),
        ...(sessionToken.trim() ? { sessionToken: sessionToken.trim() } : {}),
      };
    } else if (protocol === "google-vertex") {
      credentials = {
        project: project.trim(),
        location: location.trim(),
        clientEmail: clientEmail.trim(),
        privateKey: privateKey.trim(),
      };
    } else {
      credentials = { apiKey: apiKey.trim() };
    }

    const validation = validateProviderCredentials(protocol, credentials);
    if (!validation.ok) {
      setError({ key: validation.code });
      return;
    }

    setBusy(true);
    try {
      receive(await gateway.setProviderSecret(selected.id, credentials));
      setApiKey("");
      setAccessKeyId("");
      setSecretAccessKey("");
      setSessionToken("");
      setClientEmail("");
      setPrivateKey("");
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  };

  const clearSecret = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      receive(await gateway.clearProviderSecret(selected.id));
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      receive(await gateway.deleteProvider(selected.id));
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-border-soft py-3 @container">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="text-[12px] font-medium text-foreground">{t("settings.providers.title")}</div>
          <p className="mt-0.5 max-w-3xl text-[11px] leading-4 text-muted">{t("settings.providers.description")}</p>
        </div>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void create()}>
          <Plus size={14} /> {t("settings.providers.add")}
        </Button>
      </div>

      <div className="grid gap-3 @[42rem]:grid-cols-[10.5rem_minmax(0,1fr)]">
        <div className="max-h-44 space-y-1 overflow-y-auto pr-1 @[42rem]:max-h-none">
          {config.providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              disabled={busy}
              onClick={() => void select(provider)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors",
                provider.id === config.activeProviderId
                  ? "bg-elevated text-foreground"
                  : "text-secondary hover:bg-(--ui-row-hover)",
              )}
            >
              <Server size={13} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{provider.name}</span>
              <span className="rounded bg-bg px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted">
                {provider.protocol.replace(/-/g, " ")}
              </span>
              {provider.hasStoredCredentials ? <KeyRound size={12} className="text-success" /> : null}
              {provider.id === config.activeProviderId ? <Check size={12} className="text-primary" /> : null}
            </button>
          ))}
        </div>

        {selected ? (
          <div className="space-y-2 border-t border-border-soft pt-3 @[42rem]:border-l @[42rem]:border-t-0 @[42rem]:pl-3 @[42rem]:pt-0">
            <div className="grid gap-2 @[28rem]:grid-cols-2">
              <label className="space-y-1 text-[11px] text-muted">
                <span>{t("settings.providers.name")}</span>
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("settings.providers.namePlaceholder")} />
              </label>
              <label className="space-y-1 text-[11px] text-muted">
                <span>{t("settings.providers.transport")}</span>
                <select
                  value={protocol}
                  onChange={(event) => {
                    const next = event.target.value as ProviderProtocol;
                    setProtocol(next);
                    const suggested = PROTOCOL_OPTIONS.find((option) => option.value === next)?.defaultBaseURL;
                    if (suggested && (!baseURL.trim() || baseURL === selected.baseURL)) setBaseURL(suggested);
                  }}
                  className="h-9 w-full rounded-md border border-border bg-surface px-2.5 text-[12px] text-foreground outline-none transition-colors focus:border-primary"
                >
                  {PROTOCOL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block space-y-1 text-[11px] text-muted">
              <span>{t("settings.providers.baseUrl")}</span>
              <Input value={baseURL} onChange={(event) => setBaseURL(event.target.value)} placeholder="https://api.example.com/v1" />
            </label>
            <label className="block space-y-1 text-[11px] text-muted">
              <span>{t("settings.providers.models")}</span>
              <textarea
                value={models}
                onChange={(event) => setModels(event.target.value)}
                rows={3}
                className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-muted focus:border-primary"
                placeholder="gpt-4o-mini"
              />
            </label>
            <label className="flex items-center gap-2 text-[11px] text-secondary">
              <input type="checkbox" checked={requiresApiKey} onChange={(event) => setRequiresApiKey(event.target.checked)} />
              {t("settings.providers.requiresCredentials")}
            </label>

            {requiresApiKey && protocol === "amazon-bedrock" ? (
              <div className="grid gap-2 rounded-md border border-border-soft bg-bg/30 p-2 @[28rem]:grid-cols-2">
                <label className="space-y-1 text-[11px] text-muted">
                  <span>{t("settings.providers.region")}</span>
                  <Input value={region} onChange={(event) => setRegion(event.target.value)} placeholder={selected.hasStoredCredentials ? t("settings.providers.replaceRegion") : "us-east-1"} />
                </label>
                <label className="space-y-1 text-[11px] text-muted">
                  <span>{t("settings.providers.accessKeyId")}</span>
                  <Input value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} placeholder={selected.hasStoredCredentials ? t("settings.providers.saved") : "AKIA…"} />
                </label>
                <label className="space-y-1 text-[11px] text-muted">
                  <span>{t("settings.providers.secretAccessKey")}</span>
                  <Input type="password" value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} placeholder={selected.hasStoredCredentials ? "••••••••" : t("settings.providers.secretPlaceholder")} />
                </label>
                <label className="space-y-1 text-[11px] text-muted">
                  <span>{t("settings.providers.sessionToken")}</span>
                  <Input type="password" value={sessionToken} onChange={(event) => setSessionToken(event.target.value)} placeholder={t("settings.providers.sessionTokenPlaceholder")} />
                </label>
              </div>
            ) : null}

            {requiresApiKey && protocol === "google-vertex" ? (
              <div className="grid gap-2 rounded-md border border-border-soft bg-bg/30 p-2 @[28rem]:grid-cols-2">
                <label className="space-y-1 text-[11px] text-muted">
                  <span>{t("settings.providers.project")}</span>
                  <Input value={project} onChange={(event) => setProject(event.target.value)} placeholder="my-project" />
                </label>
                <label className="space-y-1 text-[11px] text-muted">
                  <span>{t("settings.providers.location")}</span>
                  <Input value={location} onChange={(event) => setLocation(event.target.value)} placeholder={selected.hasStoredCredentials ? t("settings.providers.replaceLocation") : "us-central1"} />
                </label>
                <label className="space-y-1 text-[11px] text-muted @[28rem]:col-span-2">
                  <span>{t("settings.providers.clientEmail")}</span>
                  <Input value={clientEmail} onChange={(event) => setClientEmail(event.target.value)} placeholder="kyrei@project.iam.gserviceaccount.com" />
                </label>
                <label className="space-y-1 text-[11px] text-muted @[28rem]:col-span-2">
                  <span>{t("settings.providers.privateKey")}</span>
                  <textarea
                    value={privateKey}
                    onChange={(event) => setPrivateKey(event.target.value)}
                    rows={3}
                    placeholder={selected.hasStoredCredentials ? t("settings.providers.replacePrivateKey") : "-----BEGIN PRIVATE KEY-----"}
                    className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 font-mono text-[11px] text-foreground outline-none transition-colors placeholder:text-muted focus:border-primary"
                  />
                </label>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void save()}>{t("settings.providers.save")}</Button>
              {requiresApiKey ? <div className="ml-auto flex items-center gap-1.5">
                {protocol !== "google-vertex" ? (
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={selected.hasStoredCredentials ? "••••••••" : protocol === "amazon-bedrock" ? t("settings.providers.bearerOptional") : t("settings.providers.apiKey")}
                    className="h-7 w-36 text-[11px]"
                  />
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || (!(["amazon-bedrock", "google-vertex"] as ProviderProtocol[]).includes(protocol) && !apiKey.trim())}
                  onClick={() => void saveSecret()}
                >
                  {(["amazon-bedrock", "google-vertex"] as ProviderProtocol[]).includes(protocol)
                    ? t("settings.providers.access")
                    : t("settings.providers.key")}
                </Button>
                {selected.hasStoredCredentials ? (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void clearSecret()}>{t("settings.providers.removeAccess")}</Button>
                ) : null}
                {config.providers.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void remove()}
                    className="text-danger hover:text-danger"
                    aria-label={t("settings.providers.delete")}
                  >
                    <Trash2 size={13} />
                  </Button>
                ) : null}
              </div> : null}
            </div>
            {error ? <p className="text-[11px] text-danger">{t(error.key, error.params)}</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
