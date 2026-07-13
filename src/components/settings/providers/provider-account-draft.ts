import type { TranslationKey } from "@/i18n";
import type {
  ProviderAccount,
  ProviderAccountInput,
  ProviderCredentialsInput,
  ProviderProtocol,
} from "@/lib/types";
import { validateProviderCredentials } from "../provider-validation";

export type ProviderAccountDraft = Omit<ProviderAccountInput, "modelIds"> & ProviderCredentialsInput & {
  editingId?: string;
  hasStoredCredentials: boolean;
  /** Missing means unrestricted; an empty list intentionally denies every model. */
  modelIds?: string[];
};

export const PROVIDER_ACCOUNT_NAME_MAX_LENGTH = 120;

const EMPTY_CREDENTIALS: ProviderCredentialsInput = {
  apiKey: "",
  region: "",
  accessKeyId: "",
  secretAccessKey: "",
  sessionToken: "",
  project: "",
  location: "",
  clientEmail: "",
  privateKey: "",
};

export function createNewProviderAccountDraft(): ProviderAccountDraft {
  return {
    id: "",
    name: "",
    enabled: true,
    weight: 1,
    priority: 100,
    maxConcurrency: 4,
    hasStoredCredentials: false,
    ...EMPTY_CREDENTIALS,
  };
}

export function createProviderAccountDraft(account: ProviderAccount): ProviderAccountDraft {
  return {
    id: account.id,
    editingId: account.id,
    name: account.name,
    enabled: account.enabled,
    weight: account.weight,
    priority: account.priority,
    maxConcurrency: account.maxConcurrency,
    ...(account.modelIds === undefined ? {} : { modelIds: [...account.modelIds] }),
    hasStoredCredentials: account.hasStoredCredentials === true,
    ...EMPTY_CREDENTIALS,
  };
}

export function providerAccountInput(draft: ProviderAccountDraft): ProviderAccountInput {
  return {
    id: draft.id.trim().toLowerCase(),
    name: draft.name.trim(),
    enabled: draft.enabled,
    weight: draft.weight,
    priority: draft.priority,
    maxConcurrency: draft.maxConcurrency,
    // PATCH uses null to remove a previous restriction. The gateway normalizes
    // that command back to an absent field in its public snapshot.
    modelIds: draft.modelIds === undefined ? null : [...new Set(draft.modelIds)],
  };
}

export function providerAccountCredentials(draft: ProviderAccountDraft): ProviderCredentialsInput {
  return {
    ...(draft.apiKey?.trim() ? { apiKey: draft.apiKey.trim() } : {}),
    ...(draft.region?.trim() ? { region: draft.region.trim() } : {}),
    ...(draft.accessKeyId?.trim() ? { accessKeyId: draft.accessKeyId.trim() } : {}),
    ...(draft.secretAccessKey?.trim() ? { secretAccessKey: draft.secretAccessKey.trim() } : {}),
    ...(draft.sessionToken?.trim() ? { sessionToken: draft.sessionToken.trim() } : {}),
    ...(draft.project?.trim() ? { project: draft.project.trim() } : {}),
    ...(draft.location?.trim() ? { location: draft.location.trim() } : {}),
    ...(draft.clientEmail?.trim() ? { clientEmail: draft.clientEmail.trim() } : {}),
    ...(draft.privateKey?.trim() ? { privateKey: draft.privateKey.trim() } : {}),
  };
}

export function providerAccountHasCredentialInput(draft: ProviderAccountDraft): boolean {
  return Object.keys(providerAccountCredentials(draft)).length > 0;
}

export function validateProviderAccountDraft(
  draft: ProviderAccountDraft,
  protocol: ProviderProtocol,
  requiresCredentials: boolean,
): TranslationKey | null {
  if (!draft.name.trim() || draft.name.trim().length > PROVIDER_ACCOUNT_NAME_MAX_LENGTH) {
    return "settings.providers.accounts.error.nameRequired";
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(draft.id.trim()) || draft.id.trim() === "primary") {
    return "settings.providers.accounts.error.idInvalid";
  }
  if (
    !Number.isInteger(draft.weight) || draft.weight < 1 || draft.weight > 100
    || !Number.isInteger(draft.priority) || draft.priority < 0 || draft.priority > 10_000
    || !Number.isInteger(draft.maxConcurrency) || draft.maxConcurrency < 1 || draft.maxConcurrency > 64
  ) {
    return "settings.providers.accounts.error.limitsInvalid";
  }
  if (!requiresCredentials) return null;
  const hasInput = providerAccountHasCredentialInput(draft);
  // Metadata remains editable when an account intentionally has no stored
  // credentials. New credential-backed accounts still require a complete set.
  if (draft.editingId && !hasInput) return null;
  if (!hasInput) return "settings.providers.error.credentialsRequired";
  const result = validateProviderCredentials(protocol, providerAccountCredentials(draft));
  return result.ok ? null : result.code;
}
