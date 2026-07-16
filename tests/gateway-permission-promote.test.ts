import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";
import { permissionRuleFromApproval } from "../core/permission-promote.js";

/**
 * Gateway-level promote is exercised via pure builders + config merge path.
 * Full approval card HTTP always-allow needs a live pending approval HMAC;
 * here we assert the contract that Absolute-path Always allow never broadens.
 */
describe("permission promote safety (gateway-facing contract)", () => {
  it("never promotes tool-wide allow for absolute write paths", () => {
    expect(permissionRuleFromApproval("write_file", { path: "C:\\Users\\x\\a.ts" }, "allow")).toBeNull();
    expect(permissionRuleFromApproval("run_command", { command: "" }, "allow")).toBeNull();
    const deny = permissionRuleFromApproval("write_file", { path: "C:\\Users\\x\\a.ts" }, "deny");
    expect(deny?.action).toBe("deny");
  });

  it("promotes exact relative path and command", () => {
    const pathRule = permissionRuleFromApproval("write_file", { path: "src/app.ts" }, "allow");
    expect(pathRule?.action).toBe("allow");
    expect(pathRule?.pattern).toMatch(/write_file/);
    const cmd = permissionRuleFromApproval("run_command", { command: "npm test" }, "allow");
    expect(cmd?.pattern).toContain("npm test");
  });
});

describe("gateway config accepts promoted rule shape", () => {
  let dataDir = "";
  let server: { port: number; token: string; close(): Promise<void> | void } | null = null;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "kyrei-promote-gw-"));
    server = await startGateway({
      dataDir,
      preferredPort: 0,
      engineLoader: vi.fn(async () => ({ runKyreiChat: vi.fn() })),
    }) as typeof server;
  });

  afterEach(async () => {
    try {
      await server?.close();
    } catch {
      /* ignore */
    }
    server = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await rm(dataDir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 7) throw error;
        await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
      }
    }
  });

  it("persists exact permission rules via engine config PUT", async () => {
    if (!server) throw new Error("no server");
    const rule = permissionRuleFromApproval("run_command", { command: "echo hi" }, "allow");
    expect(rule).toBeTruthy();
    const get = await fetch(`http://127.0.0.1:${server.port}/api/config`, {
      headers: { "X-Kyrei-Gateway-Token": server.token },
    });
    const cfg = await get.json() as { engine?: { permissions?: { rules?: unknown[] } } };
    const engine = { ...(cfg.engine ?? {}), permissions: {
      ...(typeof cfg.engine?.permissions === "object" ? cfg.engine.permissions : {}),
      rules: [rule],
    } };
    const put = await fetch(`http://127.0.0.1:${server.port}/api/config`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Kyrei-Gateway-Token": server.token,
      },
      body: JSON.stringify({ engine }),
    });
    expect(put.ok).toBe(true);
    const after = await fetch(`http://127.0.0.1:${server.port}/api/config`, {
      headers: { "X-Kyrei-Gateway-Token": server.token },
    });
    const body = await after.json() as { engine?: { permissions?: { rules?: Array<{ pattern: string; action: string }> } } };
    const rules = body.engine?.permissions?.rules ?? [];
    expect(rules.some((r) => r.action === "allow" && r.pattern.includes("echo hi"))).toBe(true);
  });
});
