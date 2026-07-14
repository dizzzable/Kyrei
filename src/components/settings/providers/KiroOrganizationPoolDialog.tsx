import {
  Ban,
  CheckCircle2,
  CircleAlert,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  SegmentedControl,
  Switch,
} from "@/components/ui";
import { useI18n, type TranslationKey } from "@/i18n";
import { GatewayRequestError, gateway } from "@/lib/gateway";
import type {
  KiroOrganizationAccountSummary,
  KiroOrganizationModel,
  KiroOrganizationPoolSnapshot,
} from "@/lib/kiro-organization-types";
import type { ProviderAccountPoolStrategy } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  createKiroOrganizationAccountDraft,
  createNewKiroOrganizationAccountDraft,
  kiroOrganizationAccountInput,
  kiroOrganizationCredentialInput,
  parseKiroOrganizationPolicyIds,
  slugKiroOrganizationAccountId,
  validateKiroOrganizationAccountDraft,
  type KiroOrganizationAccountDraft,
  type KiroOrganizationPolicyMode,
} from "./kiro-organization-draft";

const STRATEGIES: readonly ProviderAccountPoolStrategy[] = ["balanced", "round-robin", "fill-first"];

const SERVER_ERRORS: Readonly<Record<string, TranslationKey>> = {
  kiro_organization_protected_storage_required: "settings.providers.kiroOrganization.error.storageRequired",
  kiro_organization_account_not_found: "settings.providers.kiroOrganization.error.notFound",
  kiro_organization_account_conflict: "settings.providers.kiroOrganization.error.conflict",
  kiro_organization_generation_conflict: "settings.providers.kiroOrganization.error.conflict",
  kiro_organization_revision_conflict: "settings.providers.kiroOrganization.error.conflict",
  kiro_organization_credential_required: "settings.providers.kiroOrganization.error.credentialRequired",
  kiro_organization_verification_failed: "settings.providers.kiroOrganization.error.verificationFailed",
  kiro_organization_cli_not_found: "settings.providers.kiroOrganization.error.cliUnavailable",
  kiro_organization_cli_version_unsupported: "settings.providers.kiroOrganization.error.cliUnavailable",
};

export function kiroOrganizationErrorKey(reason: unknown): TranslationKey {
  if (reason instanceof GatewayRequestError && reason.serverCode && SERVER_ERRORS[reason.serverCode]) {
    return SERVER_ERRORS[reason.serverCode];
  }
  return "settings.providers.kiroOrganization.error.operationFailed";
}

function statusTone(status: KiroOrganizationAccountSummary["status"]): "success" | "warning" | "danger" | "neutral" {
  if (status === "ready") return "success";
  if (status === "cooldown") return "warning";
  if (status === "auth-required") return "danger";
  return "neutral";
}

interface KiroOrganizationPoolDialogProps {
  open: boolean;
  snapshot: KiroOrganizationPoolSnapshot;
  onOpenChange: (open: boolean) => void;
  onSnapshot: (snapshot: KiroOrganizationPoolSnapshot) => void;
}

export function KiroOrganizationPoolDialog({
  open,
  snapshot,
  onOpenChange,
  onSnapshot,
}: KiroOrganizationPoolDialogProps) {
  const { t, date } = useI18n();
  const [poolDraft, setPoolDraft] = useState(() => ({
    enabled: snapshot.enabled,
    strategy: snapshot.strategy,
    sessionAffinity: snapshot.sessionAffinity,
  }));
  const [accountDraft, setAccountDraft] = useState<KiroOrganizationAccountDraft | null>(null);
  const [modelsByAccount, setModelsByAccount] = useState<Record<string, KiroOrganizationModel[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  useEffect(() => {
    setPoolDraft({
      enabled: snapshot.enabled,
      strategy: snapshot.strategy,
      sessionAffinity: snapshot.sessionAffinity,
    });
  }, [snapshot.enabled, snapshot.generation, snapshot.sessionAffinity, snapshot.strategy]);

  const unavailable = !snapshot.protectedStorage;
  const poolChanged = poolDraft.enabled !== snapshot.enabled
    || poolDraft.strategy !== snapshot.strategy
    || poolDraft.sessionAffinity !== snapshot.sessionAffinity;

  const mutate = async (operation: string, action: () => Promise<KiroOrganizationPoolSnapshot>) => {
    setBusy(operation);
    setErrorKey(null);
    try {
      const next = await action();
      onSnapshot(next);
      return next;
    } catch (reason) {
      setErrorKey(kiroOrganizationErrorKey(reason));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const savePool = async () => {
    await mutate("pool", () => gateway.updateKiroOrganizationPool({
      ...poolDraft,
      expectedGeneration: snapshot.generation,
    }));
  };

  const saveAccount = async () => {
    if (!accountDraft) return;
    const validationError = validateKiroOrganizationAccountDraft(accountDraft);
    if (validationError) {
      setErrorKey(validationError);
      return;
    }
    const input = kiroOrganizationAccountInput(accountDraft);
    const credential = kiroOrganizationCredentialInput(accountDraft);
    const next = await mutate("account", () => accountDraft.editingId && accountDraft.revision !== undefined
      ? gateway.updateKiroOrganizationAccount(accountDraft.editingId, input, accountDraft.revision, credential)
      : gateway.createKiroOrganizationAccount(input, snapshot.generation, credential));
    if (next) setAccountDraft(null);
  };

  const verifyAccount = async (account: KiroOrganizationAccountSummary) => {
    await mutate(`verify:${account.id}`, () => gateway.verifyKiroOrganizationAccount(account.id, account.revision));
  };

  const discoverModels = async (account: KiroOrganizationAccountSummary) => {
    setBusy(`models:${account.id}`);
    setErrorKey(null);
    try {
      const catalog = await gateway.getKiroOrganizationAccountModels(account.id);
      setModelsByAccount((current) => ({ ...current, [account.id]: catalog.models }));
      setAccountDraft(createKiroOrganizationAccountDraft(account));
    } catch (reason) {
      setErrorKey(kiroOrganizationErrorKey(reason));
    } finally {
      setBusy(null);
    }
  };

  const revokeAccount = async (account: KiroOrganizationAccountSummary) => {
    if (!window.confirm(t("settings.providers.kiroOrganization.revokeConfirm", { name: account.name }))) return;
    await mutate(`revoke:${account.id}`, () => gateway.revokeKiroOrganizationAccount(account.id, account.revision));
    setAccountDraft((draft) => draft?.editingId === account.id ? null : draft);
  };

  const deleteAccount = async (account: KiroOrganizationAccountSummary) => {
    if (!window.confirm(t("settings.providers.kiroOrganization.deleteConfirm", { name: account.name }))) return;
    await mutate(`delete:${account.id}`, () => gateway.deleteKiroOrganizationAccount(account.id, account.revision));
    setAccountDraft((draft) => draft?.editingId === account.id ? null : draft);
  };

  const setOpen = (next: boolean) => {
    if (!next) {
      // Credential input is intentionally transient. Closing the modal must
      // discard it even when the user did not press the editor's Cancel button.
      setAccountDraft(null);
      setErrorKey(null);
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex h-[min(86vh,52rem)] w-[min(95vw,72rem)] max-w-none flex-col overflow-hidden p-0">
        <DialogHeader className="mb-0 border-b border-border-soft px-5 py-4 pr-12">
          <DialogTitle>{t("settings.providers.kiroOrganization.dialog.title")}</DialogTitle>
          <DialogDescription className="max-w-3xl text-[11px] leading-5">
            {t("settings.providers.kiroOrganization.dialog.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="space-y-5">
            {!snapshot.protectedStorage ? (
              <div className="flex items-start gap-2 rounded-md border border-danger/25 bg-danger/5 px-3 py-2 text-[10.5px] leading-4 text-danger" role="alert">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>{t("settings.providers.kiroOrganization.storageUnavailable")}</span>
              </div>
            ) : null}

            {errorKey ? (
              <div className="flex items-start gap-2 rounded-md border border-danger/25 bg-danger/5 px-3 py-2 text-[10.5px] leading-4 text-danger" role="alert">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>{t(errorKey)}</span>
              </div>
            ) : null}

            <section className="rounded-lg border border-border-soft bg-bg/25" aria-labelledby="kiro-org-pool-settings">
              <div className="border-b border-border-soft px-3 py-2.5">
                <h3 id="kiro-org-pool-settings" className="text-[11px] font-semibold text-foreground">
                  {t("settings.providers.kiroOrganization.pool.title")}
                </h3>
                <p className="mt-0.5 text-[9.5px] leading-4 text-muted">{t("settings.providers.kiroOrganization.pool.hint")}</p>
              </div>
              <div className="grid gap-3 p-3 md:grid-cols-[minmax(10rem,0.7fr)_minmax(13rem,1fr)_minmax(15rem,1.2fr)_auto] md:items-end">
                <label>
                  <span className="text-[10px] font-medium text-secondary">{t("settings.providers.kiroOrganization.pool.strategy")}</span>
                  <select
                    value={poolDraft.strategy}
                    disabled={unavailable || busy !== null}
                    onChange={(event) => setPoolDraft((current) => ({ ...current, strategy: event.target.value as ProviderAccountPoolStrategy }))}
                    className="mt-1 h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[11px] text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/25 disabled:opacity-50"
                  >
                    {STRATEGIES.map((strategy) => (
                      <option key={strategy} value={strategy}>{t(`settings.providers.accounts.strategy.${strategy}`)}</option>
                    ))}
                  </select>
                </label>
                <div className="flex h-8 items-center justify-between gap-3 rounded-md border border-border-soft px-2.5">
                  <div>
                    <span className="block text-[10px] font-medium text-secondary">{t("settings.providers.kiroOrganization.pool.affinity")}</span>
                    <span className="block text-[8.5px] text-muted">{t("settings.providers.kiroOrganization.pool.affinityHint")}</span>
                  </div>
                  <Switch
                    checked={poolDraft.sessionAffinity}
                    disabled={unavailable || busy !== null}
                    onCheckedChange={(sessionAffinity) => setPoolDraft((current) => ({ ...current, sessionAffinity }))}
                    aria-label={t("settings.providers.kiroOrganization.pool.affinity")}
                  />
                </div>
                <div className="flex h-8 items-center justify-between gap-3 rounded-md border border-border-soft px-2.5">
                  <div>
                    <span className="block text-[10px] font-medium text-secondary">{t("settings.providers.kiroOrganization.pool.enabled")}</span>
                    <span className="block text-[8.5px] text-muted">{t("settings.providers.kiroOrganization.pool.enabledHint")}</span>
                  </div>
                  <Switch
                    checked={poolDraft.enabled}
                    disabled={unavailable || busy !== null}
                    onCheckedChange={(enabled) => setPoolDraft((current) => ({ ...current, enabled }))}
                    aria-label={t("settings.providers.kiroOrganization.pool.enabled")}
                  />
                </div>
                <Button size="sm" disabled={unavailable || busy !== null || !poolChanged} onClick={() => void savePool()}>
                  {busy === "pool" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : null}
                  {t("settings.save")}
                </Button>
              </div>
            </section>

            <section className="grid min-h-80 overflow-hidden rounded-lg border border-border-soft bg-bg/25 lg:grid-cols-[minmax(18rem,0.8fr)_minmax(25rem,1.2fr)]" aria-labelledby="kiro-org-accounts">
              <div className="border-b border-border-soft lg:border-b-0 lg:border-r">
                <div className="flex items-start justify-between gap-3 border-b border-border-soft px-3 py-2.5">
                  <div>
                    <h3 id="kiro-org-accounts" className="text-[11px] font-semibold text-foreground">
                      {t("settings.providers.kiroOrganization.accounts.title")}
                    </h3>
                    <p className="mt-0.5 text-[9.5px] leading-4 text-muted">{t("settings.providers.kiroOrganization.accounts.hint")}</p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={unavailable || busy !== null}
                    onClick={() => { setErrorKey(null); setAccountDraft(createNewKiroOrganizationAccountDraft()); }}
                  >
                    <Plus className="size-3.5" aria-hidden /> {t("settings.providers.kiroOrganization.accounts.add")}
                  </Button>
                </div>

                {snapshot.accounts.length === 0 ? (
                  <p className="px-3 py-8 text-center text-[10px] leading-4 text-muted">{t("settings.providers.kiroOrganization.accounts.empty")}</p>
                ) : (
                  <ul className="divide-y divide-border-soft">
                    {snapshot.accounts.map((account) => (
                      <li key={account.id} className={cn("px-3 py-2.5", accountDraft?.editingId === account.id && "bg-primary/5")}>
                        <div className="flex items-start justify-between gap-3">
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left outline-none"
                            onClick={() => { setErrorKey(null); setAccountDraft(createKiroOrganizationAccountDraft(account)); }}
                          >
                            <span className="flex items-center gap-2">
                              <span className="truncate text-[11px] font-medium text-foreground">{account.name}</span>
                              <Badge tone={statusTone(account.status)}>{t(`settings.providers.kiroOrganization.status.${account.status}`)}</Badge>
                            </span>
                            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[8.5px] text-muted">
                              <span>{account.id}</span>
                              <span>{t("settings.providers.kiroOrganization.accounts.weightValue", { count: account.weight })}</span>
                              {account.inflight > 0 ? <span>{t("settings.providers.kiroOrganization.accounts.inflight", { count: account.inflight })}</span> : null}
                              {account.cooldownUntil > Date.now() ? (
                                <span>{t("settings.providers.kiroOrganization.accounts.cooldownUntil", {
                                  time: date(account.cooldownUntil, { dateStyle: "short", timeStyle: "short" }),
                                })}</span>
                              ) : null}
                            </span>
                          </button>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <Button variant="ghost" size="sm" disabled={busy !== null || !account.hasStoredCredential} onClick={() => void verifyAccount(account)}>
                            {busy === `verify:${account.id}` ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <ShieldCheck className="size-3.5" aria-hidden />}
                            {t("settings.providers.kiroOrganization.accounts.verify")}
                          </Button>
                          <Button variant="ghost" size="sm" disabled={busy !== null || account.status !== "ready"} onClick={() => void discoverModels(account)}>
                            {busy === `models:${account.id}` ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
                            {t("settings.providers.kiroOrganization.accounts.models")}
                          </Button>
                          {account.hasStoredCredential ? (
                            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void revokeAccount(account)}>
                              <Ban className="size-3.5" aria-hidden /> {t("settings.providers.kiroOrganization.accounts.revoke")}
                            </Button>
                          ) : null}
                          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void deleteAccount(account)} className="text-danger hover:text-danger">
                            <Trash2 className="size-3.5" aria-hidden /> {t("settings.providers.kiroOrganization.accounts.delete")}
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="min-w-0 p-3">
                {accountDraft ? (
                  <AccountEditor
                    draft={accountDraft}
                    models={accountDraft.editingId ? modelsByAccount[accountDraft.editingId] ?? [] : []}
                    disabled={unavailable || busy !== null}
                    onChange={setAccountDraft}
                    onCancel={() => { setErrorKey(null); setAccountDraft(null); }}
                    onSave={() => void saveAccount()}
                  />
                ) : (
                  <div className="grid min-h-64 place-items-center text-center">
                    <div className="max-w-sm">
                      <KeyRound className="mx-auto size-5 text-muted" aria-hidden />
                      <p className="mt-2 text-[11px] font-medium text-secondary">{t("settings.providers.kiroOrganization.editor.idleTitle")}</p>
                      <p className="mt-1 text-[9.5px] leading-4 text-muted">{t("settings.providers.kiroOrganization.editor.idleHint")}</p>
                    </div>
                  </div>
                )}
              </div>
            </section>

            <div className="flex items-start gap-2 rounded-md border border-warning/20 bg-warning/5 px-3 py-2 text-[9.5px] leading-4 text-warning">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{t("settings.providers.kiroOrganization.governance")}</span>
            </div>
          </div>
        </div>

        <DialogFooter className="mt-0 border-t border-border-soft px-5 py-3">
          <div className="mr-auto flex flex-wrap items-center gap-2 font-mono text-[8.5px] text-muted">
            <span>{t("settings.providers.kiroOrganization.transport", { value: snapshot.transport })}</span>
            <span>{t("settings.providers.kiroOrganization.minimumCli", { version: snapshot.minimumCliVersion })}</span>
          </div>
          <Button variant="secondary" onClick={() => setOpen(false)}>{t("common.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface AccountEditorProps {
  draft: KiroOrganizationAccountDraft;
  models: readonly KiroOrganizationModel[];
  disabled: boolean;
  onChange: (draft: KiroOrganizationAccountDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}

function AccountEditor({ draft, models, disabled, onChange, onCancel, onSave }: AccountEditorProps) {
  const { t } = useI18n();
  const update = (patch: Partial<KiroOrganizationAccountDraft>) => onChange({ ...draft, ...patch });
  const editing = Boolean(draft.editingId);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[11px] font-semibold text-foreground">
          {t(editing ? "settings.providers.kiroOrganization.editor.editTitle" : "settings.providers.kiroOrganization.editor.addTitle")}
        </h3>
        <p className="mt-0.5 text-[9.5px] leading-4 text-muted">{t("settings.providers.kiroOrganization.editor.hint")}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="text-[10px] font-medium text-secondary">{t("settings.providers.kiroOrganization.editor.name")}</span>
          <Input
            autoFocus
            value={draft.name}
            disabled={disabled}
            maxLength={120}
            onChange={(event) => {
              const name = event.target.value;
              const previousSlug = slugKiroOrganizationAccountId(draft.name);
              update({ name, ...(!editing && (!draft.id || draft.id === previousSlug) ? { id: slugKiroOrganizationAccountId(name) } : {}) });
            }}
            placeholder={t("settings.providers.kiroOrganization.editor.namePlaceholder")}
            className="mt-1"
          />
        </label>
        <label>
          <span className="text-[10px] font-medium text-secondary">{t("settings.providers.kiroOrganization.editor.id")}</span>
          <Input
            value={draft.id}
            disabled={disabled || editing}
            maxLength={64}
            onChange={(event) => update({ id: event.target.value.toLowerCase() })}
            placeholder={t("settings.providers.kiroOrganization.editor.idPlaceholder")}
            className="mt-1 font-mono"
          />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <NumberField label={t("settings.providers.kiroOrganization.editor.weight")} value={draft.weight} min={1} max={100} disabled={disabled} onChange={(weight) => update({ weight })} />
        <NumberField label={t("settings.providers.kiroOrganization.editor.priority")} value={draft.priority} min={0} max={10_000} disabled={disabled} onChange={(priority) => update({ priority })} />
        <div className="rounded-md border border-border-soft px-2.5 py-1.5">
          <span className="block text-[10px] font-medium text-secondary">{t("settings.providers.kiroOrganization.editor.concurrency")}</span>
          <span className="mt-0.5 block text-[9px] leading-4 text-muted">{t("settings.providers.kiroOrganization.editor.concurrencyFixed")}</span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-md border border-border-soft px-2.5 py-2">
        <div>
          <span className="block text-[10px] font-medium text-secondary">{t("settings.providers.kiroOrganization.editor.enabled")}</span>
          <span className="mt-0.5 block text-[9px] text-muted">{t("settings.providers.kiroOrganization.editor.enabledHint")}</span>
        </div>
        <Switch checked={draft.enabled} disabled={disabled} onCheckedChange={(enabled) => update({ enabled })} aria-label={t("settings.providers.kiroOrganization.editor.enabled")} />
      </div>

      <PolicyEditor
        label={t("settings.providers.kiroOrganization.editor.models")}
        hint={t("settings.providers.kiroOrganization.editor.modelsHint")}
        mode={draft.modelMode}
        ids={draft.modelIds}
        suggestions={models}
        disabled={disabled}
        onChange={(modelMode, modelIds) => update({ modelMode, modelIds })}
      />
      <PolicyEditor
        label={t("settings.providers.kiroOrganization.editor.projects")}
        hint={t("settings.providers.kiroOrganization.editor.projectsHint")}
        mode={draft.projectMode}
        ids={draft.projectIds}
        disabled={disabled}
        onChange={(projectMode, projectIds) => update({ projectMode, projectIds })}
      />

      <section className="rounded-md border border-border-soft p-3" aria-label={t("settings.providers.kiroOrganization.editor.credential")}>
        <label>
          <span className="text-[10px] font-medium text-secondary">{t("settings.providers.kiroOrganization.editor.apiKey")}</span>
          <Input
            type="password"
            value={draft.apiKey}
            disabled={disabled}
            onChange={(event) => update({ apiKey: event.target.value })}
            placeholder={draft.hasStoredCredential
              ? t("settings.providers.kiroOrganization.editor.keyStored")
              : t("settings.providers.kiroOrganization.editor.keyPlaceholder")}
            autoComplete="new-password"
            spellCheck={false}
            className="mt-1 font-mono"
          />
        </label>
        <p className="mt-1.5 text-[9px] leading-4 text-muted">
          {t(draft.hasStoredCredential
            ? "settings.providers.kiroOrganization.editor.keyReplaceHint"
            : "settings.providers.kiroOrganization.editor.keyPrivacyHint")}
        </p>
      </section>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={disabled} onClick={onCancel}>{t("common.cancel")}</Button>
        <Button size="sm" disabled={disabled} onClick={onSave}>
          <CheckCircle2 className="size-3.5" aria-hidden />
          {t(editing ? "settings.providers.kiroOrganization.editor.save" : "settings.providers.kiroOrganization.editor.add")}
        </Button>
      </div>
    </div>
  );
}

function PolicyEditor({
  label,
  hint,
  mode,
  ids,
  suggestions = [],
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  mode: KiroOrganizationPolicyMode;
  ids: string[];
  suggestions?: readonly KiroOrganizationModel[];
  disabled: boolean;
  onChange: (mode: KiroOrganizationPolicyMode, ids: string[]) => void;
}) {
  const { t } = useI18n();
  const options = useMemo(() => [
    { value: "all" as const, label: t("settings.providers.kiroOrganization.policy.all") },
    { value: "selected" as const, label: t("settings.providers.kiroOrganization.policy.selected") },
    { value: "none" as const, label: t("settings.providers.kiroOrganization.policy.none") },
  ], [t]);
  const selected = useMemo(() => new Set(ids), [ids]);

  return (
    <section className="rounded-md border border-border-soft p-3" aria-label={label}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-[10px] font-medium text-secondary">{label}</h4>
          <p className="mt-0.5 max-w-xl text-[9px] leading-4 text-muted">{hint}</p>
        </div>
        <SegmentedControl
          value={mode}
          options={options}
          onChange={(next) => { if (!disabled) onChange(next, ids); }}
          size="sm"
          className={disabled ? "pointer-events-none opacity-50" : undefined}
        />
      </div>
      {mode === "selected" ? (
        <div className="mt-2 space-y-2">
          <Input
            value={ids.join(", ")}
            disabled={disabled}
            onChange={(event) => onChange(mode, parseKiroOrganizationPolicyIds(event.target.value))}
            placeholder={t("settings.providers.kiroOrganization.policy.idsPlaceholder")}
            aria-label={t("settings.providers.kiroOrganization.policy.ids")}
            className="font-mono text-[10px]"
          />
          {suggestions.length > 0 ? (
            <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto" aria-label={t("settings.providers.kiroOrganization.policy.discoveredModels")}>
              {suggestions.map((model) => {
                const active = selected.has(model.id);
                return (
                  <button
                    key={model.id}
                    type="button"
                    disabled={disabled}
                    className={cn(
                      "rounded border px-2 py-1 font-mono text-[8.5px] transition-colors disabled:opacity-50",
                      active ? "border-primary/40 bg-primary/10 text-primary" : "border-border-soft text-muted hover:text-foreground",
                    )}
                    aria-pressed={active}
                    onClick={() => onChange(mode, active ? ids.filter((id) => id !== model.id) : [...ids, model.id])}
                  >
                    {model.name || model.id}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function NumberField({
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
    <label>
      <span className="text-[10px] font-medium text-secondary">{label}</span>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-1 font-mono"
      />
    </label>
  );
}
