import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui";
import { useI18n, type TranslationKey } from "@/i18n";
import { GatewayRequestError, gateway } from "@/lib/gateway";
import type {
  AppConfig,
  ProviderModel,
  ProviderProfile,
  ProviderTemplate,
} from "@/lib/types";
import { KiroCliConnectorCard } from "./KiroCliConnectorCard";
import { CodexChatgptConnectorCard } from "./CodexChatgptConnectorCard";
import { CodexChatgptPoolCard } from "./CodexChatgptPoolCard";
import { KiroOrganizationPoolCard } from "./KiroOrganizationPoolCard";
import { ProviderCatalog } from "./ProviderCatalog";
import { ProviderAccountPoolDialog } from "./ProviderAccountPoolDialog";
import { ProviderSetupDialog } from "./ProviderSetupDialog";
import {
  canUseStoredCredentialsForDiscovery,
  createDraftFromProfile,
  createDraftFromTemplate,
  draftDiscoveryInput,
  draftProviderInput,
  orderedProviderTemplates,
  providerDraftCredentials,
  providerDraftHasCredentialInput,
  providerDraftModels,
  shouldDefaultUseAsDefault,
  type ProviderDraft,
} from "./provider-draft";
import { validateProviderCredentials } from "../provider-validation";

interface ProvidersSettingsProps {
  config: AppConfig;
  onSaved: (config: AppConfig) => void;
}

const SERVER_ERRORS: Record<string, TranslationKey> = {
  provider_not_found: "settings.providers.error.notFound",
  provider_unavailable: "settings.providers.error.unavailable",
  provider_final_profile: "settings.providers.error.finalProfile",
  provider_credentials_required: "settings.providers.error.credentialsRequired",
  provider_credentials_incomplete: "settings.providers.error.credentialsIncomplete",
  provider_operation_failed: "settings.providers.error.operationFailed",
  provider_id_invalid: "settings.providers.error.idInvalid",
  provider_id_conflict: "settings.providers.error.idExists",
  provider_name_invalid: "settings.providers.error.nameRequired",
  provider_protocol_invalid: "settings.providers.error.protocolInvalid",
  provider_model_invalid: "settings.providers.error.modelInvalid",
  provider_id_immutable: "settings.providers.error.idImmutable",
  provider_base_url_invalid: "settings.providers.error.baseUrlInvalid",
  provider_models_required: "settings.providers.error.modelRequired",
  secret_storage_unavailable: "settings.providers.error.secretStorageUnavailable",
};

function requestErrorKey(reason: unknown): TranslationKey {
  if (reason instanceof GatewayRequestError && reason.code === "capability_unavailable") return "settings.providers.gatewayUnavailable";
  if (reason instanceof GatewayRequestError && reason.serverCode && SERVER_ERRORS[reason.serverCode]) return SERVER_ERRORS[reason.serverCode];
  return "settings.providers.error.operationFailed";
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function ProvidersSettings({ config, onSaved }: ProvidersSettingsProps) {
  const { t } = useI18n();
  const [templates, setTemplates] = useState<ProviderTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [templateError, setTemplateError] = useState(false);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [accountPoolProvider, setAccountPoolProvider] = useState<ProviderProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  const loadTemplates = useCallback(() => {
    setLoadingTemplates(true);
    setTemplateError(false);
    gateway.getProviderTemplates()
      .then((result) => setTemplates(orderedProviderTemplates(result.templates)))
      .catch(() => {
        setTemplateError(true);
        setTemplates([{ id: "custom", name: t("settings.providers.custom"), custom: true }]);
      })
      .finally(() => setLoadingTemplates(false));
  }, [t]);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const activate = async (provider: ProviderProfile) => {
    const modelId = provider.models[0]?.id;
    if (!modelId) return;
    setSaving(true);
    try {
      onSaved(await gateway.setConfig({ activeProviderId: provider.id, activeModelId: modelId }));
    } catch (reason) {
      setErrorKey(requestErrorKey(reason));
    } finally {
      setSaving(false);
    }
  };

  const discover = async (current: ProviderDraft): Promise<ProviderModel[]> => {
    const original = current.editingId ? config.providers.find((provider) => provider.id === current.editingId) : undefined;
    const unchangedSavedProfile = original && canUseStoredCredentialsForDiscovery(original, current);
    const result = unchangedSavedProfile
      ? await gateway.discoverSavedProvider(original.id)
      : await gateway.discoverProvider(
        draftDiscoveryInput(current),
        providerDraftHasCredentialInput(current) ? providerDraftCredentials(current) : undefined,
      );
    return result.models;
  };

  const canKeepStoredCredentials = (current: ProviderDraft): boolean => {
    if (!current.editingId || !current.hasStoredCredentials || providerDraftHasCredentialInput(current)) return false;
    const original = config.providers.find((provider) => provider.id === current.editingId);
    if (!original || original.protocol !== current.protocol || original.requiresApiKey !== current.requiresApiKey) return false;
    try {
      return new URL(original.baseURL).origin === new URL(current.baseURL.trim()).origin;
    } catch {
      return false;
    }
  };

  const validate = (current: ProviderDraft): TranslationKey | null => {
    if (!current.name.trim()) return "settings.providers.error.nameRequired";
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(current.id.trim())) return "settings.providers.error.idInvalid";
    if (!isValidHttpUrl(current.baseURL.trim())) return "settings.providers.error.baseUrlInvalid";
    if (providerDraftModels(current).length === 0) return "settings.providers.error.modelRequired";
    if (!current.requiresApiKey || canKeepStoredCredentials(current)) return null;
    const result = validateProviderCredentials(current.protocol, providerDraftCredentials(current));
    return result.ok ? null : result.code;
  };

  const save = async (current: ProviderDraft) => {
    const validationError = validate(current);
    if (validationError) {
      setErrorKey(validationError);
      return;
    }
    setSaving(true);
    setErrorKey(null);
    try {
      const input = draftProviderInput(current);
      const credentials = current.requiresApiKey && !canKeepStoredCredentials(current)
        ? providerDraftCredentials(current)
        : undefined;
      const options = { credentials, useAsDefault: current.useAsDefault };
      const next = current.editingId
        ? await gateway.updateProvider(current.editingId, input, options)
        : await gateway.createProvider(input, options);
      onSaved(next);
      setDraft(null);
    } catch (reason) {
      setErrorKey(requestErrorKey(reason));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (current: ProviderDraft) => {
    if (!current.editingId || !window.confirm(t("settings.providers.deleteConfirm", { name: current.name }))) return;
    setSaving(true);
    setErrorKey(null);
    try {
      onSaved(await gateway.deleteProvider(current.editingId));
      setDraft(null);
    } catch (reason) {
      setErrorKey(requestErrorKey(reason));
    } finally {
      setSaving(false);
    }
  };

  const clearCredentials = async (current: ProviderDraft) => {
    if (!current.editingId || !window.confirm(t("settings.providers.clearCredentialsConfirm", { name: current.name }))) return;
    setSaving(true);
    setErrorKey(null);
    try {
      onSaved(await gateway.clearProviderSecret(current.editingId));
      setDraft({
        ...current,
        hasStoredCredentials: false,
        apiKey: "",
        accessKeyId: "",
        secretAccessKey: "",
        sessionToken: "",
        clientEmail: "",
        privateKey: "",
      });
    } catch (reason) {
      setErrorKey(requestErrorKey(reason));
    } finally {
      setSaving(false);
    }
  };

  const resetRuntime = async (current: ProviderDraft) => {
    if (!current.editingId) return;
    setSaving(true);
    setErrorKey(null);
    try {
      await gateway.resetProviderRuntime(current.editingId);
      onSaved(await gateway.getConfig());
    } catch (reason) {
      setErrorKey(requestErrorKey(reason));
    } finally {
      setSaving(false);
    }
  };

  const refreshConfig = () => {
    void gateway.getConfig().then(onSaved).catch(() => setErrorKey("settings.providers.error.operationFailed"));
  };

  return (
    <div className="space-y-6">
      <header className="max-w-3xl">
        <h2 className="text-[14px] font-semibold text-foreground">{t("settings.providers.pageTitle")}</h2>
        <p className="mt-1 text-[11px] leading-5 text-muted">{t("settings.providers.pageDescription")}</p>
      </header>

      <CodexChatgptConnectorCard onActivated={onSaved} />

      <CodexChatgptPoolCard onActivated={onSaved} />

      <KiroCliConnectorCard />

      <KiroOrganizationPoolCard />

      {templateError ? (
        <div className="flex items-center justify-between gap-3 border-y border-warning/25 py-2 text-[11px] text-warning" role="status">
          <span>{t("settings.providers.templatesUnavailable")}</span>
          <Button variant="ghost" size="sm" onClick={loadTemplates}><RefreshCw className="size-3.5" aria-hidden />{t("common.retry")}</Button>
        </div>
      ) : null}

      {loadingTemplates && templates.length === 0 ? (
        <p className="py-8 text-center text-[11px] text-muted" role="status">{t("settings.providers.loadingTemplates")}</p>
      ) : (
        <ProviderCatalog
          configured={config.providers}
          templates={templates}
          activeProviderId={config.activeProviderId}
          busy={saving}
          onConfigure={(provider) => {
            setErrorKey(null);
            setDraft(createDraftFromProfile(provider, shouldDefaultUseAsDefault(config.providers)));
          }}
          onManageAccounts={(provider) => { setErrorKey(null); setAccountPoolProvider(provider); }}
          onConfigureTemplate={(template) => {
            setErrorKey(null);
            setDraft(createDraftFromTemplate(template, shouldDefaultUseAsDefault(config.providers)));
          }}
          onUseDefault={(provider) => void activate(provider)}
        />
      )}

      <ProviderSetupDialog
        draft={draft}
        saving={saving}
        errorKey={errorKey}
        onDraftChange={setDraft}
        onDiscover={discover}
        onCancel={() => { setErrorKey(null); setDraft(null); }}
        onSave={(current) => void save(current)}
        onClearCredentials={(current) => void clearCredentials(current)}
        onResetRuntime={(current) => void resetRuntime(current)}
        onDelete={config.providers.length > 1 ? (current) => void remove(current) : undefined}
      />

      <ProviderAccountPoolDialog
        provider={accountPoolProvider}
        onClose={() => setAccountPoolProvider(null)}
        onEditPrimary={(provider) => {
          setAccountPoolProvider(null);
          setErrorKey(null);
          setDraft(createDraftFromProfile(provider, shouldDefaultUseAsDefault(config.providers)));
        }}
        onConfigChanged={refreshConfig}
      />
    </div>
  );
}
