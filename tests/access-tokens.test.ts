import { describe, expect, it } from "vitest";
import {
  createAccessPrincipal,
  evaluatePrincipalBudget,
  hashAccessToken,
  isAccessTokenFormat,
  mintAccessTokenPlain,
  normalizeAccessControl,
  normalizeAccessTokenHashes,
  patchPrincipal,
  regenerateAccessPrincipal,
  resolveAccessPrincipal,
  AccessTokenError,
} from "../core/access-tokens.js";

describe("access-tokens", () => {
  it("mints and verifies principals with hash-only secrets", () => {
    const { principal, plain, hash } = createAccessPrincipal({ label: "Alice" });
    expect(isAccessTokenFormat(plain)).toBe(true);
    expect(hash).toBe(hashAccessToken(plain));
    expect(principal.prefix.startsWith("kyrei_at_")).toBe(true);

    const control = normalizeAccessControl({ principals: [principal] });
    const hashes = normalizeAccessTokenHashes({ [principal.id]: hash });
    const resolved = resolveAccessPrincipal(plain, control, hashes);
    expect(resolved?.id).toBe(principal.id);
    expect(resolveAccessPrincipal("kyrei_at_nope", control, hashes)).toBeNull();
  });

  it("rejects disabled principals", () => {
    const { principal, plain, hash } = createAccessPrincipal({ label: "Bob" });
    principal.enabled = false;
    expect(() => resolveAccessPrincipal(
      plain,
      { principals: [principal] },
      { [principal.id]: hash },
    )).toThrow(AccessTokenError);
  });

  it("regenerates secrets and patches metadata", () => {
    const first = createAccessPrincipal({ label: "Carol" });
    const regen = regenerateAccessPrincipal(first.principal);
    expect(regen.plain).not.toBe(first.plain);
    expect(regen.hash).not.toBe(first.hash);
    expect(regen.principal.id).toBe(first.principal.id);

    const patched = patchPrincipal(first.principal, {
      label: "Carol Ops",
      hardCostUsd: 2.5,
      budgetWindow: "month",
      enabled: false,
    });
    expect(patched).toMatchObject({
      label: "Carol Ops",
      hardCostUsd: 2.5,
      budgetWindow: "month",
      enabled: false,
    });
  });

  it("evaluates per-principal budgets from ledger rows", () => {
    const { principal } = createAccessPrincipal({
      label: "Dev",
      budget: { hardTokens: 100, window: "day" },
    });
    principal.hardTokens = 100;
    const over = evaluatePrincipalBudget(principal, [
      {
        accessTokenId: principal.id,
        totalTokens: 150,
        costUsd: 0,
        ts: new Date().toISOString(),
      },
    ]);
    expect(over.blocked).toBe(true);
    expect(over.hardReasons).toContain("hard_tokens_exceeded");
  });

  it("normalizes hash maps strictly", () => {
    expect(normalizeAccessTokenHashes({
      ok: "a".repeat(64),
      bad: "xyz",
      "Not Id": "b".repeat(64),
    })).toEqual({ ok: "a".repeat(64) });
  });

  it("mints unique plain tokens", () => {
    const a = mintAccessTokenPlain();
    const b = mintAccessTokenPlain();
    expect(a).not.toBe(b);
    expect(isAccessTokenFormat(a)).toBe(true);
  });
});
