import { describe, it, expect } from "vitest";
import {
  SandboxUnavailableError,
  createSandbox,
  maybeSandbox,
  shSingleQuote,
  commandExists,
} from "./sandbox.js";

describe("sandbox port (task 19.1)", () => {
  it("shSingleQuote escapes embedded single quotes for sh -c", () => {
    expect(shSingleQuote("echo hi")).toBe("'echo hi'");
    expect(shSingleQuote("it's")).toBe(`'it'\\''s'`);
    expect(shSingleQuote("rm -rf 'x'")).toBe(`'rm -rf '\\''x'\\'''`);
  });

  it("off mode is a noop passthrough (default)", async () => {
    const sb = createSandbox("off");
    expect(sb.id).toBe("noop");
    expect(sb.wrap({ command: "ls -la", cwd: "/w" })).toBe("ls -la");
    const r = await maybeSandbox(sb, { command: "ls -la", cwd: "/w" });
    expect(r).toEqual({ command: "ls -la", sandboxed: false, note: sb.describe() });
  });

  it("default createSandbox() is off", async () => {
    expect(createSandbox().id).toBe("noop");
    expect(await createSandbox().available()).toBe(true);
  });

  it("strict mode selects a platform sandbox with a stable id", () => {
    const sb = createSandbox("strict");
    expect(["linux", "macos", "windows", "noop"]).toContain(sb.id);
    expect(sb.describe()).toBeTypeOf("string");
    expect(sb.describe().length).toBeGreaterThan(0);
  });

  it("strict-required fails closed when the host primitive is unavailable", async () => {
    const unavailable = {
      id: "test-unavailable",
      available: async () => false,
      wrap: ({ command }: { command: string }) => command,
      describe: () => "test sandbox unavailable",
    };
    await expect(maybeSandbox(
      unavailable,
      { command: "echo must-not-run", cwd: process.cwd() },
      { required: true },
    )).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("strict-required uses the platform primitive when available", () => {
    const required = createSandbox("strict-required");
    expect(required.id).toBe(createSandbox("strict").id);
    expect(required.required).toBe(true);
  });

  it("binds fail-closed behavior to the strict-required sandbox instance", async () => {
    const required = createSandbox("strict-required");
    if (await required.available()) return;
    await expect(maybeSandbox(required, { command: "echo blocked", cwd: process.cwd() }))
      .rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("never breaks the command: when unavailable, maybeSandbox returns it unchanged (fail-open)", async () => {
    const sb = createSandbox("strict");
    const r = await maybeSandbox(sb, { command: "echo hello", cwd: process.cwd() });
    if (!r.sandboxed) expect(r.command).toBe("echo hello");
    else expect(r.command).toContain("echo hello"); // wrapped, original preserved inside
  });

  it("Windows strict mode is honestly unavailable (documented residual risk)", async () => {
    if (process.platform !== "win32") return;
    const sb = createSandbox("strict");
    expect(sb.id).toBe("windows");
    expect(await sb.available()).toBe(false);
    expect(sb.wrap({ command: "dir", cwd: "C:\\w" })).toBe("dir");
    expect(sb.describe().toLowerCase()).toContain("residual risk");
  });

  it("commandExists probes PATH", async () => {
    expect(await commandExists("node")).toBe(true);
    expect(await commandExists("definitely-not-a-real-binary-xyz")).toBe(false);
  });
});
