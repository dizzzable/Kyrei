import type { TranslationKey } from "@/i18n";
import type {
  KiroOrganizationAccountInput,
  KiroOrganizationAccountSummary,
  KiroOrganizationCredentialInput,
} from "@/lib/kiro-organization-types";

export type KiroOrganizationPolicyMode = "all" | "selected" | "none";

export interface KiroOrganizationAccountDraft {
  id: string;
  editingId?: string;
  revision?: number;
  name: string;
  enabled: boolean;
  weight: number;
  priority: number;
  maxConcurrency: number;
  modelMode: KiroOrganizationPolicyMode;
  modelIds: string[];
  projectMode: KiroOrganizationPolicyMode;
  projectIds: string[];
  apiKey: string;
  hasStoredCredential: boolean;
}

const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const POLICY_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/;

export function slugKiroOrganizationAccountId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function policyMode(ids: readonly string[] | undefined): KiroOrganizationPolicyMode {
  if (ids === undefined) return "all";
  return ids.length === 0 ? "none" : "selected";
}

export function createNewKiroOrganizationAccountDraft(): KiroOrganizationAccountDraft {
  return {
    id: "",
    name: "",
    enabled: true,
    weight: 1,
    priority: 100,
    maxConcurrency: 1,
    modelMode: "all",
    modelIds: [],
    projectMode: "all",
    projectIds: [],
    apiKey: "",
    hasStoredCredential: false,
  };
}

export function createKiroOrganizationAccountDraft(
  account: KiroOrganizationAccountSummary,
): KiroOrganizationAccountDraft {
  return {
    id: account.id,
    editingId: account.id,
    revision: account.revision,
    name: account.name,
    enabled: account.enabled,
    weight: account.weight,
    priority: account.priority,
    maxConcurrency: account.maxConcurrency,
    modelMode: policyMode(account.modelIds),
    modelIds: [...(account.modelIds ?? [])],
    projectMode: policyMode(account.projectIds),
    projectIds: [...(account.projectIds ?? [])],
    apiKey: "",
    hasStoredCredential: account.hasStoredCredential,
  };
}

export function parseKiroOrganizationPolicyIds(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/u).map((entry) => entry.trim()).filter(Boolean))];
}

function policyInput(mode: KiroOrganizationPolicyMode, ids: readonly string[]): string[] | null {
  if (mode === "all") return null;
  if (mode === "none") return [];
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

export function kiroOrganizationAccountInput(
  draft: KiroOrganizationAccountDraft,
): KiroOrganizationAccountInput {
  return {
    id: draft.id.trim().toLowerCase(),
    name: draft.name.trim(),
    enabled: draft.enabled,
    weight: draft.weight,
    priority: draft.priority,
    maxConcurrency: draft.maxConcurrency,
    modelIds: policyInput(draft.modelMode, draft.modelIds),
    projectIds: policyInput(draft.projectMode, draft.projectIds),
  };
}

export function kiroOrganizationCredentialInput(
  draft: KiroOrganizationAccountDraft,
): KiroOrganizationCredentialInput | undefined {
  const apiKey = draft.apiKey.trim();
  return apiKey ? { apiKey } : undefined;
}

export function validateKiroOrganizationAccountDraft(
  draft: KiroOrganizationAccountDraft,
): TranslationKey | null {
  if (!draft.name.trim() || draft.name.trim().length > 120) {
    return "settings.providers.kiroOrganization.error.nameInvalid";
  }
  if (!ACCOUNT_ID.test(draft.id.trim().toLowerCase())) {
    return "settings.providers.kiroOrganization.error.idInvalid";
  }
  if (
    !Number.isInteger(draft.weight) || draft.weight < 1 || draft.weight > 100
    || !Number.isInteger(draft.priority) || draft.priority < 0 || draft.priority > 10_000
    || draft.maxConcurrency !== 1
  ) {
    return "settings.providers.kiroOrganization.error.limitsInvalid";
  }
  const selectedIds = [
    ...(draft.modelMode === "selected" ? draft.modelIds : []),
    ...(draft.projectMode === "selected" ? draft.projectIds : []),
  ];
  if (selectedIds.some((id) => !POLICY_ID.test(id))) {
    return "settings.providers.kiroOrganization.error.policyInvalid";
  }
  if (
    (draft.modelMode === "selected" && draft.modelIds.length === 0)
    || (draft.projectMode === "selected" && draft.projectIds.length === 0)
  ) {
    return "settings.providers.kiroOrganization.error.policyRequired";
  }
  return null;
}
