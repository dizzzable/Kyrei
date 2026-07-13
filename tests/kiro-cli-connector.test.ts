import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildKiroCliEnvironment,
  buildKiroLoginArgs,
  isValidKiroModelId,
  KiroCliConnector,
  KiroCliConnectorError,
  resolveKiroCliExecutable,
} from "../core/kiro-cli-connector.js";

const TEST_EXECUTABLE = process.platform === "win32" ? "C:\\Tools\\kiro-cli.exe" : "/opt/kiro/bin/kiro-cli";
const TEST_CWD = process.platform === "win32" ? "C:\\Tools" : "/opt/kiro/bin";

function createConnector(options: Record<string, unknown> = {}) {
  return new KiroCliConnector({ executable: TEST_EXECUTABLE, neutralCwd: TEST_CWD, ...options });
}

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
  closed = false;

  complete(code = 0, stdout = "", stderr = "") {
    if (this.closed) return;
    if (stdout) this.stdout.write(stdout);
    if (stderr) this.stderr.write(stderr);
    this.stdout.end();
    this.stderr.end();
    this.closed = true;
    this.emit("close", code, null);
  }

  fail(code = "ENOENT") {
    if (this.closed) return;
    const error = Object.assign(new Error("sensitive operating-system detail"), { code });
    this.closed = true;
    this.emit("error", error);
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
      for (const [id, timer] of [...timers.entries()].sort((left, right) => left[1].at - right[1].at)) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

const openChildren = new Set<FakeChild>();

function trackedChild() {
  const child = new FakeChild();
  openChildren.add(child);
  child.once("close", () => openChildren.delete(child));
  child.once("error", () => openChildren.delete(child));
  return child;
}

afterEach(() => {
  for (const child of openChildren) child.complete(1);
  openChildren.clear();
});

describe("Kiro CLI connector validation", () => {
  it("resolves omitted executables but accepts explicit official absolute local paths only", () => {
    expect(() => new KiroCliConnector()).not.toThrow();
    expect(() => createConnector()).not.toThrow();

    for (const executable of ["kiro-cli", "node", "kiro-cli --version", ".\\kiro-cli.exe", "kiro-cli\0.exe"]) {
      expect(() => new KiroCliConnector({ executable })).toThrow(KiroCliConnectorError);
    }
    if (process.platform === "win32") {
      expect(() => new KiroCliConnector({ executable: "C:\\Tools\\other.exe" })).toThrow(KiroCliConnectorError);
      expect(() => new KiroCliConnector({ executable: "\\\\server\\share\\kiro-cli.exe" })).toThrow(KiroCliConnectorError);
    }
  });

  it("resolves only absolute PATH/known-location candidates and never searches CWD", () => {
    const checked: string[] = [];
    const resolved = resolveKiroCliExecutable({
      platform: "win32",
      environment: {
        PATH: ";.;relative;C:\\Safe\\bin;\\\\server\\share;C:\\Other",
        USERPROFILE: "C:\\Users\\owner",
        LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local",
      },
      isExecutable(candidate: string) {
        checked.push(candidate);
        return candidate === "C:\\Safe\\bin\\kiro-cli.exe";
      },
    });
    expect(resolved).toBe("C:\\Safe\\bin\\kiro-cli.exe");
    expect(checked[0]).toBe("C:\\Safe\\bin\\kiro-cli.exe");
    expect(checked).not.toContain("kiro-cli.exe");
    expect(checked.every((candidate) => /^[A-Za-z]:\\/.test(candidate))).toBe(true);
  });

  it("passes only an explicit operational environment allowlist to children", async () => {
    const spawn = vi.fn(() => completedChild("kiro-cli 1.26.0"));
    const environment = {
      PATH: "C:\\attacker-first",
      HOME: "/home/owner",
      LANG: "ru_RU.UTF-8",
      AWS_PROFILE: "work",
      HTTPS_PROXY: "https://proxy.example",
      SSL_CERT_FILE: "/etc/company.pem",
      KIRO_API_KEY: "must-not-leak",
      AWS_SECRET_ACCESS_KEY: "must-not-leak",
      GITHUB_TOKEN: "must-not-leak",
      NODE_OPTIONS: "--require malicious.js",
      RANDOM_SECRET: "must-not-leak",
    };
    expect(buildKiroCliEnvironment(environment, { platform: "linux" })).toEqual({
      HOME: "/home/owner",
      LANG: "ru_RU.UTF-8",
      AWS_PROFILE: "work",
      HTTPS_PROXY: "https://proxy.example",
      SSL_CERT_FILE: "/etc/company.pem",
    });
    const connector = createConnector({ spawn, environment });
    await connector.detect();
    const options = spawn.mock.calls[0][2];
    expect(options.env).toEqual(expect.objectContaining({ HOME: "/home/owner", LANG: "ru_RU.UTF-8" }));
    expect(options.env).not.toHaveProperty("PATH");
    expect(JSON.stringify(options.env)).not.toMatch(/must-not-leak|NODE_OPTIONS|RANDOM_SECRET/);
    expect(options.cwd).toBe(TEST_CWD);
  });

  it("strictly validates model ids", () => {
    expect(isValidKiroModelId("claude-sonnet-4.5")).toBe(true);
    expect(isValidKiroModelId("provider/model:v2+beta")).toBe(true);
    expect(isValidKiroModelId("model with spaces")).toBe(false);
    expect(isValidKiroModelId("--flag")).toBe(false);
    expect(isValidKiroModelId(`x\n${"a".repeat(300)}`)).toBe(false);
  });

  it("builds only documented login flags and rejects unsafe Identity Center values", () => {
    expect(buildKiroLoginArgs()).toMatchObject({ args: ["login"], options: { mode: "browser", method: "unified" } });
    expect(buildKiroLoginArgs({ mode: "device", method: "free" }).args).toEqual([
      "login", "--license", "free", "--use-device-flow",
    ]);
    expect(buildKiroLoginArgs({ mode: "device", method: "google" }).args).toEqual([
      "login", "--social", "google", "--use-device-flow",
    ]);
    expect(buildKiroLoginArgs({ method: "github" }).args).toEqual(["login", "--social", "github"]);
    expect(buildKiroLoginArgs({
      mode: "device",
      method: "identity-center",
      identityProvider: "https://my-org.awsapps.com/start/",
      region: "US-EAST-1",
    }).args).toEqual([
      "login",
      "--license",
      "pro",
      "--identity-provider",
      "https://my-org.awsapps.com/start",
      "--region",
      "us-east-1",
      "--use-device-flow",
    ]);

    for (const identityProvider of [
      "http://my-org.awsapps.com/start",
      "https://awsapps.com.evil.example/start",
      "https://user:pass@my-org.awsapps.com/start",
      "https://my-org.awsapps.com/start?token=secret",
    ]) {
      expect(() => buildKiroLoginArgs({
        method: "identity-center",
        identityProvider,
        region: "us-east-1",
      })).toThrowError(/Identity Center URL/);
    }
    expect(() => buildKiroLoginArgs({
      method: "identity-center",
      identityProvider: "https://my-org.awsapps.com/start",
      region: "us-east-1;calc.exe",
    })).toThrowError(/region/);
    expect(() => buildKiroLoginArgs({ method: "google", region: "us-east-1" })).toThrowError(/require/);
  });
});

describe("Kiro CLI bounded commands", () => {
  it("detects the version and always spawns without a shell", async () => {
    const spawn = vi.fn(() => completedChild("kiro-cli 1.26.0 (build private-detail)\n"));
    const connector = createConnector({ spawn });

    await expect(connector.detect()).resolves.toEqual({ installed: true, version: "1.26.0" });
    expect(spawn).toHaveBeenCalledWith(TEST_EXECUTABLE, ["--version"], expect.objectContaining({
      shell: false,
      windowsHide: true,
      cwd: TEST_CWD,
      stdio: ["ignore", "pipe", "pipe"],
    }));
  });

  it("reports a missing executable without exposing process errors", async () => {
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      queueMicrotask(() => child.fail("ENOENT"));
      return child;
    });
    const connector = createConnector({ spawn });
    await expect(connector.detect()).resolves.toEqual({ installed: false, version: null });
  });

  it("keeps default construction non-throwing when the resolver finds no installation", async () => {
    const spawn = vi.fn();
    const connector = new KiroCliConnector({ resolveExecutable: () => null, spawn });
    await expect(connector.detect()).resolves.toEqual({ installed: false, version: null });
    await expect(connector.discoverModels()).rejects.toMatchObject({ code: "kiro_cli_not_found" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns only an allowlisted whoami summary and never identity fields", async () => {
    const privateOutput = JSON.stringify({
      accountType: "IAM Identity Center",
      provider: "AWS Identity Center",
      email: "owner@example.com",
      userId: "31fd3e86-e170-4e3f-91de-2d21223ccf02",
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/private",
      accessToken: "sk-ABCDEFGHIJKLMNOPQRSTUVWX",
    });
    const connector = createConnector({ spawn: () => completedChild(privateOutput) });

    const result = await connector.whoami();
    expect(result).toEqual({ authenticated: true, method: "identity-center", accountType: "enterprise" });
    expect(JSON.stringify(result)).not.toMatch(/owner|example|31fd|123456789012|ABCDEFGHIJKLMNOP|profileArn|userId/i);
  });

  it("accepts the official Social/GitHub whoami shape without returning the email", async () => {
    const connector = createConnector({
      spawn: () => completedChild(JSON.stringify({ accountType: "Social", email: "owner@example.com", provider: "GitHub" })),
    });
    const result = await connector.whoami();
    expect(result).toEqual({ authenticated: true, method: "github", accountType: "free" });
    expect(JSON.stringify(result)).not.toContain("owner@example.com");
  });

  it("fails closed for empty, malformed, or unknown exit-zero whoami output", async () => {
    for (const output of ["", "Logged in with GitHub as owner@example.com", "{not-json", JSON.stringify({
      accountType: "UnknownFutureType",
      provider: "GitHub",
      email: "owner@example.com",
    })]) {
      const connector = createConnector({ spawn: () => completedChild(output) });
      await expect(connector.whoami()).resolves.toEqual({ authenticated: false, method: "none", accountType: "none" });
    }
  });

  it("maps an unsuccessful whoami command to an unauthenticated summary", async () => {
    const connector = createConnector({
      spawn: () => completedChild("", 1, "Not logged in: owner@example.com"),
    });
    await expect(connector.whoami()).resolves.toEqual({ authenticated: false, method: "none", accountType: "none" });
  });

  it("discovers a deduplicated bounded list through the documented JSON command", async () => {
    const spawn = vi.fn(() => completedChild(JSON.stringify({ models: [
      { id: "auto", displayName: "Auto" },
      { modelId: "claude-sonnet-4.5" },
      { model_id: "claude-sonnet-4.5" },
    ] })));
    const connector = createConnector({ spawn });

    await expect(connector.discoverModels()).resolves.toEqual(["auto", "claude-sonnet-4.5"]);
    expect(spawn).toHaveBeenCalledWith(TEST_EXECUTABLE, ["chat", "--list-models", "--format", "json"], expect.any(Object));
  });

  it("rejects malformed or unsafe model payloads", async () => {
    const malformed = createConnector({ spawn: () => completedChild("not-json") });
    await expect(malformed.discoverModels()).rejects.toMatchObject({ code: "kiro_cli_models_malformed" });

    const invalidId = createConnector({
      spawn: () => completedChild(JSON.stringify({ models: [{ id: "model --trust-all-tools" }] })),
    });
    await expect(invalidId.discoverModels()).rejects.toMatchObject({ code: "kiro_cli_model_id_invalid" });

    for (const row of [{ displayName: "missing id" }, {}, null, 7, ["nested"]]) {
      const invalidRow = createConnector({
        spawn: () => completedChild(JSON.stringify({ models: [row] })),
      });
      await expect(invalidRow.discoverModels()).rejects.toMatchObject({
        code: row && typeof row === "object" && !Array.isArray(row)
          ? "kiro_cli_model_id_missing"
          : "kiro_cli_models_malformed",
      });
    }

    const conflictingIds = createConnector({
      spawn: () => completedChild(JSON.stringify({ models: [{ id: "one", modelId: "two" }] })),
    });
    await expect(conflictingIds.discoverModels()).rejects.toMatchObject({ code: "kiro_cli_model_id_invalid" });
  });

  it("kills commands whose output exceeds the byte limit", async () => {
    const child = new FakeChild();
    const connector = createConnector({ spawn: () => child });
    const pending = connector.discoverModels();
    child.stdout.write("x".repeat(256_001));

    await expect(pending).rejects.toMatchObject({ code: "kiro_cli_output_limit" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

describe("Kiro CLI login lifecycle", () => {
  it("polls redacted, ANSI-free progress and completes successfully", () => {
    const child = trackedChild();
    const clock = fakeClock();
    const spawn = vi.fn(() => child);
    const connector = createConnector({ spawn, clock, idFactory: () => "login-1" });
    const started = connector.startLogin({ mode: "device", method: "google" });

    child.stdout.write("\u001b[31mOpen https://device.example/ and enter ABCD-EFGH\u001b[0m\n");
    child.stderr.write("email=owner@example.com user_id=31fd3e86-e170-4e3f-91de-2d21223ccf02 token sk-ABCDEFGHIJKLMNOPQRSTUVWX\n");
    const running = connector.getLoginStatus(started.id);
    expect(running.status).toBe("running");
    expect(connector.activeLogin()).toEqual(running);
    expect(running.progress).toContain("ABCD-EFGH");
    expect(running.progress).not.toMatch(/\u001b|owner@example|31fd3e86|ABCDEFGHIJKLMNOP/);
    expect(spawn).toHaveBeenCalledWith(TEST_EXECUTABLE, ["login", "--social", "google", "--use-device-flow"], expect.objectContaining({ shell: false }));

    clock.advance(1_000);
    child.complete(0, "Authenticated\n");
    expect(connector.getLoginStatus(started.id)).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      finishedAt: 2_000,
    });
    expect(connector.activeLogin()).toBeNull();
  });

  it("bounds retained login progress while keeping its beginning and latest output", () => {
    const child = trackedChild();
    const connector = createConnector({ spawn: () => child, idFactory: () => "login-bounded" });
    const started = connector.startLogin({ mode: "device" });
    child.stdout.write(`BEGIN-CODE ABCD-EFGH\n${"x".repeat(20_000)}\nLATEST-STATUS`);

    const status = connector.getLoginStatus(started.id);
    expect(status.progress.length).toBeLessThanOrEqual(16_000);
    expect(status.progress).toContain("BEGIN-CODE ABCD-EFGH");
    expect(status.progress).toContain("LATEST-STATUS");
    expect(status.progress).toContain("Kyrei truncated");
    connector.cancelLogin(started.id);
    child.complete(1);
  });

  it("redacts opaque key/value and URL fragment secrets while preserving an explicit user_code", () => {
    const child = trackedChild();
    const connector = createConnector({ spawn: () => child, idFactory: () => "login-redaction" });
    const started = connector.startLogin({ mode: "device" });
    child.stdout.write("token=opaque-short state:state-value Authorization: Basic opaque-auth Cookie: sid=opaque-cookie\n");
    child.stdout.write("Open https://login.example/cb#access_token=frag-token&state=frag-state&code=auth-code&user_code=ABCD-EFGH\n");
    child.stdout.write("{\"refresh_token\":\"json-refresh\",\"id_token\":\"json-id\"}\n");

    const progress = connector.getLoginStatus(started.id).progress;
    expect(progress).toContain("user_code=ABCD-EFGH");
    expect(progress).not.toMatch(/opaque-short|state-value|opaque-auth|opaque-cookie|frag-token|frag-state|auth-code|json-refresh|json-id/);
    expect(progress).toContain("[REDACTED]");
    connector.cancelLogin(started.id);
    child.complete(1);
  });

  it("does not leak secrets split across chunks or after an overlong dropped line", () => {
    const child = trackedChild();
    const connector = createConnector({ spawn: () => child, idFactory: () => "login-split-redaction" });
    const started = connector.startLogin({ mode: "device" });
    child.stdout.write("state=");
    child.stdout.write("split-opaque\nSAFE-BEFORE\n");
    child.stdout.write(`token=${"P".repeat(9_000)}`);
    child.stdout.write("SECRET-TAIL\nSAFE-AFTER\n");

    const progress = connector.getLoginStatus(started.id).progress;
    expect(progress).toContain("SAFE-BEFORE");
    expect(progress).toContain("SAFE-AFTER");
    expect(progress).toContain("omitted an overlong");
    expect(progress).not.toMatch(/split-opaque|SECRET-TAIL|PPPPPPPPPP|token=/);
    connector.cancelLogin(started.id);
    child.complete(1);
  });

  it("fails and kills a login whose total output exceeds its hard byte limit", () => {
    const child = trackedChild();
    const connector = createConnector({ spawn: () => child, idFactory: () => "login-output-limit" });
    const started = connector.startLogin({ mode: "device" });
    child.stdout.write("x".repeat(256_001));

    expect(connector.getLoginStatus(started.id)).toMatchObject({
      status: "failed",
      error: "kiro_cli_output_limit",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.complete(1);
  });

  it("allows only one global Kiro auth process even across connector instances", () => {
    const firstChild = trackedChild();
    const first = createConnector({ spawn: () => firstChild, idFactory: () => "global-one" });
    const second = createConnector({ spawn: () => trackedChild(), idFactory: () => "global-two" });
    const login = first.startLogin();

    expect(first.capabilities()).toEqual({ accountIsolation: "global", maxAccounts: 1, supportsAccountPool: false });
    expect(firstChild.stdin.read()?.toString()).toBe("\n");
    expect(() => second.startLogin()).toThrowError(/already active/);
    first.cancelLogin(login.id);
    expect(firstChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(() => second.startLogin()).toThrowError(/already active/);
    firstChild.complete(1);

    const next = second.startLogin({ method: "free" });
    const secondChild = [...openChildren].find((child) => child !== firstChild)!;
    second.cancelLogin(next.id);
    secondChild.complete(1);
  });

  it("times out and kills an abandoned login using the injected clock", () => {
    const child = trackedChild();
    const clock = fakeClock(10_000);
    const connector = createConnector({ spawn: () => child, clock, idFactory: () => "login-timeout" });
    const login = connector.startLogin({ mode: "device", timeoutMs: 30_000 });

    clock.advance(30_000);
    expect(connector.getLoginStatus(login.id)).toMatchObject({
      status: "timed-out",
      error: "kiro_cli_login_timeout",
      finishedAt: 40_000,
    });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.complete(1);
  });

  it("logs out globally without exposing CLI output", async () => {
    const spawn = vi.fn(() => completedChild("You are now logged out: owner@example.com\n"));
    const connector = createConnector({ spawn });
    await expect(connector.logout()).resolves.toEqual({ loggedOut: true });
    expect(spawn).toHaveBeenCalledWith(TEST_EXECUTABLE, ["logout"], expect.objectContaining({ shell: false }));
  });

  it("serializes logout and login atomically across connector instances", async () => {
    const logoutChild = trackedChild();
    const loginChild = trackedChild();
    const first = createConnector({ spawn: () => logoutChild });
    const second = createConnector({ spawn: () => loginChild, idFactory: () => "after-logout" });
    const logout = first.logout();

    expect(() => second.startLogin()).toThrowError(/authentication change is already active/);
    await expect(second.logout()).rejects.toMatchObject({ code: "kiro_cli_auth_busy" });
    logoutChild.complete(0);
    await expect(logout).resolves.toEqual({ loggedOut: true });

    const login = second.startLogin();
    second.cancelLogin(login.id);
    loginChild.complete(1);
  });

  it("keeps the global auth lock quarantined until a force-killed logout confirms exit", async () => {
    const logoutChild = trackedChild();
    const loginChild = trackedChild();
    const clock = fakeClock();
    const first = createConnector({ spawn: () => logoutChild, clock });
    const second = createConnector({ spawn: () => loginChild, idFactory: () => "post-quarantine" });
    const logout = first.logout();
    const logoutRejected = expect(logout).rejects.toMatchObject({ code: "kiro_cli_connector_closed" });

    const closing = first.close({ timeoutMs: 100 });
    clock.advance(100);
    await closing;
    await logoutRejected;
    expect(logoutChild.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(logoutChild.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(() => second.startLogin()).toThrowError(/authentication change is already active/);

    logoutChild.complete(1);
    const login = second.startLogin();
    second.cancelLogin(login.id);
    loginChild.complete(1);
  });

  it("tracks ordinary commands so close cancels and waits for them", async () => {
    const child = trackedChild();
    const connector = createConnector({ spawn: () => child });
    const discovery = connector.discoverModels();
    const discoveryRejected = expect(discovery).rejects.toMatchObject({ code: "kiro_cli_connector_closed" });

    const closing = connector.close({ timeoutMs: 1_000 });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.complete(1);
    await closing;
    await discoveryRejected;
  });

  it("closes gracefully, cancels the owned login, and becomes unusable", async () => {
    const child = trackedChild();
    const connector = createConnector({ spawn: () => child, idFactory: () => "close-graceful" });
    connector.startLogin();

    const closing = connector.close({ timeoutMs: 1_000 });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.complete(1);
    await closing;
    expect(() => connector.startLogin()).toThrowError(/closed/);
    await expect(connector.dispose()).resolves.toBeUndefined();
  });

  it("bounds shutdown and force-kills an unresponsive login", async () => {
    const child = trackedChild();
    const clock = fakeClock();
    const connector = createConnector({ spawn: () => child, clock, idFactory: () => "close-timeout" });
    connector.startLogin();

    const closing = connector.dispose({ timeoutMs: 100 });
    clock.advance(100);
    await closing;
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    child.complete(1);
  });
});
