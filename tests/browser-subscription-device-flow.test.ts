import { describe, expect, it, vi } from "vitest";
import {
  assertHttpsEndpoint,
  isAllowedExperimentalAuthOpenUrl,
  normalizeDeviceFlowRegistration,
  pollDeviceToken,
  requestDeviceAuthorization,
} from "../core/browser-subscription-device-flow.js";
import {
  EXPERIMENTAL_ACCEPT_PHRASE,
  acceptExperimentalDisclaimer,
} from "../core/experimental-features.js";
import {
  pollBrowserSubscriptionDeviceSession,
  startBrowserSubscriptionSession,
} from "../core/browser-subscription-auth.js";

function unlockedConfig() {
  return {
    experimental: acceptExperimentalDisclaimer(
      { features: { browserSubscriptionAuth: true } },
      { acceptPhrase: EXPERIMENTAL_ACCEPT_PHRASE },
    ),
    accessControl: { requireToken: false },
    browserSubscription: { sessions: [] },
    providers: [],
  };
}

describe("device flow helpers", () => {
  it("rejects non-https and private endpoints", () => {
    expect(() => assertHttpsEndpoint("http://example.com/x")).toThrow();
    expect(() => assertHttpsEndpoint("https://127.0.0.1/x")).toThrow();
    expect(assertHttpsEndpoint("https://auth.example.com/device")).toContain("https://");
  });

  it("requests device authorization and polls until ready", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      if (String(url).includes("/device")) {
        expect(body).toContain("client_id=my-client");
        expect(body).toContain("client_secret=sekrit");
        expect(body).toContain("scope=openid");
        return new Response(JSON.stringify({
          device_code: "dev-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.example.com/device",
          verification_uri_complete: "https://auth.example.com/device?user_code=ABCD-EFGH",
          expires_in: 600,
          interval: 5,
        }), { status: 200 });
      }
      if (body.includes("dev-code")) {
        return new Response(JSON.stringify({
          access_token: "tok-abc",
          refresh_token: "ref-xyz",
          expires_in: 3600,
        }), { status: 200 });
      }
      return new Response("{}", { status: 400 });
    });

    const reg = normalizeDeviceFlowRegistration({
      clientId: "my-client",
      deviceAuthorizationEndpoint: "https://auth.example.com/device",
      tokenEndpoint: "https://auth.example.com/token",
      scope: "openid",
      clientSecret: "sekrit",
    });
    const started = await requestDeviceAuthorization(reg, fetchImpl as typeof fetch);
    expect(started.userCode).toBe("ABCD-EFGH");
    const polled = await pollDeviceToken(reg, started.deviceCode, fetchImpl as typeof fetch);
    expect(polled).toMatchObject({ status: "ready", accessToken: "tok-abc" });
  });

  it("allowlists verification hosts for openExternal", () => {
    expect(isAllowedExperimentalAuthOpenUrl("https://auth.openai.com/authorize")).toBe(true);
    expect(isAllowedExperimentalAuthOpenUrl("https://evil.example/phish")).toBe(false);
    expect(isAllowedExperimentalAuthOpenUrl("https://evil.example/x", {
      sessionVerificationUri: "https://evil.example/x",
    })).toBe(true);
  });
});

describe("device flow profiles", () => {
  it("saves a profile and starts device session from profileId", async () => {
    const {
      upsertBrowserSubscriptionDeviceProfile,
      startBrowserSubscriptionSession,
    } = await import("../core/browser-subscription-auth.js");
    let config = unlockedConfig();
    const saved = upsertBrowserSubscriptionDeviceProfile(config, {}, {
      label: "Work",
      vendorId: "custom-openai-compatible",
      clientId: "saved-client",
      deviceAuthorizationEndpoint: "https://auth.example.com/device",
      tokenEndpoint: "https://auth.example.com/token",
      scope: "openid",
      clientSecret: "sekrit",
    });
    expect(saved.profile).toMatchObject({
      label: "Work",
      clientId: "saved-client",
      hasClientSecret: true,
    });
    config = { ...config, browserSubscription: saved.config };
    const secrets = { browserSubscription: saved.secrets };

    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/device")) {
        return new Response(JSON.stringify({
          device_code: "from-profile",
          user_code: "PROF-0001",
          verification_uri: "https://auth.example.com/verify",
          expires_in: 300,
          interval: 5,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
    });

    const started = await startBrowserSubscriptionSession(
      config,
      secrets,
      {
        vendorId: "custom-openai-compatible",
        flow: "device",
        profileId: saved.profile.id,
      },
      { fetch: fetchImpl as typeof fetch },
    );
    expect(started.session.userCode).toBe("PROF-0001");
    expect(started.secrets.sessions[started.session.id]?.clientId).toBe("saved-client");
    expect(started.secrets.sessions[started.session.id]?.clientSecret).toBe("sekrit");
    expect(started.config.profiles.some((p: { id: string }) => p.id === saved.profile.id)).toBe(true);
  });
});

describe("device flow session integration", () => {
  it("starts device session and completes on poll", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/device")) {
        return new Response(JSON.stringify({
          device_code: "dc-1",
          user_code: "WXYZ-1234",
          verification_uri: "https://auth.example.com/verify",
          expires_in: 300,
          interval: 3,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ access_token: "live-token" }), { status: 200 });
    });

    let config = unlockedConfig();
    const started = await startBrowserSubscriptionSession(
      config,
      {},
      {
        vendorId: "custom-openai-compatible",
        flow: "device",
        deviceFlow: {
          clientId: "cli",
          deviceAuthorizationEndpoint: "https://auth.example.com/device",
          tokenEndpoint: "https://auth.example.com/token",
        },
      },
      { fetch: fetchImpl as typeof fetch },
    );
    expect(started.session).toMatchObject({
      status: "awaiting_browser",
      flow: "device",
      userCode: "WXYZ-1234",
    });
    expect(started.nextStep).toBe("open_verification_uri");

    config = { ...config, browserSubscription: started.config };
    const secrets = { browserSubscription: started.secrets };
    const polled = await pollBrowserSubscriptionDeviceSession(
      config,
      secrets,
      started.session.id,
      { fetch: fetchImpl as typeof fetch },
    );
    expect(polled.pollStatus).toBe("ready");
    expect(polled.session.status).toBe("ready");
    expect(polled.secrets.sessions[started.session.id]?.accessToken).toBe("live-token");
  });
});
