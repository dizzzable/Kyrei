import { describe, expect, it } from "vitest";
import {
  EXPERIMENTAL_ACCEPT_PHRASE,
  acceptExperimentalDisclaimer,
} from "../core/experimental-features.js";
import {
  bindBrowserSubscriptionToken,
  isBrowserSubscriptionAllowed,
  linkBrowserSubscriptionProvider,
  resolveBrowserSubscriptionCredentials,
  revokeBrowserSubscriptionSession,
  startBrowserSubscriptionSession,
} from "../core/browser-subscription-auth.js";

function unlockedConfig(features = { browserSubscriptionAuth: true }) {
  const experimental = acceptExperimentalDisclaimer(
    { features },
    { acceptPhrase: EXPERIMENTAL_ACCEPT_PHRASE },
  );
  return {
    experimental,
    accessControl: { requireToken: false },
    browserSubscription: { sessions: [] },
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        protocol: "openai-responses",
        baseURL: "https://api.openai.com/v1",
        models: [{ id: "gpt-4.1", name: "gpt-4.1" }],
        enabled: true,
        requiresApiKey: true,
        credentialSource: "api-key",
      },
    ],
  };
}

describe("browser subscription auth scaffold", () => {
  it("blocks start when experimental feature is off", async () => {
    await expect(startBrowserSubscriptionSession({}, {}, { vendorId: "openai-chatgpt" }))
      .rejects.toMatchObject({ code: "browser_subscription_feature_disabled" });
  });

  it("starts a pending session, binds token, links provider, resolves credentials", async () => {
    let config = unlockedConfig();
    expect(isBrowserSubscriptionAllowed(config)).toBe(true);

    const started = await startBrowserSubscriptionSession(config, {}, {
      vendorId: "openai-chatgpt",
      label: "Work seat",
    });
    expect(started.session.status).toBe("pending_token");
    expect(started.nextStep).toBe("paste_access_token");
    config = { ...config, browserSubscription: started.config };

    const bound = bindBrowserSubscriptionToken(config, { browserSubscription: started.secrets }, {
      sessionId: started.session.id,
      accessToken: "sk-test-subscription-token",
    });
    expect(bound.session.status).toBe("ready");
    config = { ...config, browserSubscription: bound.config };
    const secrets = { browserSubscription: bound.secrets };

    const linked = linkBrowserSubscriptionProvider(config, started.session.id, "openai");
    config = {
      ...config,
      browserSubscription: linked,
      providers: config.providers.map((provider) => (
        provider.id === "openai"
          ? {
              ...provider,
              credentialSource: "browser-subscription",
              browserSubscriptionSessionId: started.session.id,
            }
          : provider
      )),
    };

    const resolved = resolveBrowserSubscriptionCredentials(
      config,
      secrets,
      config.providers[0],
    );
    expect(resolved).toEqual({
      apiKey: "sk-test-subscription-token",
      sessionId: started.session.id,
    });

    const revoked = revokeBrowserSubscriptionSession(config, secrets, started.session.id);
    expect(revoked.session?.status).toBe("revoked");
    expect(resolveBrowserSubscriptionCredentials(
      { ...config, browserSubscription: revoked.config },
      { browserSubscription: revoked.secrets },
      config.providers[0],
    )).toBeNull();
  });
});
