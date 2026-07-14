import { LoaderCircle, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Switch,
  Textarea,
} from "@/components/ui";
import { GatewayRequestError } from "@/lib/gateway";
import { desktopRuntime } from "@/lib/desktop";
import type { ProviderModel, ProviderProtocol } from "@/lib/types";
import { useI18n, type TranslationKey } from "@/i18n";
import { cn } from "@/lib/utils";
import { ModelDiscovery } from "./ModelDiscovery";
import { secretStorageGuidanceFor } from "./secret-storage-guidance";
import {
  consumeBenchmarkNetworkPermission,
  mergeDiscoveredModels,
  providerSupportsModelDiscovery,
  updateProviderDraftEndpoint,
  type ProviderDraft,
} from "./provider-draft";

const PROTOCOLS: readonly { value: ProviderProtocol; label: TranslationKey }[] = [
  { value: "openai-chat", label: "settings.providers.protocol.openaiChat" },
  { value: "openai-responses", label: "settings.providers.protocol.openaiResponses" },
  { value: "anthropic-messages", label: "settings.providers.protocol.anthropic" },
  { value: "google-generative-ai", label: "settings.providers.protocol.google" },
  { value: "amazon-bedrock", label: "settings.providers.protocol.bedrock" },
  { value: "google-vertex", label: "settings.providers.protocol.vertex" },
];

const DISCOVERY_ERRORS: Record<string, TranslationKey> = {
  provider_credentials_required: "settings.providers.error.credentialsRequired",
  provider_base_url_invalid: "settings.providers.error.baseUrlInvalid",
  provider_discovery_unsupported: "settings.providers.discovery.unsupported",
  provider_discovery_unauthorized: "settings.providers.discovery.unauthorized",
  provider_discovery_rate_limited: "settings.providers.discovery.rateLimited",
  provider_discovery_redirect_blocked: "settings.providers.discovery.redirectBlocked",
  provider_discovery_target_blocked: "settings.providers.discovery.targetBlocked",
  provider_discovery_benchmark_opt_in_required: "settings.providers.discovery.benchmarkOptInRequired",
  provider_discovery_timeout: "settings.providers.discovery.timeout",
  provider_discovery_invalid_response: "settings.providers.discovery.invalidResponse",
  provider_discovery_response_too_large: "settings.providers.discovery.responseTooLarge",
  provider_discovery_unavailable: "settings.providers.discovery.failed",
};

function discoveryErrorKey(reason: unknown): TranslationKey {
  if (reason instanceof GatewayRequestError && reason.serverCode && DISCOVERY_ERRORS[reason.serverCode]) {
    return DISCOVERY_ERRORS[reason.serverCode];
  }
  return "settings.providers.discovery.failed";
}

function canUseBenchmarkNetwork(draft: ProviderDraft): boolean {
  if (draft.protocol !== "openai-chat" && draft.protocol !== "openai-responses") return false;
  try {
    const url = new URL(draft.baseURL.trim());
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return url.protocol === "https:" && host.includes(".") && !host.includes(":") && !/^\d+(?:\.\d+){3}$/.test(host);
  } catch {
    return false;
  }
}

interface ProviderSetupDialogProps {
  draft: ProviderDraft | null;
  saving: boolean;
  errorKey?: TranslationKey | null;
  onDraftChange: (draft: ProviderDraft) => void;
  onDiscover: (draft: ProviderDraft) => Promise<ProviderModel[]>;
  onCancel: () => void;
  onSave: (draft: ProviderDraft) => void;
  onClearCredentials?: (draft: ProviderDraft) => void;
  onDelete?: (draft: ProviderDraft) => void;
}

export function ProviderSetupDialog({
  draft,
  saving,
  errorKey,
  onDraftChange,
  onDiscover,
  onCancel,
  onSave,
  onClearCredentials,
  onDelete,
}: ProviderSetupDialogProps) {
  const { t } = useI18n();
  const formId = useId();
  const [discovering, setDiscovering] = useState(false);
  const [discoveryStatus, setDiscoveryStatus] = useState<{ kind: "idle" | "success" | "error"; count?: number; errorKey?: TranslationKey }>({ kind: "idle" });

  useEffect(() => {
    setDiscovering(false);
    setDiscoveryStatus({ kind: "idle" });
  }, [draft?.editingId, draft?.templateId]);

  if (!draft) return null;
  const update = (patch: Partial<ProviderDraft>) => onDraftChange({ ...draft, ...patch });
  const runDiscovery = async () => {
    setDiscovering(true);
    setDiscoveryStatus({ kind: "idle" });
    try {
      const models = await onDiscover(draft);
      onDraftChange(consumeBenchmarkNetworkPermission(mergeDiscoveredModels(draft, models)));
      setDiscoveryStatus({ kind: "success", count: models.length });
    } catch (reason) {
      onDraftChange(consumeBenchmarkNetworkPermission(draft));
      setDiscoveryStatus({ kind: "error", errorKey: discoveryErrorKey(reason) });
    } finally {
      setDiscovering(false);
    }
  };

  const unavailable = saving || discovering;
  const editing = Boolean(draft.editingId);
  const benchmarkNetworkAvailable = canUseBenchmarkNetwork(draft);
  const discoverySupported = providerSupportsModelDiscovery(draft.protocol);
  const storageUnavailable = errorKey === "settings.providers.error.secretStorageUnavailable";
  const desktopPlatform = desktopRuntime.platform();
  const secretStorageGuidance = secretStorageGuidanceFor(desktopPlatform);

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !unavailable) onCancel(); }}>
      <DialogContent className="flex max-h-[min(calc(100dvh-var(--app-titlebar-h)-var(--app-statusbar-h)-2rem),46rem)] w-[min(94vw,46rem)] flex-col overflow-hidden border border-border p-0" showClose={!unavailable}>
        <DialogHeader className="mb-0 shrink-0 border-b border-border-soft px-5 py-4 pr-12">
          <DialogTitle>{editing ? t("settings.providers.dialog.editTitle") : t("settings.providers.dialog.addTitle")}</DialogTitle>
          <DialogDescription>{t("settings.providers.dialog.description")}</DialogDescription>
        </DialogHeader>

        <form id={formId} className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 pt-4" onSubmit={(event) => { event.preventDefault(); onSave(draft); }}>
          <div className="space-y-5">
            <section className="space-y-3" aria-labelledby={`${formId}-identity`}>
              <h3 id={`${formId}-identity`} className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{t("settings.providers.dialog.identity")}</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-[11px] text-secondary">{t("settings.providers.name")}</span>
                  <Input autoFocus value={draft.name} disabled={unavailable} onChange={(event) => update({ name: event.target.value })} placeholder={t("settings.providers.namePlaceholder")} />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-secondary">{t("settings.providers.id")}</span>
                  <Input
                    value={draft.id}
                    disabled={unavailable || draft.idLocked}
                    onChange={(event) => update({ id: event.target.value.toLowerCase() })}
                    placeholder={t("settings.providers.idPlaceholder")}
                    spellCheck={false}
                    className="font-mono"
                  />
                  <span className="block text-[9.5px] leading-4 text-muted">{draft.idLocked ? t("settings.providers.idLockedHint") : t("settings.providers.idHint")}</span>
                </label>
              </div>
              <div className="grid gap-3 sm:grid-cols-[13rem_minmax(0,1fr)]">
                <label className="space-y-1">
                  <span className="text-[11px] text-secondary">{t("settings.providers.transport")}</span>
                  <select
                    value={draft.protocol}
                    disabled={unavailable}
                    onChange={(event) => {
                      const protocol = event.target.value as ProviderProtocol;
                      onDraftChange(updateProviderDraftEndpoint(draft, {
                        protocol,
                        ...(protocol !== draft.protocol ? { hasStoredCredentials: false } : {}),
                      }));
                    }}
                    className="h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[12px] text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/25"
                  >
                    {PROTOCOLS.map((protocol) => <option key={protocol.value} value={protocol.value}>{t(protocol.label)}</option>)}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-secondary">{t("settings.providers.baseUrl")}</span>
                  <Input value={draft.baseURL} disabled={unavailable} onChange={(event) => onDraftChange(updateProviderDraftEndpoint(draft, { baseURL: event.target.value }))} placeholder={t("settings.providers.baseUrlPlaceholder")} spellCheck={false} />
                </label>
              </div>
              <label className="flex items-center justify-between gap-4 rounded-md border border-border-soft bg-bg/25 px-3 py-2">
                <span>
                  <span className="block text-[11px] font-medium text-secondary">{t("settings.providers.requiresCredentialsShort")}</span>
                  <span className="mt-0.5 block text-[9.5px] text-muted">{t("settings.providers.requiresCredentialsHint")}</span>
                </span>
                <Switch checked={draft.requiresApiKey} disabled={unavailable} onCheckedChange={(value) => update({ requiresApiKey: value })} aria-label={t("settings.providers.requiresCredentialsShort")} />
              </label>
              {benchmarkNetworkAvailable ? (
                <label className="flex items-center justify-between gap-4 rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
                  <span>
                    <span className="block text-[11px] font-medium text-secondary">{t("settings.providers.discovery.allowBenchmarkNetwork")}</span>
                    <span className="mt-0.5 block text-[9.5px] leading-4 text-muted">{t("settings.providers.discovery.allowBenchmarkNetworkHint")}</span>
                  </span>
                  <Switch checked={draft.allowBenchmarkNetwork} disabled={unavailable} onCheckedChange={(allowBenchmarkNetwork) => update({ allowBenchmarkNetwork })} aria-label={t("settings.providers.discovery.allowBenchmarkNetwork")} />
                </label>
              ) : null}
            </section>

            {draft.requiresApiKey ? (
              <section className="space-y-3" aria-labelledby={`${formId}-credentials`}>
                <h3 id={`${formId}-credentials`} className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{t("settings.providers.dialog.credentials")}</h3>
                {draft.protocol === "amazon-bedrock" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <CredentialInput label={t("settings.providers.region")} value={draft.region} disabled={unavailable} onChange={(region) => update({ region })} placeholder="us-east-1" />
                    <CredentialInput label={t("settings.providers.accessKeyId")} value={draft.accessKeyId} disabled={unavailable} onChange={(accessKeyId) => update({ accessKeyId })} />
                    <CredentialInput secret label={t("settings.providers.secretAccessKey")} value={draft.secretAccessKey} disabled={unavailable} onChange={(secretAccessKey) => update({ secretAccessKey })} />
                    <CredentialInput secret label={t("settings.providers.sessionToken")} value={draft.sessionToken} disabled={unavailable} onChange={(sessionToken) => update({ sessionToken })} />
                    <CredentialInput secret label={t("settings.providers.bearerOptional")} value={draft.apiKey} disabled={unavailable} onChange={(apiKey) => update({ apiKey })} className="sm:col-span-2" />
                  </div>
                ) : draft.protocol === "google-vertex" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <CredentialInput label={t("settings.providers.project")} value={draft.project} disabled={unavailable} onChange={(project) => update({ project })} />
                    <CredentialInput label={t("settings.providers.location")} value={draft.location} disabled={unavailable} onChange={(location) => update({ location })} placeholder="us-central1" />
                    <CredentialInput label={t("settings.providers.clientEmail")} value={draft.clientEmail} disabled={unavailable} onChange={(clientEmail) => update({ clientEmail })} className="sm:col-span-2" />
                    <label className="space-y-1 sm:col-span-2">
                      <span className="text-[11px] text-secondary">{t("settings.providers.privateKey")}</span>
                      <Textarea value={draft.privateKey} disabled={unavailable} onChange={(event) => update({ privateKey: event.target.value })} autoComplete="new-password" spellCheck={false} className="min-h-20 font-mono text-[10.5px]" />
                    </label>
                  </div>
                ) : (
                  <CredentialInput
                    secret
                    label={t("settings.providers.apiKey")}
                    value={draft.apiKey}
                    disabled={unavailable}
                    onChange={(apiKey) => update({ apiKey })}
                    placeholder={draft.hasStoredCredentials ? t("settings.providers.keyStoredPlaceholder") : t("settings.providers.apiKeyPlaceholder")}
                  />
                )}
                <p className="text-[9.5px] leading-4 text-muted">{draft.hasStoredCredentials ? t("settings.providers.keyStoredHint") : t("settings.providers.keyPrivacyHint")}</p>
                {storageUnavailable ? (
                  <div className="rounded-md border border-danger/35 bg-danger/8 px-3 py-3" role="alert" aria-live="assertive">
                    <div className="flex items-start gap-2.5">
                      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold text-danger">{t("settings.providers.error.secretStorageTitle")}</p>
                        <p className="mt-1 text-[10px] leading-4 text-secondary">{t("settings.providers.error.secretStorageExplanation")}</p>
                        <ol className="mt-2 list-decimal space-y-1 pl-4 text-[10px] leading-4 text-secondary">
                          <li>{t(secretStorageGuidance.step1)}</li>
                          <li>{t(secretStorageGuidance.step2)}</li>
                        </ol>
                        {desktopPlatform === "linux" ? (
                          <code className="mt-2 block w-fit rounded border border-border-soft bg-bg/45 px-2 py-1 font-mono text-[9.5px] text-primary">
                            {t("settings.providers.error.secretStorageLinuxArchCommand")}
                          </code>
                        ) : null}
                        <p className="mt-2 text-[9.5px] leading-4 text-muted">{t("settings.providers.error.secretStorageNotSaved")}</p>
                      </div>
                    </div>
                  </div>
                ) : null}
                {editing && draft.hasStoredCredentials && onClearCredentials ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-soft bg-bg/25 px-3 py-2">
                    <span className="max-w-md text-[9.5px] leading-4 text-muted">{t("settings.providers.clearCredentialsHint")}</span>
                    <Button variant="ghost" size="sm" disabled={unavailable} onClick={() => onClearCredentials(draft)} className="text-danger hover:text-danger">
                      <Trash2 className="size-3.5" aria-hidden /> {t("settings.providers.clearCredentials")}
                    </Button>
                  </div>
                ) : null}
              </section>
            ) : null}

            <section className="space-y-3" aria-labelledby={`${formId}-models`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 id={`${formId}-models`} className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{t("settings.providers.dialog.models")}</h3>
                  <p className="mt-1 text-[9.5px] text-muted">
                    {t(discoverySupported ? "settings.providers.discovery.hint" : "settings.providers.discovery.unsupported")}
                  </p>
                </div>
                <Button variant="secondary" size="sm" disabled={unavailable || !draft.baseURL.trim() || !discoverySupported} onClick={() => void runDiscovery()}>
                  {discovering ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
                  {discovering ? t("settings.providers.discovery.loading") : t("settings.providers.discovery.action")}
                </Button>
              </div>
              <div className={cn("min-h-4 text-[10.5px]", discoveryStatus.kind === "error" ? "text-danger" : "text-success")} role="status" aria-live="polite" aria-atomic="true">
                {discovering ? t("settings.providers.discovery.loading") : null}
                {!discovering && discoveryStatus.kind === "success" ? t("settings.providers.discovery.found", { count: discoveryStatus.count ?? 0 }) : null}
                {!discovering && discoveryStatus.kind === "error" && discoveryStatus.errorKey ? t(discoveryStatus.errorKey) : null}
              </div>
              <ModelDiscovery
                models={draft.availableModels}
                selectedIds={draft.selectedModelIds}
                manualModel={draft.manualModel}
                disabled={unavailable}
                onSelectedIdsChange={(selectedModelIds) => update({ selectedModelIds })}
                onManualModelChange={(manualModel) => update({ manualModel })}
              />
            </section>

            <label className="flex items-center justify-between gap-4 rounded-md border border-border-soft bg-bg/25 px-3 py-2">
              <span>
                <span className="block text-[11px] font-medium text-secondary">{t("settings.providers.useAsDefault")}</span>
                <span className="mt-0.5 block text-[9.5px] text-muted">{t("settings.providers.useAsDefaultHint")}</span>
              </span>
              <Switch checked={draft.useAsDefault} disabled={unavailable} onCheckedChange={(useAsDefault) => update({ useAsDefault })} aria-label={t("settings.providers.useAsDefault")} />
            </label>

            <div className="min-h-4 text-[10.5px] text-danger" role="alert">
              {errorKey && !storageUnavailable ? t(errorKey) : null}
            </div>
          </div>
        </form>

        <DialogFooter className="mt-0 shrink-0 border-t border-border-soft px-5 py-3">
          {editing && onDelete ? (
            <Button variant="ghost" size="sm" disabled={unavailable} onClick={() => onDelete(draft)} className="mr-auto text-danger hover:text-danger">
              <Trash2 className="size-3.5" aria-hidden /> {t("settings.providers.delete")}
            </Button>
          ) : null}
          <Button variant="ghost" disabled={unavailable} onClick={onCancel}>{t("common.cancel")}</Button>
          <Button form={formId} type="submit" disabled={unavailable}>
            {saving ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : null}
            {editing ? t("settings.providers.save") : t("settings.providers.addProvider")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CredentialInput({
  label,
  value,
  onChange,
  disabled,
  secret,
  placeholder,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  secret?: boolean;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={cn("space-y-1", className)}>
      <span className="text-[11px] text-secondary">{label}</span>
      <Input
        type={secret ? "password" : "text"}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={secret ? "new-password" : "off"}
        spellCheck={false}
      />
    </label>
  );
}
