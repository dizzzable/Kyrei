import { describe, expect, it } from "vitest";
import {
  KiroOrganizationConfigError,
  MAX_KIRO_ORGANIZATION_ACCOUNTS,
  normalizeKiroOrganizationAccount,
  normalizeKiroOrganizationAccountSecret,
  normalizeKiroOrganizationConfig,
  normalizeKiroOrganizationSecrets,
  serializeKiroOrganizationSecrets,
} from "../core/kiro-organization-config.js";

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: "primary",
    name: "Primary",
    enabled: true,
    weight: 1,
    priority: 0,
    maxConcurrency: 1,
    ...overrides,
  };
}

describe("Kiro organization public configuration", () => {
  it("keeps public metadata strict and never accepts credential-shaped fields", () => {
    expect(normalizeKiroOrganizationAccount(account())).toEqual({
      id: "primary",
      name: "Primary",
      revision: 1,
      enabled: true,
      weight: 1,
      priority: 0,
      maxConcurrency: 1,
    });
    for (const invalid of [
      account({ id: "UPPER" }),
      account({ name: " padded " }),
      account({ weight: 0 }),
      account({ priority: -1 }),
      account({ maxConcurrency: 2 }),
      account({ apiKey: "must-never-be-public" }),
    ]) {
      expect(() => normalizeKiroOrganizationAccount(invalid)).toThrow(KiroOrganizationConfigError);
    }
  });

  it("preserves absent-as-all and empty-as-none policy semantics", () => {
    const unrestricted = normalizeKiroOrganizationAccount(account());
    expect(unrestricted).not.toHaveProperty("modelIds");
    expect(unrestricted).not.toHaveProperty("projectIds");

    expect(normalizeKiroOrganizationAccount(account({ modelIds: [], projectIds: [] })))
      .toMatchObject({ modelIds: [], projectIds: [] });
    expect(normalizeKiroOrganizationAccount(account({ modelIds: null, projectIds: null })))
      .not.toHaveProperty("modelIds");
    expect(() => normalizeKiroOrganizationAccount(account({ modelIds: ["safe", "safe"] })))
      .toThrowError(/policy id/i);
    expect(() => normalizeKiroOrganizationAccount(account({ projectIds: ["project with spaces"] })))
      .toThrowError(/policy id/i);
  });

  it("advances global and changed account revisions while retaining unchanged ones", () => {
    const first = normalizeKiroOrganizationConfig({
      enabled: true,
      strategy: "balanced",
      sessionAffinity: true,
      accounts: [account(), account({ id: "backup", name: "Backup", priority: 1 })],
    });
    const unchanged = normalizeKiroOrganizationConfig(first, { previous: first });
    expect(unchanged.revision).toBe(1);
    expect(unchanged.accounts.map((entry) => entry.revision)).toEqual([1, 1]);

    const changed = normalizeKiroOrganizationConfig({
      ...first,
      accounts: [
        { ...first.accounts[0], weight: 2 },
        first.accounts[1],
      ],
    }, { previous: first });
    expect(changed.revision).toBe(2);
    expect(changed.accounts.map((entry) => entry.revision)).toEqual([2, 1]);
  });

  it("preserves a credential-only exactly-next revision and rejects revision jumps", () => {
    const first = normalizeKiroOrganizationConfig({
      enabled: true,
      accounts: [account()],
    });
    const credentialOnly = normalizeKiroOrganizationConfig({
      ...first,
      revision: 2,
      accounts: [{ ...first.accounts[0], revision: 2 }],
    }, { previous: first });
    expect(credentialOnly.revision).toBe(2);
    expect(credentialOnly.accounts[0].revision).toBe(2);

    expect(() => normalizeKiroOrganizationConfig({
      ...credentialOnly,
      revision: 4,
    }, { previous: credentialOnly })).toThrowError(/revision conflicts/i);
    expect(() => normalizeKiroOrganizationConfig({
      ...credentialOnly,
      accounts: [{ ...credentialOnly.accounts[0], revision: 4 }],
    }, { previous: credentialOnly })).toThrowError(/revision conflicts/i);
  });

  it("rejects duplicates and more than 64 accounts instead of truncating", () => {
    expect(() => normalizeKiroOrganizationConfig({
      accounts: [account(), account({ name: "Duplicate" })],
    })).toThrowError(/duplicated/i);
    expect(() => normalizeKiroOrganizationConfig({
      accounts: Array.from({ length: MAX_KIRO_ORGANIZATION_ACCOUNTS + 1 }, (_, index) => account({
        id: `account-${index}`,
        name: `Account ${index}`,
      })),
    })).toThrowError(/limit/i);
  });
});

describe("Kiro organization private credentials", () => {
  it("normalizes API keys only through the write-only secret boundary", () => {
    expect(normalizeKiroOrganizationAccountSecret({ apiKey: "kiro-private-key" }))
      .toEqual({ apiKey: "kiro-private-key" });
    for (const invalid of [
      { apiKey: " key-with-space" },
      { apiKey: "key\nnewline" },
      { apiKey: "key", refreshToken: "not-supported" },
      { token: "wrong-shape" },
    ]) {
      expect(() => normalizeKiroOrganizationAccountSecret(invalid)).toThrow(KiroOrganizationConfigError);
    }
  });

  it("round-trips a versioned JSON-safe envelope only inside protected persistence", () => {
    const secrets = normalizeKiroOrganizationSecrets({
      primary: { apiKey: "key-primary" },
      backup: { apiKey: "key-backup" },
    });
    const serialized = serializeKiroOrganizationSecrets(secrets);
    expect(serialized).toEqual({
      version: 1,
      accounts: {
        backup: { kind: "api-key", apiKey: "key-backup" },
        primary: { kind: "api-key", apiKey: "key-primary" },
      },
    });
    expect([...normalizeKiroOrganizationSecrets(serialized)]).toEqual([
      ["backup", { apiKey: "key-backup" }],
      ["primary", { apiKey: "key-primary" }],
    ]);
    expect(() => normalizeKiroOrganizationSecrets({
      version: 1,
      accounts: { primary: { kind: "browser-token", apiKey: "private" } },
    })).toThrowError(/kind/i);
  });
});
