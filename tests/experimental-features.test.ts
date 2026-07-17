import { describe, expect, it } from "vitest";
import {
  EXPERIMENTAL_ACCEPT_PHRASE,
  EXPERIMENTAL_DISCLAIMER_VERSION,
  acceptExperimentalDisclaimer,
  assertExperimentalFeatureEnabled,
  isExperimentalFeatureEnabled,
  normalizeExperimentalConfig,
  revokeExperimentalDisclaimer,
} from "../core/experimental-features.js";

describe("experimental feature gate", () => {
  it("defaults sealed with no features on", () => {
    expect(normalizeExperimentalConfig(undefined)).toMatchObject({
      unlocked: false,
      companyLocked: false,
      disclaimerVersion: EXPERIMENTAL_DISCLAIMER_VERSION,
      features: { browserSubscriptionAuth: false },
    });
  });

  it("ignores unlocked without current disclaimer acceptance", () => {
    expect(normalizeExperimentalConfig({
      unlocked: true,
      features: { browserSubscriptionAuth: true },
    }).unlocked).toBe(false);
    expect(normalizeExperimentalConfig({
      unlocked: true,
      acceptedAt: "2026-01-01T00:00:00.000Z",
      acceptedDisclaimerVersion: "old",
      features: { browserSubscriptionAuth: true },
    }).features.browserSubscriptionAuth).toBe(false);
  });

  it("accepts only with exact phrase and unlocks features when requested", () => {
    expect(() => acceptExperimentalDisclaimer({}, { acceptPhrase: "yes" }))
      .toThrowError(/experimental_accept_phrase_mismatch/);

    const accepted = acceptExperimentalDisclaimer(
      { features: { browserSubscriptionAuth: true } },
      {
        acceptPhrase: EXPERIMENTAL_ACCEPT_PHRASE,
        now: () => new Date("2026-07-17T12:00:00.000Z"),
      },
    );
    expect(accepted).toMatchObject({
      unlocked: true,
      acceptedAt: "2026-07-17T12:00:00.000Z",
      acceptedDisclaimerVersion: EXPERIMENTAL_DISCLAIMER_VERSION,
      features: { browserSubscriptionAuth: true },
    });
    expect(isExperimentalFeatureEnabled({ experimental: accepted }, "browserSubscriptionAuth")).toBe(true);
  });

  it("revokes cleanly", () => {
    const accepted = acceptExperimentalDisclaimer(
      { features: { browserSubscriptionAuth: true } },
      { acceptPhrase: EXPERIMENTAL_ACCEPT_PHRASE },
    );
    const revoked = revokeExperimentalDisclaimer(accepted);
    expect(revoked.unlocked).toBe(false);
    expect(revoked.features.browserSubscriptionAuth).toBe(false);
    expect(isExperimentalFeatureEnabled({ experimental: revoked }, "browserSubscriptionAuth")).toBe(false);
  });

  it("company mode seals everything", () => {
    const accepted = acceptExperimentalDisclaimer(
      { features: { browserSubscriptionAuth: true } },
      { acceptPhrase: EXPERIMENTAL_ACCEPT_PHRASE },
    );
    const locked = normalizeExperimentalConfig(accepted, { companyLocked: true });
    expect(locked).toMatchObject({
      unlocked: false,
      companyLocked: true,
      features: { browserSubscriptionAuth: false },
    });
    expect(isExperimentalFeatureEnabled(
      { experimental: accepted, accessControl: { requireToken: true } },
      "browserSubscriptionAuth",
    )).toBe(false);
  });

  it("assert throws when disabled", () => {
    expect(() => assertExperimentalFeatureEnabled({}, "browserSubscriptionAuth"))
      .toThrowError(/experimental_feature_disabled/);
  });
});
