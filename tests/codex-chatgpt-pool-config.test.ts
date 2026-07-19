import { describe, expect, it } from "vitest";

import {
  codexChatgptRouterPool,
  normalizeCodexChatgptPool,
  validateNewCodexChatgptPoolAccount,
} from "../core/codex-chatgpt-pool-config.js";

describe("Codex ChatGPT managed pool config", () => {
  it("keeps only public routing metadata and defaults new profiles to sign-in required", () => {
    const account = validateNewCodexChatgptPoolAccount({
      id: "owner-01",
      name: "Owner Plus",
      weight: 3,
      priority: 5,
    }, { accounts: [] });

    expect(account).toMatchObject({
      id: "owner-01",
      name: "Owner Plus",
      status: "auth-required",
      maxConcurrency: 1,
    });
    expect(JSON.stringify(account)).not.toMatch(/token|cookie|password|secret/i);

    const pool = normalizeCodexChatgptPool({ enabled: true, strategy: "least-used", accounts: [account] });
    expect(codexChatgptRouterPool(pool)).toEqual(expect.objectContaining({
      enabled: true,
      strategy: "least-used",
      members: [expect.objectContaining({ id: "owner-01", maxConcurrency: 1, status: "auth-required" })],
    }));
  });

  it("does not turn malformed ids into filesystem-addressable profiles", () => {
    expect(() => validateNewCodexChatgptPoolAccount({ id: "../outside", name: "Unsafe" }, { accounts: [] }))
      .toThrow("codex_chatgpt_pool_account_id_invalid");
    expect(normalizeCodexChatgptPool({
      enabled: true,
      accounts: [{ id: "../outside", name: "Unsafe" }],
    }).accounts).toEqual([]);
  });
});
