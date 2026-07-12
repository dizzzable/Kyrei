import { useEffect, useMemo, useState } from "react";
import { Check, KeyRound, Plus, Server, Trash2 } from "lucide-react";
import { gateway } from "@/lib/gateway";
import type { AppConfig, ProviderCredentialsInput, ProviderProfile, ProviderProtocol } from "@/lib/types";
import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/utils";

interface ProviderManagerProps {
  config: AppConfig;
  onSaved: (config: AppConfig) => void;
}

function modelText(provider: ProviderProfile | undefined): string {
  return provider?.models.map((model) => model.id).join("\n") ?? "";
}

function parseModels(value: string): Array<{ id: string }> {
  return [...new Set(value.split(/[\n,]/).map((model) => model.trim()).filter(Boolean))].map((id) => ({ id }));
}

const PROTOCOL_OPTIONS: Array<{ value: ProviderProtocol; label: string; defaultBaseURL: string }> = [
  { value: "openai-chat", label: "OpenAI-compatible / Chat", defaultBaseURL: "https://api.openai.com/v1" },
  { value: "openai-responses", label: "OpenAI / Responses", defaultBaseURL: "https://api.openai.com/v1" },
  { value: "anthropic-messages", label: "Anthropic / Messages", defaultBaseURL: "https://api.anthropic.com/v1" },
  { value: "google-generative-ai", label: "Google Gemini / Generative AI", defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta" },
  { value: "amazon-bedrock", label: "AWS Bedrock / Converse", defaultBaseURL: "https://bedrock-runtime.us-east-1.amazonaws.com" },
  { value: "google-vertex", label: "Google Vertex AI", defaultBaseURL: "https://aiplatform.googleapis.com" },
];

/** Compact editor for Kyrei's built-in provider transports. */
export function ProviderManager({ config, onSaved }: ProviderManagerProps) {
  const [selectedId, setSelectedId] = useState(config.activeProviderId);
  const selected = useMemo(
    () => config.providers.find((provider) => provider.id === selectedId) ?? config.providers.find((provider) => provider.id === config.activeProviderId),
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
  const [error, setError] = useState<string | null>(null);

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
    setRegion(next.protocol === "amazon-bedrock" && next.hasKey ? "" : "us-east-1");
    setAccessKeyId("");
    setSecretAccessKey("");
    setSessionToken("");
    setProject("");
    setLocation(next.protocol === "google-vertex" && next.hasKey ? "" : "us-central1");
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
        name: "Новый провайдер",
        protocol: "openai-chat",
        baseURL: "https://api.openai.com/v1",
        models: [{ id: "gpt-4o-mini" }],
        enabled: true,
        requiresApiKey: true,
      });
      receive(next);
      setSelectedId(next.activeProviderId);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!selected) return;
    const nextModels = parseModels(models);
    if (!name.trim() || !baseURL.trim() || !nextModels.length) {
      setError("Укажите название, Base URL и хотя бы одну модель.");
      return;
    }
    setBusy(true);
    try {
      const next = await gateway.updateProvider(selected.id, {
        name: name.trim(),
        protocol,
        baseURL: baseURL.trim(),
        models: nextModels,
        requiresApiKey,
        enabled: true,
      });
      receive(next);
    } catch (cause) {
      setError((cause as Error).message);
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
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveSecret = async () => {
    if (!selected) return;
    if (protocol !== selected.protocol) {
      setError("Сначала сохраните выбранный транспорт провайдера, затем добавьте учётные данные.");
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
      if (!credentials.region || (!credentials.apiKey && (!credentials.accessKeyId || !credentials.secretAccessKey))) {
        setError("Для Bedrock укажите регион и либо bearer API key, либо пару AWS Access Key / Secret Key.");
        return;
      }
    } else if (protocol === "google-vertex") {
      credentials = {
        project: project.trim(),
        location: location.trim(),
        clientEmail: clientEmail.trim(),
        privateKey: privateKey.trim(),
      };
      if (!credentials.project || !credentials.location || !credentials.clientEmail || !credentials.privateKey) {
        setError("Для Vertex укажите project, location, client email и private key сервисного аккаунта.");
        return;
      }
    } else {
      if (!apiKey.trim()) return;
      credentials = { apiKey: apiKey.trim() };
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
      setError((cause as Error).message);
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
      setError((cause as Error).message);
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
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-border-soft bg-bg/20 p-3 @container">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[12px] font-medium text-foreground">Провайдеры</div>
          <p className="mt-0.5 text-[11px] leading-4 text-muted">Нативные транспорты OpenAI, Anthropic, Gemini, Bedrock и Vertex плюс неограниченные OpenAI-compatible профили. Учётные данные хранятся отдельно и не попадают в экспорт настроек.</p>
        </div>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void create()}>
          <Plus size={14} /> Добавить
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
                provider.id === config.activeProviderId ? "bg-elevated text-foreground" : "text-secondary hover:bg-(--ui-row-hover)",
              )}
            >
              <Server size={13} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{provider.name}</span>
              <span className="rounded bg-bg px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted">
                {provider.protocol.replace(/-/g, " ")}
              </span>
              {provider.hasKey ? <KeyRound size={12} className="text-success" /> : null}
              {provider.id === config.activeProviderId ? <Check size={12} className="text-primary" /> : null}
            </button>
          ))}
        </div>

        {selected ? (
          <div className="space-y-2 border-t border-border-soft pt-3 @[42rem]:border-l @[42rem]:border-t-0 @[42rem]:pl-3 @[42rem]:pt-0">
            <div className="grid gap-2 @[28rem]:grid-cols-2">
              <label className="space-y-1 text-[11px] text-muted">
                <span>Название</span>
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Мой провайдер" />
              </label>
              <label className="space-y-1 text-[11px] text-muted">
                <span>Транспорт</span>
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
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid gap-2 @[28rem]:grid-cols-2">
              <label className="space-y-1 text-[11px] text-muted">
                <span>Base URL</span>
                <Input value={baseURL} onChange={(event) => setBaseURL(event.target.value)} placeholder="https://api.example.com/v1" />
              </label>
            </div>
            <label className="block space-y-1 text-[11px] text-muted">
              <span>Модели — по одной на строку или через запятую</span>
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
              Учётные данные обязательны (выключите для локального Ollama/LM Studio или переменных окружения)
            </label>
            {protocol === "amazon-bedrock" ? (
              <div className="grid gap-2 rounded-md border border-border-soft bg-bg/30 p-2 @[28rem]:grid-cols-2">
                <label className="space-y-1 text-[11px] text-muted">
                  <span>AWS Region</span>
                  <Input value={region} onChange={(event) => setRegion(event.target.value)} placeholder={selected.hasKey ? "Enter stored region to replace access" : "us-east-1"} />
                </label>
                <label className="space-y-1 text-[11px] text-muted">
                  <span>AWS Access Key ID</span>
                  <Input value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} placeholder={selected.hasKey ? "Saved" : "AKIA…"} />
                </label>
                <label className="space-y-1 text-[11px] text-muted">
                  <span>AWS Secret Access Key</span>
                  <Input type="password" value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} placeholder={selected.hasKey ? "••••••••" : "Secret key"} />
                </label>
                <label className="space-y-1 text-[11px] text-muted">
                  <span>Session token (optional)</span>
                  <Input type="password" value={sessionToken} onChange={(event) => setSessionToken(event.target.value)} placeholder="Temporary session token" />
                </label>
              </div>
            ) : null}
            {protocol === "google-vertex" ? (
              <div className="grid gap-2 rounded-md border border-border-soft bg-bg/30 p-2 @[28rem]:grid-cols-2">
                <label className="space-y-1 text-[11px] text-muted">
                  <span>Google Cloud project</span>
                  <Input value={project} onChange={(event) => setProject(event.target.value)} placeholder="my-project" />
                </label>
                <label className="space-y-1 text-[11px] text-muted">
                  <span>Location</span>
                  <Input value={location} onChange={(event) => setLocation(event.target.value)} placeholder={selected.hasKey ? "Enter stored location to replace access" : "us-central1"} />
                </label>
                <label className="space-y-1 text-[11px] text-muted @[28rem]:col-span-2">
                  <span>Service account client email</span>
                  <Input value={clientEmail} onChange={(event) => setClientEmail(event.target.value)} placeholder="kyrei@project.iam.gserviceaccount.com" />
                </label>
                <label className="space-y-1 text-[11px] text-muted @[28rem]:col-span-2">
                  <span>Service account private key</span>
                  <textarea
                    value={privateKey}
                    onChange={(event) => setPrivateKey(event.target.value)}
                    rows={3}
                    placeholder={selected.hasKey ? "Credentials saved; paste a key only to replace them" : "-----BEGIN PRIVATE KEY-----"}
                    className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 font-mono text-[11px] text-foreground outline-none transition-colors placeholder:text-muted focus:border-primary"
                  />
                </label>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void save()}>Сохранить провайдер</Button>
              <div className="ml-auto flex items-center gap-1.5">
                {protocol !== "google-vertex" ? (
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={selected.hasKey ? "••••••••" : protocol === "amazon-bedrock" ? "Bearer key (optional)" : "API key"}
                    className="h-7 w-36 text-[11px]"
                  />
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || (!["amazon-bedrock", "google-vertex"].includes(protocol) && !apiKey.trim())}
                  onClick={() => void saveSecret()}
                >
                  {["amazon-bedrock", "google-vertex"].includes(protocol) ? "Доступ" : "Ключ"}
                </Button>
                {selected.hasKey && selected.requiresApiKey ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void clearSecret()}>Удалить доступ</Button> : null}
                {config.providers.length > 1 ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove()} className="text-danger hover:text-danger"><Trash2 size={13} /></Button> : null}
              </div>
            </div>
            {error ? <p className="text-[11px] text-danger">{error}</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
