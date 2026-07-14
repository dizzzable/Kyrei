import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  KiroOrganizationWorker,
  KiroOrganizationWorkerError,
} from "../core/kiro-organization-worker.js";

const WINDOWS = process.platform === "win32";
const EXECUTABLE = WINDOWS ? "C:\\Tools\\kiro-cli.exe" : "/opt/kiro/bin/kiro-cli";
const HOME_ROOT = WINDOWS ? "C:\\KyreiData\\kiro-organizations" : "/var/lib/kyrei/kiro-organizations";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);

  complete(code = 0, stdout = "", stderr = "") {
    if (stdout) this.stdout.write(stdout);
    if (stderr) this.stderr.write(stderr);
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, null);
  }

  exit(code = null) {
    this.emit("exit", code, "SIGKILL");
  }
}

function completedChild(stdout = "", code = 0, stderr = "") {
  const child = new FakeChild();
  queueMicrotask(() => child.complete(code, stdout, stderr));
  return child;
}

function fakeClock(start = 1_000) {
  let now = start;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimeout(callback: () => void, delay: number) {
      const id = ++nextId;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    advance(delay: number) {
      now += delay;
      for (const [id, timer] of [...timers].sort((left, right) => left[1].at - right[1].at)) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

function directoryStat({ symlink = false, reparse = false } = {}) {
  return {
    isDirectory: () => true,
    isSymbolicLink: () => symlink,
    isReparsePoint: () => reparse,
  };
}

function safeFs() {
  return {
    mkdir: vi.fn(async () => undefined),
    lstat: vi.fn(async () => directoryStat()),
    realpath: vi.fn(async (path: string) => path),
    chmod: vi.fn(async () => undefined),
  };
}

function worker(options: Record<string, unknown> = {}) {
  return new KiroOrganizationWorker({
    executable: EXECUTABLE,
    homeRoot: HOME_ROOT,
    fs: safeFs(),
    ...options,
  });
}

describe("KiroOrganizationWorker isolation", () => {
  it("uses the official absolute CLI, independent homes, and API keys only in child env", async () => {
    const calls: Array<[string, string[], Record<string, any>]> = [];
    const outputs = [
      () => completedChild("kiro-cli 1.28.0"),
      () => completedChild(JSON.stringify({ authenticated: true, provider: "API Key", email: "private@example.test" })),
      () => completedChild("kiro-cli 1.28.1"),
      () => completedChild(JSON.stringify({ accountType: "APIKey", subject: "private-subject" })),
    ];
    const spawn = vi.fn((executable: string, args: string[], options: Record<string, any>) => {
      calls.push([executable, args, options]);
      return outputs.shift()!();
    });
    const fs = safeFs();
    const instance = worker({
      spawn,
      fs,
      environment: {
        HOME: "/global/home",
        USERPROFILE: "C:\\GlobalProfile",
        LOCALAPPDATA: "C:\\GlobalProfile\\Local",
        APPDATA: "C:\\GlobalProfile\\Roaming",
        XDG_CONFIG_HOME: "/global/config",
        AWS_PROFILE: "must-not-leak",
        AWS_REGION: "must-not-leak",
        HTTPS_PROXY: "https://proxy.example",
        SSL_CERT_FILE: "/company/cert.pem",
        RANDOM_SECRET: "must-not-leak",
        KIRO_API_KEY: "must-not-leak",
        ...(WINDOWS ? { SYSTEMROOT: "C:\\Windows" } : {}),
      },
    });

    const first = await instance.verifyAccount({ accountId: "team-one", apiKey: "key-team-one" });
    const second = await instance.verifyAccount({ accountId: "team-two", apiKey: "key-team-two" });
    expect(first).toEqual({ verified: true, method: "api-key", cliVersion: "1.28.0" });
    expect(second).toEqual({ verified: true, method: "api-key", cliVersion: "1.28.1" });
    expect(JSON.stringify({ first, second })).not.toMatch(/private@example|private-subject|key-team/);

    for (const [executable, args, options] of calls) {
      expect(executable).toBe(EXECUTABLE);
      expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      expect(args).not.toContain("key-team-one");
      expect(args).not.toContain("key-team-two");
      expect(JSON.stringify(options.env)).not.toMatch(/global.home|GlobalProfile|must-not-leak/i);
      expect(options.env.HTTPS_PROXY).toBe("https://proxy.example");
      expect(options.env.SSL_CERT_FILE).toBe("/company/cert.pem");
    }
    const whoamiCalls = calls.filter(([, args]) => args[0] === "whoami");
    expect(whoamiCalls[0][2].env.KIRO_API_KEY).toBe("key-team-one");
    expect(whoamiCalls[1][2].env.KIRO_API_KEY).toBe("key-team-two");
    expect(whoamiCalls[0][2].env.KIRO_HOME).not.toBe(whoamiCalls[1][2].env.KIRO_HOME);
    expect(calls.filter(([, args]) => args[0] === "--version")
      .every(([, , options]) => !("KIRO_API_KEY" in options.env))).toBe(true);
    expect(fs.mkdir).toHaveBeenCalled();
  });

  it("rejects old or pre-release 1.28.0 CLIs before sending the credential", async () => {
    for (const version of ["1.27.9", "1.28.0-beta.1"]) {
      const spawn = vi.fn(() => completedChild(`kiro-cli ${version}`));
      const instance = worker({ spawn });
      await expect(instance.verifyAccount({ accountId: "team", apiKey: "private-key" }))
        .rejects.toMatchObject({ code: "kiro_organization_cli_version_unsupported" });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0][2].env).not.toHaveProperty("KIRO_API_KEY");
    }
  });

  it("accepts only one anchored official CLI version line", async () => {
    const helperThenOld = vi.fn(() => completedChild("helper 9.9.9\nkiro-cli 1.27.9"));
    await expect(worker({ spawn: helperThenOld }).verifyAccount({ accountId: "team", apiKey: "private-key" }))
      .rejects.toMatchObject({ code: "kiro_organization_cli_version_unsupported" });
    expect(helperThenOld).toHaveBeenCalledTimes(1);
    expect(helperThenOld.mock.calls[0][2].env).not.toHaveProperty("KIRO_API_KEY");

    const ambiguous = vi.fn(() => completedChild("kiro-cli 2.0.0\nkiro-cli-chat v1.27.9"));
    await expect(worker({ spawn: ambiguous }).verifyAccount({ accountId: "team", apiKey: "private-key" }))
      .rejects.toMatchObject({ code: "kiro_organization_cli_version_invalid" });
    expect(ambiguous).toHaveBeenCalledTimes(1);
  });

  it("rejects symlink, reparse-point, and realpath escapes before spawning", async () => {
    const accountSuffix = WINDOWS ? "\\team" : "/team";
    for (const unsafe of ["symlink", "reparse", "escape"] as const) {
      const fs = safeFs();
      fs.lstat.mockImplementation(async (path: string) => directoryStat({
        symlink: unsafe === "symlink" && path.endsWith(accountSuffix),
        reparse: unsafe === "reparse" && path.endsWith(accountSuffix),
      }));
      fs.realpath.mockImplementation(async (path: string) => {
        if (unsafe !== "escape" || !path.endsWith(accountSuffix)) return path;
        return WINDOWS ? "C:\\Outside\\team" : "/outside/team";
      });
      const spawn = vi.fn();
      const instance = worker({ fs, spawn });

      await expect(instance.verifyAccount({ accountId: "team", apiKey: "private-key" }))
        .rejects.toMatchObject({ code: "kiro_organization_account_home_unsafe" });
      expect(spawn).not.toHaveBeenCalled();
      expect(fs.mkdir).toHaveBeenCalledTimes(2);
    }
  });

  it("forces every existing POSIX account directory to mode 0700", async () => {
    const fs = safeFs();
    const spawn = vi.fn()
      .mockImplementationOnce(() => completedChild("kiro-cli-chat v2.0.0"))
      .mockImplementationOnce(() => completedChild(JSON.stringify({ provider: "API Key" })));
    const instance = new KiroOrganizationWorker({
      executable: "/opt/kiro/bin/kiro-cli",
      homeRoot: "/var/lib/kyrei/kiro-organizations",
      platform: "linux",
      environment: { HOME: "/home/kyrei" },
      fs,
      spawn,
    });

    await expect(instance.verifyAccount({ accountId: "team", apiKey: "private-key" })).resolves.toMatchObject({ verified: true });
    expect(fs.chmod).toHaveBeenCalled();
    expect(fs.chmod.mock.calls.every(([, mode]) => mode === 0o700)).toBe(true);
  });

  it("discovers only a bounded, deduplicated and sanitized model catalog", async () => {
    const spawn = vi.fn()
      .mockImplementationOnce(() => completedChild("kiro-cli 2.0.0"))
      .mockImplementationOnce(() => completedChild(JSON.stringify({ models: [
        { id: "claude-sonnet", displayName: "Claude Sonnet" },
        { modelId: "claude-opus" },
        { model_id: "claude-opus", secret: "must-not-return" },
        { model_id: "auto", model_name: "Auto (recommended)" },
      ] })));
    const instance = worker({ spawn });
    await expect(instance.discoverModels({ accountId: "team", apiKey: "private-key" })).resolves.toEqual({
      models: [
        { id: "claude-sonnet", name: "Claude Sonnet" },
        { id: "claude-opus", name: "claude-opus" },
        { id: "auto", name: "Auto (recommended)" },
      ],
      count: 3,
    });
    expect(spawn.mock.calls[1][1]).toEqual(["chat", "--list-models", "--format", "json"]);
  });

  it.each([
    ["model id", (apiKey: string) => ({ models: [{ id: apiKey }] })],
    ["display name", (apiKey: string) => ({ models: [{ id: "claude-sonnet", displayName: `Claude ${apiKey}` }] })],
    ["provider metadata", (apiKey: string) => ({ models: [{ id: "claude-sonnet", provider: apiKey }] })],
  ])("fails closed when the CLI reflects the exact credential in %s", async (_label, payload) => {
    const apiKey = "organization-secret-key";
    const spawn = vi.fn()
      .mockImplementationOnce(() => completedChild("kiro-cli 2.0.0"))
      .mockImplementationOnce(() => completedChild(JSON.stringify(payload(apiKey))));
    const instance = worker({ spawn });

    let failure: unknown;
    try {
      await instance.discoverModels({ accountId: "team", apiKey });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "kiro_organization_credential_reflected" });
    expect(JSON.stringify(failure)).not.toContain(apiKey);
  });

  it("serializes complete operations that share one KIRO_HOME", async () => {
    const children: FakeChild[] = [];
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const instance = worker({ spawn });
    const first = instance.verifyAccount({ accountId: "same-home", apiKey: "first-key" });
    const second = instance.verifyAccount({ accountId: "same-home", apiKey: "second-key" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(children).toHaveLength(1);

    children[0].complete(0, "kiro-cli 1.28.0");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(children).toHaveLength(2);
    children[1].complete(0, JSON.stringify({ provider: "API Key" }));
    await expect(first).resolves.toMatchObject({ verified: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(children).toHaveLength(3);

    children[2].complete(0, "kiro-cli 1.28.0");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(children).toHaveLength(4);
    children[3].complete(0, JSON.stringify({ accountType: "APIKey" }));
    await expect(second).resolves.toMatchObject({ verified: true });
    expect(spawn.mock.calls[1][2].env.KIRO_API_KEY).toBe("first-key");
    expect(spawn.mock.calls[3][2].env.KIRO_API_KEY).toBe("second-key");
  });

  it("bounds command time/output and force-kills the child", async () => {
    const clock = fakeClock();
    const timeoutChild = new FakeChild();
    const timed = worker({ spawn: () => timeoutChild, clock, timeoutMs: 1_000 });
    const pendingTimeout = timed.verifyAccount({ accountId: "team", apiKey: "private-key" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock.advance(1_000);
    timeoutChild.complete(null as unknown as number);
    await expect(pendingTimeout).rejects.toMatchObject({ code: "kiro_organization_cli_timeout" });
    expect(timeoutChild.kill).toHaveBeenCalledWith("SIGKILL");

    const outputChild = new FakeChild();
    const bounded = worker({ spawn: () => outputChild, maxOutputBytes: 1_024 });
    const pendingOutput = bounded.verifyAccount({ accountId: "team", apiKey: "private-key" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    outputChild.stdout.write("x".repeat(1_025));
    outputChild.complete(null as unknown as number);
    await expect(pendingOutput).rejects.toMatchObject({ code: "kiro_organization_cli_output_limit" });
    expect(outputChild.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it.each([
    ["returns false", () => false],
    ["throws", () => { throw new Error("kill failed"); }],
  ])("quarantines an account when kill %s and no exit is confirmed", async (_label, killImplementation) => {
    const clock = fakeClock();
    const children: FakeChild[] = [];
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      child.kill = vi.fn(killImplementation);
      children.push(child);
      return child;
    });
    const instance = worker({ spawn, clock, timeoutMs: 1_000, terminationGraceMs: 500 });
    const first = instance.verifyAccount({ accountId: "same-home", apiKey: "first-key" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    clock.advance(1_000);
    expect(children[0].kill).toHaveBeenCalledWith("SIGKILL");
    clock.advance(499);
    let firstSettled = false;
    void first.finally(() => { firstSettled = true; }).catch(() => undefined);
    await Promise.resolve();
    expect(firstSettled).toBe(false);
    clock.advance(1);
    await expect(first).rejects.toMatchObject({ code: "kiro_organization_cli_termination_unconfirmed" });

    const second = instance.verifyAccount({ accountId: "same-home", apiKey: "second-key" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(children).toHaveLength(1);

    children[0].exit();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(children).toHaveLength(2);
    children[1].complete(0, "kiro-cli 2.0.0");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(children).toHaveLength(3);
    children[2].complete(0, JSON.stringify({ provider: "API Key" }));
    await expect(second).resolves.toMatchObject({ verified: true });
  });

  it("keeps close pending until every active child confirms exit", async () => {
    const clock = fakeClock();
    const child = new FakeChild();
    child.kill = vi.fn(() => { throw new Error("kill failed"); });
    const instance = worker({ spawn: () => child, clock, terminationGraceMs: 500 });
    const operation = instance.verifyAccount({ accountId: "team", apiKey: "private-key" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const closing = instance.close();
    let closeSettled = false;
    void closing.finally(() => { closeSettled = true; });
    clock.advance(500);
    await expect(operation).rejects.toMatchObject({ code: "kiro_organization_cli_termination_unconfirmed" });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    child.exit();
    await expect(closing).resolves.toBeUndefined();
    expect(closeSettled).toBe(true);
  });

  it("rejects non-official relative executables and reports a stable not-found code", async () => {
    expect(() => new KiroOrganizationWorker({
      executable: "kiro-cli",
      homeRoot: HOME_ROOT,
    })).toThrow(KiroOrganizationWorkerError);
    const instance = new KiroOrganizationWorker({
      homeRoot: HOME_ROOT,
      resolveExecutable: () => null,
      fs: safeFs(),
    });
    await expect(instance.verifyAccount({ accountId: "team", apiKey: "private-key" }))
      .rejects.toMatchObject({ code: "kiro_organization_cli_not_found" });
  });
});
