import type { ProviderCredentialsInput, ProviderProtocol } from "@/lib/types";
import type { TranslationKey } from "@/i18n";

export type ProviderValidationError = Extract<
  TranslationKey,
  `settings.providers.error.${string}`
>;

export type ValidationResult<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; code: ProviderValidationError };

export function parseProviderModels(value: string): Array<{ id: string }> {
  return [...new Set(value.split(/[\n,]/).map((model) => model.trim()).filter(Boolean))]
    .map((id) => ({ id }));
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function validateProviderDraft(input: {
  name: string;
  baseURL: string;
  models: string;
}): ValidationResult<{ models: Array<{ id: string }> }> {
  if (!input.name.trim()) return { ok: false, code: "settings.providers.error.nameRequired" };
  if (!isHttpUrl(input.baseURL.trim())) {
    return { ok: false, code: "settings.providers.error.baseUrlInvalid" };
  }
  const models = parseProviderModels(input.models);
  if (models.length === 0) return { ok: false, code: "settings.providers.error.modelRequired" };
  return { ok: true, models };
}

export function validateProviderCredentials(
  protocol: ProviderProtocol,
  credentials: ProviderCredentialsInput,
): ValidationResult {
  if (protocol === "amazon-bedrock") {
    const hasBearer = Boolean(credentials.apiKey?.trim());
    const hasKeyPair = Boolean(credentials.accessKeyId?.trim() && credentials.secretAccessKey?.trim());
    if (!credentials.region?.trim() || (!hasBearer && !hasKeyPair)) {
      return { ok: false, code: "settings.providers.error.bedrockCredentials" };
    }
  } else if (protocol === "google-vertex") {
    if (
      !credentials.project?.trim()
      || !credentials.location?.trim()
      || !credentials.clientEmail?.trim()
      || !credentials.privateKey?.trim()
    ) {
      return { ok: false, code: "settings.providers.error.vertexCredentials" };
    }
  } else if (!credentials.apiKey?.trim()) {
    return { ok: false, code: "settings.providers.error.apiKeyRequired" };
  }
  return { ok: true };
}
