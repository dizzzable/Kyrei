import type { ProviderAccountPoolStrategy } from "./types";

export type KiroOrganizationAccountStatus = "ready" | "cooldown" | "auth-required" | "disabled";

export interface KiroOrganizationModel {
  id: string;
  name?: string;
}

/** Public policy and health only. Credential material never crosses this boundary. */
export interface KiroOrganizationAccountSummary {
  id: string;
  name: string;
  revision: number;
  enabled: boolean;
  weight: number;
  priority: number;
  maxConcurrency: number;
  /** Missing means every model; an empty list blocks every model. */
  modelIds?: string[];
  /** Missing means every project; an empty list blocks every project. */
  projectIds?: string[];
  status: KiroOrganizationAccountStatus;
  reasonCode?: string;
  cooldownUntil: number;
  inflight: number;
  hasStoredCredential: boolean;
  verifiedAt?: number;
  lastUsedAt?: number;
}

export interface KiroOrganizationPoolSnapshot {
  version: number;
  generation: number;
  enabled: boolean;
  strategy: ProviderAccountPoolStrategy;
  sessionAffinity: boolean;
  protectedStorage: boolean;
  transport: "official-cli-headless";
  minimumCliVersion: "1.28.0";
  accounts: KiroOrganizationAccountSummary[];
}

export type KiroOrganizationAccountInput = Pick<
  KiroOrganizationAccountSummary,
  "id" | "name" | "enabled" | "weight" | "priority" | "maxConcurrency"
> & {
  /** `null` resets the policy to unrestricted; `[]` deliberately blocks all. */
  modelIds?: string[] | null;
  /** `null` resets the policy to unrestricted; `[]` deliberately blocks all. */
  projectIds?: string[] | null;
};

/** Write-only input. The gateway must never serialize this type back to the renderer. */
export interface KiroOrganizationCredentialInput {
  apiKey: string;
}

export interface KiroOrganizationModelCatalog {
  models: KiroOrganizationModel[];
  count: number;
}
