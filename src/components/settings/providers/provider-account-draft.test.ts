import { describe, expect, it } from "vitest";

import {
  createNewProviderAccountDraft,
  createProviderAccountDraft,
  providerAccountCredentials,
  providerAccountInput,
  validateProviderAccountDraft,
} from "./provider-account-draft";

describe("provider account draft", () => {
  it("never copies stored credentials into an edit draft", () => {
    const draft = createProviderAccountDraft({
      id: "backup",
      name: "Backup",
      enabled: true,
      weight: 2,
      priority: 100,
      maxConcurrency: 4,
      primary: false,
      hasStoredCredentials: true,
      ready: true,
      status: "ready",
      cooldownUntil: 0,
      inflight: 0,
    });

    expect(draft.hasStoredCredentials).toBe(true);
    expect(providerAccountCredentials(draft)).toEqual({});
    expect(validateProviderAccountDraft(draft, "openai-chat", true)).toBeNull();
  });

  it("preserves unrestricted, selected, and fail-closed model assignments", () => {
    const unrestricted = createProviderAccountDraft({
      id: "all",
      name: "All models",
      enabled: true,
      weight: 1,
      priority: 100,
      maxConcurrency: 4,
      status: "ready",
      cooldownUntil: 0,
      inflight: 0,
    });
    const selected = createProviderAccountDraft({
      id: "selected",
      name: "Selected models",
      enabled: true,
      weight: 1,
      priority: 100,
      maxConcurrency: 4,
      modelIds: ["alpha", "beta"],
      status: "ready",
      cooldownUntil: 0,
      inflight: 0,
    });
    const denied = createProviderAccountDraft({
      id: "denied",
      name: "No models",
      enabled: true,
      weight: 1,
      priority: 100,
      maxConcurrency: 4,
      modelIds: [],
      status: "ready",
      cooldownUntil: 0,
      inflight: 0,
    });

    expect(Object.hasOwn(unrestricted, "modelIds")).toBe(false);
    expect(providerAccountInput(unrestricted).modelIds).toBeNull();
    expect(providerAccountInput(selected).modelIds).toEqual(["alpha", "beta"]);
    expect(providerAccountInput(denied).modelIds).toEqual([]);
  });

  it("requires complete credentials for a new credential-backed account", () => {
    const draft = { ...createNewProviderAccountDraft(), id: "backup", name: "Backup" };

    expect(validateProviderAccountDraft(draft, "openai-chat", true)).toBe(
      "settings.providers.error.credentialsRequired",
    );
    expect(validateProviderAccountDraft({ ...draft, apiKey: "secret" }, "openai-chat", true)).toBeNull();
  });

  it("allows metadata-only edits when credentials are missing", () => {
    const draft = createProviderAccountDraft({
      id: "backup",
      name: "Backup",
      enabled: false,
      weight: 1,
      priority: 100,
      maxConcurrency: 4,
      hasStoredCredentials: false,
      ready: false,
      status: "auth-required",
      cooldownUntil: 0,
      inflight: 0,
    });

    expect(providerAccountCredentials(draft)).toEqual({});
    expect(validateProviderAccountDraft(draft, "openai-chat", true)).toBeNull();
  });

  it("enforces the gateway's 120-character account-name limit", () => {
    const validDraft = {
      ...createNewProviderAccountDraft(),
      id: "backup",
      name: "a".repeat(120),
      apiKey: "secret",
    };

    expect(validateProviderAccountDraft(validDraft, "openai-chat", true)).toBeNull();
    expect(validateProviderAccountDraft({ ...validDraft, name: "a".repeat(121) }, "openai-chat", true)).toBe(
      "settings.providers.accounts.error.nameRequired",
    );
  });

  it("normalizes only public account metadata and supplied credentials", () => {
    const draft = {
      ...createNewProviderAccountDraft(),
      id: " Backup_One ",
      name: " Backup one ",
      apiKey: " key ",
    };

    expect(providerAccountInput(draft)).toEqual({
      id: "backup_one",
      name: "Backup one",
      enabled: true,
      weight: 1,
      priority: 100,
      maxConcurrency: 4,
      modelIds: null,
    });
    expect(providerAccountCredentials(draft)).toEqual({ apiKey: "key" });
  });
});
