import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexChatgptProfileStore } from "../core/codex-chatgpt-profile-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex ChatGPT profile store", () => {
  it("creates and removes only a validated Kyrei-owned CODEX_HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "kyrei-codex-profiles-"));
    roots.push(root);
    const connector = {
      status: vi.fn(),
      startLogin: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const connectorFactory = vi.fn(() => connector);
    const store = new CodexChatgptProfileStore({ homeRoot: root, connectorFactory });

    const home = await store.ensureProfile("owner-plus");
    // macOS often resolves /var/folders → /private/var/folders via realpath.
    expect(home).toBe(join(await realpath(root), "owner-plus"));
    await expect(readFile(join(home, "config.toml"), "utf8"))
      .resolves.toBe('cli_auth_credentials_store = "file"\n');

    await expect(store.connectorFor("owner-plus")).resolves.toBe(connector);
    expect(connectorFactory).toHaveBeenCalledWith({ accountId: "owner-plus", codexHome: home });
    expect(() => store.profilePath("../outside")).toThrow("codex_chatgpt_pool_account_id_invalid");

    await store.removeProfile("owner-plus");
    expect(connector.close).toHaveBeenCalledOnce();
    await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(root)).resolves.toBeUndefined();
  });
});
