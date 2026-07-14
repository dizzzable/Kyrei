import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  createWindowsDpapiSecretsCodec,
  createWindowsProtectedSecretsCodec,
  runWindowsDpapi,
} from "../electron/windows-dpapi-secrets.js";

describe("Windows DPAPI secret codec", () => {
  it("probes and round-trips through an injected CurrentUser transform", async () => {
    const transform = vi.fn(async (mode: string, payload: string) => {
      const bytes = Buffer.from(payload, "base64");
      return mode === "protect"
        ? Buffer.from(`protected:${bytes.toString("utf8")}`, "utf8").toString("base64")
        : Buffer.from(bytes.toString("utf8").replace(/^protected:/, ""), "utf8").toString("base64");
    });
    const codec = await createWindowsDpapiSecretsCodec({ transform });

    const encrypted = await codec.encode("provider-secret-value");
    expect(encrypted).not.toContain("provider-secret-value");
    await expect(codec.decode(encrypted)).resolves.toBe("provider-secret-value");
    expect(codec.backend).toBe("windows-dpapi");
    expect(transform).toHaveBeenCalledWith("protect", expect.any(String));
    expect(transform).toHaveBeenCalledWith("unprotect", expect.any(String));
  });

  it("passes payload only through stdin and keeps it out of argv and environment", async () => {
    const stdin = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn> };
    stdin.end = vi.fn();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      stdin: typeof stdin;
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = vi.fn();
    const spawnProcess = vi.fn(() => child);
    const payload = Buffer.from("never-on-command-line", "utf8").toString("base64");
    const pending = runWindowsDpapi("protect", payload, { spawnProcess, timeoutMs: 1_000 });

    expect(spawnProcess).toHaveBeenCalledWith(
      "powershell.exe",
      expect.not.arrayContaining([expect.stringContaining(payload)]),
      expect.objectContaining({ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }),
    );
    expect(JSON.stringify(spawnProcess.mock.calls[0])).not.toContain(payload);
    expect(stdin.end).toHaveBeenCalledWith(payload, "utf8");

    stdout.emit("data", Buffer.from(Buffer.from("cipher", "utf8").toString("base64")));
    child.emit("close", 0);
    await expect(pending).resolves.toBe(Buffer.from("cipher", "utf8").toString("base64"));
  });

  it("fails closed on invalid process output", async () => {
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & Record<string, any>;
      child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("not base64!"));
        child.emit("close", 0);
      });
      return child;
    });

    await expect(runWindowsDpapi("protect", "", { spawnProcess })).rejects.toMatchObject({
      code: "windows_dpapi_failed",
    });
  });

  it("tags the selected backend and migrates DPAPI ciphertext when safeStorage returns", async () => {
    const safeStorageCodec = {
      encode: vi.fn(async (value: string) => Buffer.from(`safe:${value}`).toString("base64")),
      decode: vi.fn(async (value: string) => Buffer.from(value, "base64").toString("utf8").replace(/^safe:/, "")),
    };
    const dpapiCodec = {
      encode: vi.fn(async (value: string) => Buffer.from(`dpapi:${value}`).toString("base64")),
      decode: vi.fn(async (value: string) => Buffer.from(value, "base64").toString("utf8").replace(/^dpapi:/, "")),
    };
    const fallbackOnly = createWindowsProtectedSecretsCodec({ dpapiCodec });
    const fallbackCiphertext = await fallbackOnly.encode("provider-key");
    expect(fallbackCiphertext).toMatch(/^kyrei-windows-dpapi-v1:/);

    const restored = createWindowsProtectedSecretsCodec({ safeStorageCodec, dpapiCodec });
    await expect(restored.decode(fallbackCiphertext)).resolves.toBe("provider-key");
    const migratedCiphertext = await restored.encode("provider-key");
    expect(migratedCiphertext).toMatch(/^kyrei-safe-storage-v1:/);
    await expect(restored.decode(migratedCiphertext)).resolves.toBe("provider-key");
  });

  it("reads untagged legacy safeStorage payloads without treating a tagged value as another backend", async () => {
    const safeStorageCodec = {
      encode: vi.fn(async (value: string) => Buffer.from(value).toString("base64")),
      decode: vi.fn(async (value: string) => Buffer.from(value, "base64").toString("utf8")),
    };
    const dpapiCodec = {
      encode: vi.fn(async (value: string) => Buffer.from(value).toString("base64")),
      decode: vi.fn(async (value: string) => Buffer.from(value, "base64").toString("utf8")),
    };
    const codec = createWindowsProtectedSecretsCodec({ safeStorageCodec, dpapiCodec });
    const legacy = Buffer.from("legacy-value").toString("base64");

    await expect(codec.decode(legacy)).resolves.toBe("legacy-value");
    const fallbackOnly = createWindowsProtectedSecretsCodec({ dpapiCodec });
    await expect(fallbackOnly.decode(`kyrei-safe-storage-v1:${legacy}`)).rejects.toMatchObject({
      code: "electron_safe_storage_unavailable",
    });
    expect(dpapiCodec.decode).not.toHaveBeenCalledWith(legacy);
  });
});
