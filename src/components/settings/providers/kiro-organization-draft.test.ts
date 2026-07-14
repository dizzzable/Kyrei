import { describe, expect, it } from "vitest";

import type { KiroOrganizationAccountSummary } from "@/lib/kiro-organization-types";
import {
  createKiroOrganizationAccountDraft,
  createNewKiroOrganizationAccountDraft,
  kiroOrganizationAccountInput,
  kiroOrganizationCredentialInput,
  parseKiroOrganizationPolicyIds,
  slugKiroOrganizationAccountId,
  validateKiroOrganizationAccountDraft,
} from "./kiro-organization-draft";

const account: KiroOrganizationAccountSummary = {
  id: "team-primary",
  name: "Team primary",
  revision: 3,
  enabled: true,
  weight: 2,
  priority: 40,
  maxConcurrency: 3,
  modelIds: ["claude-sonnet-4.5"],
  projectIds: [],
  status: "ready",
  cooldownUntil: 0,
  inflight: 0,
  hasStoredCredential: true,
};

describe("Kiro organization account draft", () => {
  it("never copies stored credentials into editable renderer state", () => {
    const draft = createKiroOrganizationAccountDraft(account);

    expect(draft.apiKey).toBe("");
    expect(draft.hasStoredCredential).toBe(true);
    expect(kiroOrganizationCredentialInput(draft)).toBeUndefined();
    expect(JSON.stringify(draft)).not.toMatch(/secret|token|credential-value/i);
  });

  it("preserves explicit all, selected and none policy semantics", () => {
    const draft = createKiroOrganizationAccountDraft(account);
    expect(draft.modelMode).toBe("selected");
    expect(draft.projectMode).toBe("none");
    expect(kiroOrganizationAccountInput(draft)).toMatchObject({
      modelIds: ["claude-sonnet-4.5"],
      projectIds: [],
    });

    const unrestricted = createNewKiroOrganizationAccountDraft();
    unrestricted.id = "unrestricted";
    unrestricted.name = "Unrestricted";
    expect(kiroOrganizationAccountInput(unrestricted)).toMatchObject({ modelIds: null, projectIds: null });
  });

  it("normalizes IDs, de-duplicates policy input and emits only an explicitly typed key", () => {
    expect(slugKiroOrganizationAccountId(" Team / Primary ")).toBe("team-primary");
    expect(parseKiroOrganizationPolicyIds("model-a, model-b\nmodel-a")).toEqual(["model-a", "model-b"]);

    const draft = createNewKiroOrganizationAccountDraft();
    draft.id = "org-primary";
    draft.name = "Org primary";
    draft.apiKey = "  org-owned-key  ";
    expect(kiroOrganizationCredentialInput(draft)).toEqual({ apiKey: "org-owned-key" });
  });

  it("rejects malformed identity, limits and empty selected policies", () => {
    const draft = createNewKiroOrganizationAccountDraft();
    expect(validateKiroOrganizationAccountDraft(draft)).toBe("settings.providers.kiroOrganization.error.nameInvalid");

    draft.name = "Account";
    draft.id = "../escape";
    expect(validateKiroOrganizationAccountDraft(draft)).toBe("settings.providers.kiroOrganization.error.idInvalid");

    draft.id = "account";
    draft.maxConcurrency = 0;
    expect(validateKiroOrganizationAccountDraft(draft)).toBe("settings.providers.kiroOrganization.error.limitsInvalid");

    draft.maxConcurrency = 1;
    draft.modelMode = "selected";
    expect(validateKiroOrganizationAccountDraft(draft)).toBe("settings.providers.kiroOrganization.error.policyRequired");

    draft.modelIds = [`m+${"x".repeat(254)}`];
    expect(validateKiroOrganizationAccountDraft(draft)).toBeNull();
    draft.modelIds = [`m+${"x".repeat(255)}`];
    expect(validateKiroOrganizationAccountDraft(draft)).toBe("settings.providers.kiroOrganization.error.policyInvalid");
  });
});
