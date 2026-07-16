import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safePath } from "./jail.js";
import { decide } from "./permissions.js";
import { secretScanHook, runPreHooks } from "./pre-hook.js";
import { createAuditLog } from "./audit.js";
import type { PermissionConfig } from "../types.js";

const WS = process.platform === "win32" ? "F:\\ws" : "/ws";

describe("jail hardening (Property 12)", () => {
  it("rejects Windows escape vectors", () => {
    expect(() => safePath(WS, "C:relative")).toThrow();
    expect(() => safePath(WS, "\\\\server\\share")).toThrow();
    expect(() => safePath(WS, "\\\\?\\C:\\x")).toThrow();
    expect(() => safePath(WS, "../out")).toThrow();
  });
  it("allows nested paths", () => {
    expect(() => safePath(WS, "src/a.ts")).not.toThrow();
  });
});

describe("permissions engine (deny-wins, two-axis)", () => {
  const base: PermissionConfig = {
    terminal: "auto",
    web: "read",
    review: "agent",
    rules: [],
  };
  it("terminal=off requires an explicit allow rule", () => {
    const off: PermissionConfig = { ...base, terminal: "off" };
    expect(decide(off, { tool: "run_command", command: "npm test" })).toBe("ask");
    expect(decide({ ...off, rules: [{ pattern: "npm test", action: "allow" }] }, { tool: "run_command", command: "npm test" })).toBe("allow");
  });
  it("auto gates destructive + network commands", () => {
    expect(decide(base, { tool: "run_command", command: "ls" })).toBe("allow");
    expect(decide(base, { tool: "run_command", command: "rm -rf /" })).toBe("ask");
    expect(decide(base, { tool: "run_command", command: "curl http://x" })).toBe("ask");
  });
  it("turbo still gates destructive", () => {
    const turbo: PermissionConfig = { ...base, terminal: "turbo" };
    expect(decide(turbo, { tool: "run_command", command: "npm run build" })).toBe("allow");
    expect(decide(turbo, { tool: "run_command", command: "rm -rf ." })).toBe("ask");
  });
  it("deny rule wins", () => {
    const cfg: PermissionConfig = {
      ...base,
      rules: [{ pattern: "secret", action: "deny" }],
    };
    expect(decide(cfg, { tool: "read_file", command: undefined })).toBe("allow");
    expect(decide(cfg, { tool: "run_command", command: "cat secret.txt" })).toBe("deny");
  });
  it("chooses deny over ask over allow when rules overlap", () => {
    const action = { tool: "run_command", command: "npm run release" };
    expect(
      decide(
        {
          ...base,
          rules: [
            { pattern: "npm", action: "allow" },
            { pattern: "release", action: "ask" },
          ],
        },
        action,
      ),
    ).toBe("ask");
    expect(
      decide(
        {
          ...base,
          rules: [
            { pattern: "npm", action: "allow" },
            { pattern: "release", action: "ask" },
            { pattern: "run_command", action: "deny" },
          ],
        },
        action,
      ),
    ).toBe("deny");
  });
  it("review=always gates writes", () => {
    const cfg: PermissionConfig = { ...base, review: "always" };
    expect(decide(cfg, { tool: "write_file" })).toBe("ask");
    expect(
      decide(
        { ...cfg, rules: [{ pattern: "^write_file:src/a\\.ts$", action: "allow" }] },
        { tool: "write_file", target: "src/a.ts" },
      ),
    ).toBe("ask");
  });
  it("review=agent permits writes but path rules still gate exact targets", () => {
    expect(decide(base, { tool: "write_file", target: "src/a.ts" })).toBe("allow");
    const cfg: PermissionConfig = {
      ...base,
      rules: [
        { pattern: "a\\.ts$", action: "ask" },
        { pattern: "private", action: "deny" },
      ],
    };
    expect(decide(cfg, { tool: "write_file", target: "src/a.ts" })).toBe("ask");
    expect(decide(cfg, { tool: "write_file", target: "private/a.ts" })).toBe("deny");
  });
  if (process.platform === "win32") {
    it("matches permission rules case-insensitively on case-insensitive Windows paths", () => {
      const cfg: PermissionConfig = {
        ...base,
        rules: [{ pattern: "^write_file:src/a\\.ts$", action: "deny" }],
      };
      expect(decide(cfg, { tool: "write_file", target: "SRC/A.TS" })).toBe("deny");
    });
  }
  it("web capability is independently scoped", () => {
    expect(decide(base, { tool: "web_search", target: "framework docs" })).toBe("allow");
    expect(decide({ ...base, web: "search" }, { tool: "web_fetch", target: "https://example.com" })).toBe("deny");
    expect(decide({ ...base, web: "off" }, { tool: "web_search", target: "framework docs" })).toBe("deny");
  });
  it("protected paths ask unless session allow-once listed", () => {
    const cfg: PermissionConfig = {
      ...base,
      protectedPaths: ["mcp.json", ".env"],
    };
    expect(decide(cfg, { tool: "write_file", target: "project/mcp.json" })).toBe("ask");
    expect(decide(cfg, { tool: "edit_file", target: ".env" })).toBe("ask");
    const once: PermissionConfig = {
      ...cfg,
      protectedPathAllowOnce: ["project/mcp.json"],
    };
    expect(decide(once, { tool: "write_file", target: "project/mcp.json" })).toBe("allow");
    expect(decide(once, { tool: "write_file", target: ".env" })).toBe("ask");
  });
});

describe("pre-hook secret scan", () => {
  it("blocks writing content with a secret", async () => {
    const r = await runPreHooks([secretScanHook], {
      tool: "write_file",
      args: { path: "x", content: "key = sk-ABCDEFGHIJKLMNOPQRSTUVWX" },
    });
    expect(r.allow).toBe(false);
  });
  it("allows clean content", async () => {
    const r = await runPreHooks([secretScanHook], {
      tool: "write_file",
      args: { path: "x", content: "hello" },
    });
    expect(r.allow).toBe(true);
  });
  it("fails closed when a hook throws", async () => {
    const r = await runPreHooks(
      [
        () => {
          throw new Error("scanner unavailable");
        },
      ],
      { tool: "write_file", args: {} },
      true,
    );
    expect(r).toEqual({
      allow: false,
      reason: "pre-hook error: scanner unavailable",
    });
  });
});

describe("audit log (redaction)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kyrei-audit-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it("writes redacted records", async () => {
    const log = createAuditLog(join(dir, "audit.jsonl"));
    await log.write({
      ts: new Date().toISOString(),
      tool: "run_command",
      args: { command: "echo sk-ABCDEFGHIJKLMNOPQRSTUVWX" },
      status: "start",
    });
    const raw = await readFile(join(dir, "audit.jsonl"), "utf8");
    expect(raw).toContain("[REDACTED]");
    expect(raw).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect((await log.read()).length).toBe(1);
  });
  it("preserves session and tool-call correlation", async () => {
    const log = createAuditLog(join(dir, "correlated.jsonl"));
    await log.write({
      ts: new Date().toISOString(),
      sessionId: "s1",
      toolCallId: "c1",
      tool: "write_file",
      metadata: { path: "src/a.ts" },
      status: "complete",
    });
    expect(await log.read()).toMatchObject([{ sessionId: "s1", toolCallId: "c1", metadata: { path: "src/a.ts" } }]);
  });
});
