import {
  Boxes,
  Check,
  KeyRound,
  LoaderCircle,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  Input,
  SearchField,
  Switch,
  Textarea,
} from "@/components/ui";
import { useI18n, type TranslationKey } from "@/i18n";
import { GatewayRequestError, gateway } from "@/lib/gateway";
import type {
  ProviderAccount,
  ProviderAccountPoolSnapshot,
  ProviderAccountPoolStrategy,
  ProviderAccountStatus,
  ProviderModel,
  ProviderProfile,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  createNewProviderAccountDraft,
  createProviderAccountDraft,
  PROVIDER_ACCOUNT_NAME_MAX_LENGTH,
  providerAccountCredentials,
  providerAccountHasCredentialInput,
  providerAccountInput,
  validateProviderAccountDraft,
  type ProviderAccountDraft,
} from "./provider-account-draft";

const ACCOUNT_ERRORS: Record<string, TranslationKey> = {
  provider_not_found: "settings.providers.error.notFound",
  provider_account_not_found: "settings.providers.accounts.error.notFound",
  provider_account_limit_reached: "settings.providers.accounts.error.limitReached",
  provider_account_id_conflict: "settings.providers.accounts.error.idConflict",
  provider_account_id_invalid: "settings.providers.accounts.error.idInvalid",
  provider_account_name_invalid: "settings.providers.accounts.error.nameRequired",
  provider_account_limits_invalid: "settings.providers.accounts.error.limitsInvalid",
  provider_account_models_invalid: "settings.providers.accounts.error.modelsInvalid",
  provider_pool_strategy_invalid: "settings.providers.accounts.error.strategyInvalid",
  provider_primary_account_required: "settings.providers.accounts.error.primaryRequired",
  provider_credentials_required: "settings.providers.error.credentialsRequired",
  provider_credentials_incomplete: "settings.providers.accounts.error.credentialsIncomplete",
  provider_discovery_unsupported: "settings.providers.discovery.unsupported",
  provider_discovery_unauthorized: "settings.providers.discovery.unauthorized",
  provider_discovery_rate_limited: "settings.providers.discovery.rateLimited",
  provider_discovery_redirect_blocked: "settings.providers.discovery.redirectBlocked",
  provider_discovery_target_blocked: "settings.providers.discovery.targetBlocked",
  provider_discovery_timeout: "settings.providers.discovery.timeout",
  provider_discovery_invalid_response: "settings.providers.discovery.invalidResponse",
  provider_discovery_response_too_large: "settings.providers.discovery.responseTooLarge",
  provider_discovery_benchmark_opt_in_required: "settings.providers.discovery.benchmarkOptInRequired",
  provider_discovery_unavailable: "settings.providers.discovery.failed",
  secret_storage_unavailable: "settings.providers.error.secretStorageUnavailable",
};

const STRATEGIES: readonly ProviderAccountPoolStrategy[] = ["balanced", "round-robin", "fill-first"];

function accountRequestError(reason: unknown): TranslationKey {
  if (reason instanceof GatewayRequestError && reason.code === "capability_unavailable") {
    return "settings.providers.gatewayUnavailable";
  }
  if (reason instanceof GatewayRequestError && reason.serverCode && ACCOUNT_ERRORS[reason.serverCode]) {
    return ACCOUNT_ERRORS[reason.serverCode];
  }
  return "settings.providers.error.operationFailed";
}

function slugAccountId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function resolvedStatus(account: ProviderAccount): ProviderAccountStatus {
  if (!account.enabled) return "disabled";
  if (account.status) return account.status;
  return account.ready === false ? "auth-required" : "ready";
}

function accountDiscoverySupported(provider: ProviderProfile): boolean {
  return provider.protocol === "openai-chat" || provider.protocol === "openai-responses";
}

interface ProviderAccountPoolDialogProps {
  provider: ProviderProfile | null;
  onClose: () => void;
  onEditPrimary: (provider: ProviderProfile) => void;
  onConfigChanged: () => void;
}

interface ModelAssignmentDraft {
  accountId: string;
  /** Missing means every current and future provider model; [] intentionally denies all. */
  modelIds?: string[];
}

export function ProviderAccountPoolDialog({
  provider,
  onClose,
  onEditPrimary,
  onConfigChanged,
}: ProviderAccountPoolDialogProps) {
  const { t, date } = useI18n();
  const titleId = useId();
  const [snapshot, setSnapshot] = useState<ProviderAccountPoolSnapshot | null>(null);
  const [poolDraft, setPoolDraft] = useState<ProviderAccountPoolSnapshot["pool"] | null>(null);
  const [accountDraft, setAccountDraft] = useState<ProviderAccountDraft | null>(null);
  const [modelAssignmentDraft, setModelAssignmentDraft] = useState<ModelAssignmentDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [discoveringId, setDiscoveringId] = useState<string | null>(null);
  const [discoveredCounts, setDiscoveredCounts] = useState<Record<string, number>>({});
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  const load = useCallback(async () => {
    if (!provider) return;
    setLoading(true);
    setErrorKey(null);
    try {
      const next = await gateway.getProviderAccounts(provider.id);
      setSnapshot(next);
      setPoolDraft(next.pool);
    } catch (reason) {
      setErrorKey(accountRequestError(reason));
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    setSnapshot(null);
    setPoolDraft(null);
    setAccountDraft(null);
    setModelAssignmentDraft(null);
    setDiscoveredCounts({});
    if (provider) void load();
  }, [load, provider]);

  if (!provider) return null;

  const applySnapshot = (next: ProviderAccountPoolSnapshot) => {
    setSnapshot(next);
    setPoolDraft(next.pool);
    onConfigChanged();
  };

  const poolChanged = Boolean(snapshot && poolDraft && (
    snapshot.pool.enabled !== poolDraft.enabled
    || snapshot.pool.strategy !== poolDraft.strategy
    || snapshot.pool.sessionAffinity !== poolDraft.sessionAffinity
  ));

  const savePool = async () => {
    if (!poolDraft) return;
    setBusy(true);
    setErrorKey(null);
    try {
      applySnapshot(await gateway.updateProviderAccountPool(provider.id, poolDraft));
    } catch (reason) {
      setErrorKey(accountRequestError(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAccount = async (draft: ProviderAccountDraft) => {
    const validationError = validateProviderAccountDraft(draft, provider.protocol, provider.requiresApiKey);
    if (validationError) {
      setErrorKey(validationError);
      return;
    }
    setBusy(true);
    setErrorKey(null);
    const credentials = providerAccountHasCredentialInput(draft)
      ? providerAccountCredentials(draft)
      : undefined;
    try {
      const input = providerAccountInput(draft);
      const next = draft.editingId
        ? await gateway.updateProviderAccount(provider.id, draft.editingId, input, credentials)
        : await gateway.createProviderAccount(provider.id, input, credentials);
      applySnapshot(next);
      setAccountDraft(null);
    } catch (reason) {
      setErrorKey(accountRequestError(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveModelAssignment = async (draft: ModelAssignmentDraft) => {
    setBusy(true);
    setErrorKey(null);
    try {
      const next = await gateway.updateProviderAccount(provider.id, draft.accountId, {
        modelIds: draft.modelIds === undefined ? null : draft.modelIds,
      });
      applySnapshot(next);
      setModelAssignmentDraft(null);
    } catch (reason) {
      setErrorKey(accountRequestError(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async (account: ProviderAccount) => {
    if (!window.confirm(t("settings.providers.accounts.deleteConfirm", { name: account.name }))) return;
    setBusy(true);
    setErrorKey(null);
    try {
      applySnapshot(await gateway.deleteProviderAccount(provider.id, account.id));
      if (accountDraft?.editingId === account.id) setAccountDraft(null);
      if (modelAssignmentDraft?.accountId === account.id) setModelAssignmentDraft(null);
    } catch (reason) {
      setErrorKey(accountRequestError(reason));
    } finally {
      setBusy(false);
    }
  };

  const discoverAccount = async (account: ProviderAccount) => {
    setDiscoveringId(account.id);
    setErrorKey(null);
    try {
      const result = await gateway.discoverProviderAccount(provider.id, account.id);
      setDiscoveredCounts((current) => ({ ...current, [account.id]: result.count }));
    } catch (reason) {
      setErrorKey(accountRequestError(reason));
    } finally {
      setDiscoveringId(null);
    }
  };

  const accounts = snapshot?.accounts ?? [];
  const canEnable = accounts.length > 1;
  const unavailable = loading || busy || discoveringId !== null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !unavailable) onClose(); }}>
      <DialogContent
        className="flex max-h-[min(calc(100dvh-var(--app-titlebar-h)-var(--app-statusbar-h)-2rem),48rem)] w-[min(95vw,54rem)] flex-col overflow-hidden border border-border p-0"
        showClose={!unavailable}
        aria-labelledby={titleId}
      >
        <DialogHeader className="mb-0 shrink-0 border-b border-border-soft px-5 py-4 pr-12">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-md border border-primary/25 bg-primary/8 text-primary">
              <Network className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <DialogTitle id={titleId}>{t("settings.providers.accounts.title", { name: provider.name })}</DialogTitle>
              <DialogDescription>{t("settings.providers.accounts.description")}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading && !snapshot ? (
            <div className="flex min-h-40 items-center justify-center gap-2 text-[11px] text-muted" role="status">
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              {t("settings.providers.accounts.loading")}
            </div>
          ) : !snapshot ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
              <p className="text-[11px] text-danger" role="alert">{errorKey ? t(errorKey) : t("settings.providers.error.operationFailed")}</p>
              <Button variant="secondary" size="sm" onClick={() => void load()}>
                <RefreshCw className="size-3.5" aria-hidden /> {t("common.retry")}
              </Button>
            </div>
          ) : (
            <div className="space-y-6">
              <section className="space-y-3" aria-labelledby={`${titleId}-routing`}>
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h3 id={`${titleId}-routing`} className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                      {t("settings.providers.accounts.routing")}
                    </h3>
                    <p className="mt-1 max-w-2xl text-[9.5px] leading-4 text-muted">{t("settings.providers.accounts.routingHint")}</p>
                  </div>
                  <Button variant="secondary" size="sm" disabled={unavailable || !poolChanged} onClick={() => void savePool()}>
                    {busy && poolChanged ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : null}
                    {t("settings.providers.accounts.saveRouting")}
                  </Button>
                </div>

                <div className="grid gap-px overflow-hidden rounded-md border border-border-soft bg-border-soft sm:grid-cols-3">
                  <label className="flex min-h-20 items-center justify-between gap-3 bg-bg px-3 py-2.5">
                    <span>
                      <span className="block text-[11px] font-medium text-secondary">{t("settings.providers.accounts.enabled")}</span>
                      <span className="mt-0.5 block text-[9.5px] leading-4 text-muted">
                        {t(canEnable ? "settings.providers.accounts.enabledHint" : "settings.providers.accounts.needsSecondAccount")}
                      </span>
                    </span>
                    <Switch
                      checked={poolDraft?.enabled === true}
                      disabled={unavailable || !canEnable}
                      onCheckedChange={(enabled) => setPoolDraft((current) => current ? { ...current, enabled } : current)}
                      aria-label={t("settings.providers.accounts.enabled")}
                    />
                  </label>

                  <label className="min-h-20 bg-bg px-3 py-2.5">
                    <span className="block text-[11px] font-medium text-secondary">{t("settings.providers.accounts.strategy")}</span>
                    <select
                      value={poolDraft?.strategy ?? "balanced"}
                      disabled={unavailable}
                      onChange={(event) => setPoolDraft((current) => current
                        ? { ...current, strategy: event.target.value as ProviderAccountPoolStrategy }
                        : current)}
                      className="mt-2 h-7 w-full rounded-md border border-border bg-surface px-2 text-[11px] text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/25"
                    >
                      {STRATEGIES.map((strategy) => (
                        <option key={strategy} value={strategy}>{t(`settings.providers.accounts.strategy.${strategy}`)}</option>
                      ))}
                    </select>
                    <span className="mt-1 block text-[9px] leading-3.5 text-muted">
                      {t(`settings.providers.accounts.strategyHint.${poolDraft?.strategy ?? "balanced"}`)}
                    </span>
                  </label>

                  <label className="flex min-h-20 items-center justify-between gap-3 bg-bg px-3 py-2.5">
                    <span>
                      <span className="block text-[11px] font-medium text-secondary">{t("settings.providers.accounts.affinity")}</span>
                      <span className="mt-0.5 block text-[9.5px] leading-4 text-muted">{t("settings.providers.accounts.affinityHint")}</span>
                    </span>
                    <Switch
                      checked={poolDraft?.sessionAffinity !== false}
                      disabled={unavailable}
                      onCheckedChange={(sessionAffinity) => setPoolDraft((current) => current ? { ...current, sessionAffinity } : current)}
                      aria-label={t("settings.providers.accounts.affinity")}
                    />
                  </label>
                </div>
              </section>

              <section className="space-y-3" aria-labelledby={`${titleId}-accounts`}>
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <h3 id={`${titleId}-accounts`} className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                      {t("settings.providers.accounts.list")}
                    </h3>
                    <p className="mt-1 text-[9.5px] leading-4 text-muted">{t("settings.providers.accounts.listHint")}</p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={unavailable || accountDraft !== null || modelAssignmentDraft !== null}
                    onClick={() => {
                      setErrorKey(null);
                      setModelAssignmentDraft(null);
                      setAccountDraft(createNewProviderAccountDraft());
                    }}
                  >
                    <Plus className="size-3.5" aria-hidden /> {t("settings.providers.accounts.add")}
                  </Button>
                </div>

                <div className="border-y border-border-soft">
                  {accounts.map((account, index) => {
                    const status = resolvedStatus(account);
                    const discoveryCount = discoveredCounts[account.id];
                    const isPrimary = account.primary === true || account.id === "primary";
                    const accountName = isPrimary
                      ? t("settings.providers.accounts.primaryName")
                      : account.name;
                    return (
                      <div key={account.id} className={cn("px-3 py-2.5", index > 0 && "border-t border-border-soft")}>
                        <div className="flex flex-wrap items-center gap-3">
                          <span className={cn(
                            "grid size-8 shrink-0 place-items-center rounded-md border border-border-soft bg-surface",
                            status === "ready" ? "text-success" : status === "cooldown" ? "text-warning" : "text-muted",
                          )}>
                            {status === "auth-required" ? <KeyRound className="size-3.5" aria-hidden /> : <Network className="size-3.5" aria-hidden />}
                          </span>
                          <div className="min-w-40 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-[12px] font-medium text-foreground">{accountName}</span>
                              {isPrimary ? (
                                <span className="rounded bg-elevated px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-wide text-muted">
                                  {t("settings.providers.accounts.primary")}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9px] text-muted">
                              <span>{account.id}</span>
                              <span className={cn(
                                status === "ready" && "text-success",
                                status === "cooldown" && "text-warning",
                                status === "auth-required" && "text-danger",
                              )}>
                                {t(`settings.providers.accounts.status.${status}`)}
                              </span>
                              {status === "cooldown" && account.cooldownUntil > Date.now() ? (
                                <span>{t("settings.providers.accounts.cooldownUntil", {
                                  time: date(account.cooldownUntil, { dateStyle: "short", timeStyle: "short" }),
                                })}</span>
                              ) : null}
                              {account.inflight > 0 ? <span>{t("settings.providers.accounts.inflight", { count: account.inflight })}</span> : null}
                              {discoveryCount !== undefined ? <span className="text-success" role="status" aria-live="polite">{t("settings.providers.accounts.modelsFound", { count: discoveryCount })}</span> : null}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              disabled={unavailable || accountDraft !== null}
                              aria-expanded={modelAssignmentDraft?.accountId === account.id}
                              aria-controls={`${titleId}-models-${account.id}`}
                              aria-label={t("settings.providers.accounts.models.manageNamed", { name: accountName })}
                              onClick={() => {
                                setErrorKey(null);
                                setAccountDraft(null);
                                setModelAssignmentDraft((current) => current?.accountId === account.id
                                  ? null
                                  : {
                                    accountId: account.id,
                                    ...(account.modelIds === undefined ? {} : { modelIds: [...account.modelIds] }),
                                  });
                              }}
                              className={cn(
                                "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[9.5px] font-medium transition-colors",
                                "border-border-soft bg-surface text-secondary hover:border-border hover:bg-elevated disabled:pointer-events-none disabled:opacity-45",
                                account.modelIds?.length === 0 && "border-danger/25 text-danger",
                                modelAssignmentDraft?.accountId === account.id && "border-primary/35 bg-primary/8 text-primary",
                              )}
                            >
                              <Boxes className="size-3" aria-hidden />
                              <ModelAssignmentBadge modelIds={account.modelIds} />
                            </button>
                            {isPrimary ? (
                              <Button variant="ghost" size="sm" disabled={unavailable || modelAssignmentDraft !== null} onClick={() => onEditPrimary(provider)}>
                                {t("settings.providers.accounts.editPrimary")}
                              </Button>
                            ) : (
                              <>
                                {accountDiscoverySupported(provider) && account.ready ? (
                                  <IconButton
                                    size="icon-sm"
                                    tip={t("settings.providers.accounts.discoverNamed", { name: accountName })}
                                    disabled={unavailable}
                                    onClick={() => void discoverAccount(account)}
                                  >
                                    {discoveringId === account.id
                                      ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                                      : <RefreshCw className="size-3.5" aria-hidden />}
                                  </IconButton>
                                ) : null}
                                <IconButton
                                  size="icon-sm"
                                  tip={t("settings.providers.accounts.editNamed", { name: accountName })}
                                  disabled={unavailable || accountDraft !== null || modelAssignmentDraft !== null}
                                  onClick={() => {
                                    setErrorKey(null);
                                    setModelAssignmentDraft(null);
                                    setAccountDraft(createProviderAccountDraft(account));
                                  }}
                                >
                                  <Pencil className="size-3.5" aria-hidden />
                                </IconButton>
                                <IconButton
                                  size="icon-sm"
                                  tip={t("settings.providers.accounts.deleteNamed", { name: accountName })}
                                  disabled={unavailable}
                                  onClick={() => void deleteAccount(account)}
                                  className="text-danger hover:text-danger"
                                >
                                  <Trash2 className="size-3.5" aria-hidden />
                                </IconButton>
                              </>
                            )}
                          </div>
                        </div>
                        {modelAssignmentDraft?.accountId === account.id ? (
                          <div id={`${titleId}-models-${account.id}`} className="mt-3 pl-11">
                            <ModelAssignmentEditor
                              models={provider.models}
                              modelIds={modelAssignmentDraft.modelIds}
                              disabled={unavailable}
                              onChange={(modelIds) => setModelAssignmentDraft((current) => current
                                ? { accountId: current.accountId, ...(modelIds === undefined ? {} : { modelIds }) }
                                : current)}
                              onCancel={() => { setErrorKey(null); setModelAssignmentDraft(null); }}
                              onSave={() => void saveModelAssignment(modelAssignmentDraft)}
                            />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>

              {accountDraft ? (
                <AccountEditor
                  provider={provider}
                  draft={accountDraft}
                  disabled={unavailable}
                  onChange={setAccountDraft}
                  onCancel={() => { setErrorKey(null); setAccountDraft(null); }}
                  onSave={() => void saveAccount(accountDraft)}
                />
              ) : null}

              <div className="min-h-4 text-[10.5px] text-danger" role="alert" aria-live="polite">
                {errorKey ? t(errorKey) : null}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="mt-0 shrink-0 border-t border-border-soft px-5 py-3">
          <p className="mr-auto max-w-lg text-[9px] leading-4 text-muted">{t("settings.providers.accounts.securityHint")}</p>
          <Button variant="ghost" disabled={unavailable} onClick={onClose}>{t("common.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModelAssignmentBadge({ modelIds }: { modelIds?: readonly string[] }) {
  const { t } = useI18n();
  if (modelIds === undefined) return <>{t("settings.providers.accounts.modelsBadge.all")}</>;
  if (modelIds.length === 0) return <>{t("settings.providers.accounts.modelsBadge.none")}</>;
  return <>{t("settings.providers.accounts.modelsBadge.count", { count: modelIds.length })}</>;
}

function ModelAssignmentEditor({
  models,
  modelIds,
  disabled,
  onChange,
  onCancel,
  onSave,
}: {
  models: readonly ProviderModel[];
  modelIds?: string[];
  disabled: boolean;
  onChange: (modelIds: string[] | undefined) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-3 rounded-md border border-border-soft bg-bg/40 p-3">
      <ModelSelector models={models} modelIds={modelIds} disabled={disabled} onChange={onChange} />
      <div className="flex justify-end gap-2 border-t border-border-soft pt-3">
        <Button variant="ghost" size="sm" disabled={disabled} onClick={onCancel}>{t("common.cancel")}</Button>
        <Button size="sm" disabled={disabled} onClick={onSave}>
          {disabled ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : null}
          {t("settings.providers.accounts.models.save")}
        </Button>
      </div>
    </div>
  );
}

function ModelSelector({
  models,
  modelIds,
  disabled,
  onChange,
}: {
  models: readonly ProviderModel[];
  modelIds?: string[];
  disabled: boolean;
  onChange: (modelIds: string[] | undefined) => void;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const uniqueModels = useMemo(() => {
    const seen = new Set<string>();
    return models.filter((model) => {
      if (!model.id || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
  }, [models]);
  const allModelIds = useMemo(() => uniqueModels.map((model) => model.id), [uniqueModels]);
  const selected = useMemo(
    () => new Set(modelIds === undefined ? allModelIds : modelIds),
    [allModelIds, modelIds],
  );
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredModels = useMemo(() => normalizedSearch
    ? uniqueModels.filter((model) => (
      model.id.toLocaleLowerCase().includes(normalizedSearch)
      || model.name?.toLocaleLowerCase().includes(normalizedSearch)
    ))
    : uniqueModels, [normalizedSearch, uniqueModels]);

  const toggleModel = (modelId: string) => {
    const nextSelected = new Set(selected);
    if (nextSelected.has(modelId)) nextSelected.delete(modelId);
    else nextSelected.add(modelId);
    const nextIds = allModelIds.filter((id) => nextSelected.has(id));
    onChange(nextIds.length === allModelIds.length ? undefined : nextIds);
  };

  return (
    <section className="space-y-3" aria-label={t("settings.providers.accounts.models.title")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            {t("settings.providers.accounts.models.title")}
          </h4>
          <p className="mt-1 max-w-2xl text-[9.5px] leading-4 text-muted">
            {t("settings.providers.accounts.models.hint")}
          </p>
        </div>
        <span className={cn(
          "rounded border border-border-soft bg-elevated px-2 py-1 text-[9px] font-semibold text-secondary",
          modelIds?.length === 0 && "border-danger/25 text-danger",
        )} aria-live="polite">
          <ModelAssignmentBadge modelIds={modelIds} />
        </span>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder={t("settings.providers.accounts.models.search")}
          aria-label={t("settings.providers.accounts.models.search")}
          className="min-w-0 flex-1"
        />
        <div className="flex shrink-0 gap-1.5">
          <Button variant="secondary" size="sm" disabled={disabled || modelIds === undefined} onClick={() => onChange(undefined)}>
            {t("settings.providers.accounts.models.selectAll")}
          </Button>
          <Button variant="ghost" size="sm" disabled={disabled || modelIds?.length === 0} onClick={() => onChange([])}>
            {t("settings.providers.accounts.models.clearAll")}
          </Button>
        </div>
      </div>

      <div className="max-h-48 overflow-y-auto rounded-md border border-border-soft bg-surface/45 p-1">
        {filteredModels.length > 0 ? filteredModels.map((model) => {
          const checked = selected.has(model.id);
          const modelName = model.name || model.id;
          return (
            <button
              key={model.id}
              type="button"
              role="checkbox"
              aria-checked={checked}
              aria-label={t("settings.providers.accounts.models.toggleNamed", { name: modelName })}
              disabled={disabled}
              onClick={() => toggleModel(model.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors",
                "hover:bg-(--ui-row-hover) disabled:pointer-events-none disabled:opacity-45",
                checked && "bg-primary/6",
              )}
            >
              <span className={cn(
                "grid size-4 shrink-0 place-items-center rounded border",
                checked ? "border-primary/55 bg-primary/12 text-primary" : "border-border text-transparent",
              )} aria-hidden>
                <Check className="size-3" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-medium text-secondary">{modelName}</span>
                {model.name && model.name !== model.id ? (
                  <span className="block truncate font-mono text-[8.5px] text-muted">{model.id}</span>
                ) : null}
              </span>
            </button>
          );
        }) : (
          <p className="px-3 py-5 text-center text-[10px] text-muted" role="status">
            {t(uniqueModels.length === 0
              ? "settings.providers.accounts.models.empty"
              : "settings.providers.accounts.models.noMatches")}
          </p>
        )}
      </div>
    </section>
  );
}

function AccountEditor({
  provider,
  draft,
  disabled,
  onChange,
  onCancel,
  onSave,
}: {
  provider: ProviderProfile;
  draft: ProviderAccountDraft;
  disabled: boolean;
  onChange: (draft: ProviderAccountDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const sectionId = useId();
  const update = (patch: Partial<ProviderAccountDraft>) => onChange({ ...draft, ...patch });
  const editing = Boolean(draft.editingId);

  return (
    <form
      className="space-y-4 rounded-md border border-border bg-bg/35 p-4"
      aria-labelledby={sectionId}
      onSubmit={(event) => { event.preventDefault(); onSave(); }}
    >
      <div>
        <h3 id={sectionId} className="text-[12px] font-semibold text-foreground">
          {t(editing ? "settings.providers.accounts.editTitle" : "settings.providers.accounts.addTitle")}
        </h3>
        <p className="mt-1 text-[9.5px] leading-4 text-muted">{t("settings.providers.accounts.editorHint")}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-[11px] text-secondary">{t("settings.providers.accounts.name")}</span>
          <Input
            autoFocus
            value={draft.name}
            disabled={disabled}
            onChange={(event) => {
              const name = event.target.value;
              const previousSlug = slugAccountId(draft.name);
              update({ name, ...(!editing && (!draft.id || draft.id === previousSlug) ? { id: slugAccountId(name) } : {}) });
            }}
            placeholder={t("settings.providers.accounts.namePlaceholder")}
            maxLength={PROVIDER_ACCOUNT_NAME_MAX_LENGTH}
          />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-secondary">{t("settings.providers.accounts.id")}</span>
          <Input
            value={draft.id}
            disabled={disabled || editing}
            onChange={(event) => update({ id: event.target.value.toLowerCase() })}
            placeholder={t("settings.providers.accounts.idPlaceholder")}
            spellCheck={false}
            className="font-mono"
          />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <NumberInput label={t("settings.providers.accounts.weight")} value={draft.weight} min={1} max={100} disabled={disabled} onChange={(weight) => update({ weight })} />
        <NumberInput label={t("settings.providers.accounts.priority")} value={draft.priority} min={0} max={10_000} disabled={disabled} onChange={(priority) => update({ priority })} />
        <NumberInput label={t("settings.providers.accounts.maxConcurrency")} value={draft.maxConcurrency} min={1} max={64} disabled={disabled} onChange={(maxConcurrency) => update({ maxConcurrency })} />
      </div>

      <label className="flex items-center justify-between gap-4 rounded-md border border-border-soft bg-surface/55 px-3 py-2">
        <span>
          <span className="block text-[11px] font-medium text-secondary">{t("settings.providers.accounts.accountEnabled")}</span>
          <span className="mt-0.5 block text-[9.5px] text-muted">{t("settings.providers.accounts.accountEnabledHint")}</span>
        </span>
        <Switch checked={draft.enabled} disabled={disabled} onCheckedChange={(enabled) => update({ enabled })} aria-label={t("settings.providers.accounts.accountEnabled")} />
      </label>

      <ModelSelector
        models={provider.models}
        modelIds={draft.modelIds}
        disabled={disabled}
        onChange={(modelIds) => update(modelIds === undefined ? { modelIds: undefined } : { modelIds })}
      />

      {provider.requiresApiKey ? (
        <section className="space-y-3" aria-label={t("settings.providers.dialog.credentials")}>
          <div>
            <h4 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{t("settings.providers.dialog.credentials")}</h4>
            <p className="mt-1 text-[9.5px] leading-4 text-muted">
              {t(draft.hasStoredCredentials ? "settings.providers.accounts.replaceCredentialsHint" : "settings.providers.keyPrivacyHint")}
            </p>
          </div>
          <AccountCredentialFields provider={provider} draft={draft} disabled={disabled} onChange={update} />
        </section>
      ) : (
        <p className="text-[9.5px] leading-4 text-muted">{t("settings.providers.accounts.noCredentialsHint")}</p>
      )}

      <div className="flex justify-end gap-2 border-t border-border-soft pt-3">
        <Button variant="ghost" disabled={disabled} onClick={onCancel}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={disabled}>
          {disabled ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : null}
          {t(editing ? "settings.providers.accounts.saveAccount" : "settings.providers.accounts.addAccount")}
        </Button>
      </div>
    </form>
  );
}

function AccountCredentialFields({
  provider,
  draft,
  disabled,
  onChange,
}: {
  provider: ProviderProfile;
  draft: ProviderAccountDraft;
  disabled: boolean;
  onChange: (patch: Partial<ProviderAccountDraft>) => void;
}) {
  const { t } = useI18n();
  const storedPlaceholder = draft.hasStoredCredentials ? t("settings.providers.keyStoredPlaceholder") : undefined;

  if (provider.protocol === "amazon-bedrock") {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <CredentialInput label={t("settings.providers.region")} value={draft.region ?? ""} disabled={disabled} onChange={(region) => onChange({ region })} placeholder="us-east-1" />
        <CredentialInput label={t("settings.providers.accessKeyId")} value={draft.accessKeyId ?? ""} disabled={disabled} onChange={(accessKeyId) => onChange({ accessKeyId })} />
        <CredentialInput secret label={t("settings.providers.secretAccessKey")} value={draft.secretAccessKey ?? ""} disabled={disabled} onChange={(secretAccessKey) => onChange({ secretAccessKey })} placeholder={storedPlaceholder} />
        <CredentialInput secret label={t("settings.providers.sessionToken")} value={draft.sessionToken ?? ""} disabled={disabled} onChange={(sessionToken) => onChange({ sessionToken })} />
        <CredentialInput secret label={t("settings.providers.bearerOptional")} value={draft.apiKey ?? ""} disabled={disabled} onChange={(apiKey) => onChange({ apiKey })} placeholder={storedPlaceholder} className="sm:col-span-2" />
      </div>
    );
  }

  if (provider.protocol === "google-vertex") {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <CredentialInput label={t("settings.providers.project")} value={draft.project ?? ""} disabled={disabled} onChange={(project) => onChange({ project })} />
        <CredentialInput label={t("settings.providers.location")} value={draft.location ?? ""} disabled={disabled} onChange={(location) => onChange({ location })} placeholder="us-central1" />
        <CredentialInput label={t("settings.providers.clientEmail")} value={draft.clientEmail ?? ""} disabled={disabled} onChange={(clientEmail) => onChange({ clientEmail })} className="sm:col-span-2" />
        <label className="space-y-1 sm:col-span-2">
          <span className="text-[11px] text-secondary">{t("settings.providers.privateKey")}</span>
          <Textarea
            value={draft.privateKey ?? ""}
            disabled={disabled}
            onChange={(event) => onChange({ privateKey: event.target.value })}
            autoComplete="new-password"
            spellCheck={false}
            placeholder={storedPlaceholder}
            className="min-h-20 font-mono text-[10.5px]"
          />
        </label>
      </div>
    );
  }

  return (
    <CredentialInput
      secret
      label={t("settings.providers.apiKey")}
      value={draft.apiKey ?? ""}
      disabled={disabled}
      onChange={(apiKey) => onChange({ apiKey })}
      placeholder={storedPlaceholder ?? t("settings.providers.apiKeyPlaceholder")}
    />
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

function NumberInput({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="space-y-1">
      <span className="text-[11px] text-secondary">{label}</span>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="font-mono"
      />
    </label>
  );
}
