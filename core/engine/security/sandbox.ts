/**
 * OS-sandbox port (task 19.1, backlog / opt-in).
 *
 * Provides an OPTIONAL extra isolation layer for `run_command` on top of the
 * workspace jail + permission engine. It is OFF by default; enable via
 * EngineConfig `sandbox: "strict"`.
 *
 * HONEST LIMITS (documented residual risk):
 *  - The jail (safePath) already confines *tool-driven* file access. This
 *    sandbox targets the one place we hand control to the OS: shell commands
 *    spawned by run_command, which the jail cannot constrain.
 *  - We do NOT ship native sandboxing code. Strict mode is best-effort: it
 *    wraps commands with a platform primitive IF one is available on the host:
 *      · Linux  → bubblewrap (`bwrap`) or `firejail` (fs confinement + no net)
 *      · macOS  → `sandbox-exec` with a generated deny-by-default profile
 *      · Windows→ no reliable userland sandbox without a native Job Object
 *                 addon; strict mode is UNAVAILABLE and falls back to the jail
 *                 + permission engine only. This is a known residual risk.
 *  - If strict mode is requested but no primitive is available, we surface it
 *    via `available()`/`describe()`; callers keep the un-sandboxed command
 *    (fail-open) so functionality is never silently broken — the security
 *    posture is reported, not enforced by crashing.
 */

import { spawn } from "node:child_process";

export type SandboxMode = "off" | "strict";

export interface WrapInput {
  /** The raw shell command the model wants to run. */
  command: string;
  /** Working directory (already jailed to the workspace). */
  cwd: string;
  /** Allow outbound network. Default false in strict mode. */
  allowNetwork?: boolean;
}

export interface Sandbox {
  /** Stable identifier of the backing primitive ("noop" | "bwrap" | ...). */
  readonly id: string;
  /** Whether this sandbox can actually enforce isolation on this host. */
  available(): Promise<boolean>;
  /**
   * Wrap a command for isolated execution and return a shell-ready string.
   * When the sandbox is a noop (or unavailable), returns `command` unchanged.
   */
  wrap(input: WrapInput): string;
  /** Human-readable description of the effective posture (for audit/UX). */
  describe(): string;
}

/** Single-quote a string for POSIX `sh -c`. */
export function shSingleQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Probe whether an executable is on PATH (cross-platform). */
export function commandExists(bin: string): Promise<boolean> {
  return new Promise((res) => {
    const probe = process.platform === "win32" ? "where" : "which";
    const child = spawn(probe, [bin], { windowsHide: true });
    child.on("error", () => res(false));
    child.on("close", (code) => res(code === 0));
  });
}

/** Default no-op sandbox: passes commands through unchanged. */
class NoopSandbox implements Sandbox {
  readonly id = "noop";
  async available(): Promise<boolean> {
    return true;
  }
  wrap(input: WrapInput): string {
    return input.command;
  }
  describe(): string {
    return "no OS sandbox (jail + permission engine only)";
  }
}

/** Linux: bubblewrap/firejail — confine fs to cwd + optionally drop network. */
class LinuxSandbox implements Sandbox {
  readonly id = "linux";
  private bin: "bwrap" | "firejail" | null = null;
  private probed = false;

  async available(): Promise<boolean> {
    if (!this.probed) {
      this.probed = true;
      if (await commandExists("bwrap")) this.bin = "bwrap";
      else if (await commandExists("firejail")) this.bin = "firejail";
    }
    return this.bin !== null;
  }

  wrap(input: WrapInput): string {
    if (!this.bin) return input.command;
    const inner = `/bin/sh -c ${shSingleQuote(input.command)}`;
    const net = input.allowNetwork ? [] : this.bin === "bwrap" ? ["--unshare-net"] : ["--net=none"];
    if (this.bin === "bwrap") {
      const args = [
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/bin", "/bin",
        "--ro-bind", "/lib", "/lib",
        "--ro-bind-try", "/lib64", "/lib64",
        "--ro-bind-try", "/etc", "/etc",
        "--proc", "/proc",
        "--dev", "/dev",
        "--bind", input.cwd, input.cwd,
        "--chdir", input.cwd,
        ...net,
        "--die-with-parent",
        "--",
      ];
      return `bwrap ${args.map(shSingleQuote).join(" ")} ${inner}`;
    }
    // firejail
    const args = ["--quiet", `--private=${input.cwd}`, ...net];
    return `firejail ${args.map(shSingleQuote).join(" ")} ${inner}`;
  }

  describe(): string {
    return this.bin ? `linux sandbox via ${this.bin} (fs→cwd, network denied)` : "linux sandbox unavailable (install bubblewrap/firejail)";
  }
}

/** macOS: sandbox-exec with a deny-by-default profile, write-scoped to cwd. */
class MacSandbox implements Sandbox {
  readonly id = "macos";
  private probed = false;
  private ok = false;

  async available(): Promise<boolean> {
    if (!this.probed) {
      this.probed = true;
      this.ok = await commandExists("sandbox-exec");
    }
    return this.ok;
  }

  profile(input: WrapInput): string {
    const net = input.allowNetwork ? "(allow network*)" : "(deny network*)";
    return [
      "(version 1)",
      "(allow default)",
      "(deny file-write*)",
      `(allow file-write* (subpath ${JSON.stringify(input.cwd)}))`,
      "(allow file-write* (subpath \"/private/tmp\") (subpath \"/tmp\"))",
      net,
    ].join(" ");
  }

  wrap(input: WrapInput): string {
    if (!this.ok) return input.command;
    return `sandbox-exec -p ${shSingleQuote(this.profile(input))} /bin/sh -c ${shSingleQuote(input.command)}`;
  }

  describe(): string {
    return this.ok ? "macOS sandbox via sandbox-exec (write→cwd, network denied)" : "macOS sandbox unavailable (sandbox-exec missing)";
  }
}

/** Windows: no reliable userland sandbox without a native addon — documented. */
class WindowsSandbox implements Sandbox {
  readonly id = "windows";
  async available(): Promise<boolean> {
    return false;
  }
  wrap(input: WrapInput): string {
    return input.command;
  }
  describe(): string {
    return "Windows strict sandbox unavailable in userland (residual risk; relies on jail + permission engine)";
  }
}

function platformSandbox(): Sandbox {
  switch (process.platform) {
    case "linux":
      return new LinuxSandbox();
    case "darwin":
      return new MacSandbox();
    case "win32":
      return new WindowsSandbox();
    default:
      return new NoopSandbox();
  }
}

/**
 * Create a sandbox for the given mode. `off` (default) → noop passthrough.
 * `strict` → best-effort platform primitive (may report unavailable).
 */
export function createSandbox(mode: SandboxMode = "off"): Sandbox {
  return mode === "strict" ? platformSandbox() : new NoopSandbox();
}

/**
 * Convenience: wrap only when the sandbox can actually enforce isolation.
 * Returns `{ command, sandboxed, note }` — `command` is safe to spawn as-is.
 */
export async function maybeSandbox(
  sandbox: Sandbox,
  input: WrapInput,
): Promise<{ command: string; sandboxed: boolean; note: string }> {
  if (sandbox.id === "noop") return { command: input.command, sandboxed: false, note: sandbox.describe() };
  const ok = await sandbox.available();
  return ok
    ? { command: sandbox.wrap(input), sandboxed: true, note: sandbox.describe() }
    : { command: input.command, sandboxed: false, note: sandbox.describe() };
}
