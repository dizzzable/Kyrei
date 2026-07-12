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
  const base: PermissionConfig = { terminal: "auto", review: "agent", rules: [] };
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
    const cfg: PermissionConfig = { ...base, rules: [{ pattern: "secret", action: "deny" }] };
    expect(decide(cfg, { tool: "read_file", command: undefined })).toBe("allow");
    expect(decide(cfg, { tool: "run_command", command: "cat secret.txt" })).toBe("deny");
  });
  it("review=always gates writes", () => {
    const cfg: PermissionConfig = { ...base, review: "always" };
    expect(decide(cfg, { tool: "write_file" })).toBe("ask");
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
    const r = await runPreHooks([secretScanHook], { tool: "write_file", args: { path: "x", content: "hello" } });
    expect(r.allow).toBe(true);
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
    await log.write({ ts: new Date().toISOString(), tool: "run_command", args: { command: "echo sk-ABCDEFGHIJKLMNOPQRSTUVWX" }, status: "start" });
    const raw = await readFile(join(dir, "audit.jsonl"), "utf8");
    expect(raw).toContain("[REDACTED]");
    expect(raw).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect((await log.read()).length).toBe(1);
  });
});
