import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createGatewayConfigPersistence,
  startGateway,
} from "../core/gateway.js";

const temporaryDirectories: string[] = [];
const liveServers: Array<{ close(): void | Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(liveServers.splice(0).map(server => server.close()));
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "kyrei-gateway-persistence-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function gatewayRequest<T>(
  server: { port: number; token: string },
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: {
      "X-Kyrei-Gateway-Token": server.token,
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? String(response.status));
  return body;
}

function reversibleCodec(onEncode?: (call: number) => void | Promise<void>) {
  let calls = 0;
  return {
    encode: async (value: string) => {
      calls += 1;
      await onEncode?.(calls);
      return Buffer.from(value, "utf8").toString("base64");
    },
    decode: async (value: string) => Buffer.from(value, "base64").toString("utf8"),
  };
}

describe("gateway config persistence", () => {
  it("snapshots queued inputs and preserves invocation order across delayed encoding", async () => {
    const dataDir = await temporaryDirectory();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const firstRelease = new Promise<void>(resolve => { releaseFirst = resolve; });
    const codec = reversibleCodec(async call => {
      if (call === 1) {
        markFirstStarted();
        await firstRelease;
      }
    });
    const persistence = createGatewayConfigPersistence({ dataDir, secretsCodec: codec });
    const firstConfig = { label: "first" };
    const firstSecrets = { providers: { first: { apiKey: "first-test-secret" } } };
    const firstSave = persistence.save(firstConfig, firstSecrets);
    await firstStarted;

    firstConfig.label = "mutated-after-save";
    firstSecrets.providers.first.apiKey = "mutated-after-save";
    const secondSave = persistence.save(
      { label: "second" },
      { providers: { second: { apiKey: "second-test-secret" } } },
    );
    releaseFirst();
    await Promise.all([firstSave, secondSave]);

    const loaded = await persistence.load();
    expect(loaded.config).toMatchObject({ label: "second" });
    expect(loaded.secrets).toMatchObject({
      providers: { second: { apiKey: "second-test-secret" } },
    });
    expect(JSON.stringify(loaded)).not.toContain("mutated-after-save");
  });

  it("recovers the prior committed pair after a config write failure and removes temp files", async () => {
    const dataDir = await temporaryDirectory();
    const baseline = createGatewayConfigPersistence({ dataDir });
    await baseline.save(
      { label: "committed" },
      { providers: { committed: { apiKey: "committed-test-secret" } } },
    );

    const realWriteFile = writeFile;
    let failMainConfig = true;
    const failing = createGatewayConfigPersistence({
      dataDir,
      fileSystem: {
        writeFile: async (path: string, content: string, options: Parameters<typeof writeFile>[2]) => {
          await realWriteFile(path, content, options);
          if (
            failMainConfig &&
            basename(path).startsWith(".kyrei-config.json.") &&
            content.includes('"label": "uncommitted"')
          ) {
            failMainConfig = false;
            throw new Error("injected-config-write-failure");
          }
        },
      },
    });
    await expect(failing.save(
      { label: "uncommitted" },
      { providers: { committed: { apiKey: "committed-test-secret" } } },
    )).rejects.toThrow("injected-config-write-failure");

    const recovered = await createGatewayConfigPersistence({ dataDir }).load();
    expect(recovered.config).toMatchObject({ label: "committed" });
    expect(recovered.secrets).toMatchObject({
      providers: { committed: { apiKey: "committed-test-secret" } },
    });
    const snapshotDir = join(dataDir, ".kyrei-provider-state");
    const leftovers = [
      ...(await readdir(dataDir)),
      ...(await readdir(snapshotDir)),
    ].filter(name => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("never recovers a revoked Kiro credential after a secrets-first half commit", async () => {
    const dataDir = await temporaryDirectory();
    const marker = "revoked-kiro-half-commit-secret";
    const publicAccount = {
      id: "build-team",
      name: "Build team",
      enabled: true,
      weight: 1,
      priority: 0,
      maxConcurrency: 1,
    };
    const baseline = createGatewayConfigPersistence({ dataDir });
    await baseline.save(
      { kiroOrganization: { accounts: [publicAccount] } },
      {
        version: 3,
        providers: {},
        accounts: {},
        kiroOrganization: {
          version: 1,
          accounts: { "build-team": { kind: "api-key", apiKey: marker } },
        },
      },
    );

    let failed = false;
    const failing = createGatewayConfigPersistence({
      dataDir,
      fileSystem: {
        rename: async (source: string, target: string) => {
          if (!failed && target === join(dataDir, "kyrei-config.json")) {
            failed = true;
            throw new Error("injected-config-rename-failure");
          }
          return rename(source, target);
        },
      },
    });
    await failing.load();
    await expect(failing.save(
      { kiroOrganization: { accounts: [publicAccount] } },
      {
        version: 3,
        providers: {},
        accounts: {},
        kiroOrganization: { version: 1, accounts: {} },
      },
    )).rejects.toThrow("injected-config-rename-failure");

    const recovered = await createGatewayConfigPersistence({ dataDir }).load();
    expect(JSON.stringify(recovered)).not.toContain(marker);
    expect(recovered.secrets).toEqual({});
    const snapshotNames = await readdir(join(dataDir, ".kyrei-provider-state"));
    expect(snapshotNames.filter(name => /^(?:config|secrets)-/.test(name))).toEqual([]);
    await expect(readFile(join(dataDir, ".kyrei-secret-mutation-fence.json"), "utf8"))
      .resolves.toContain("pending-secret-mutation");
  });

  it("honors the durable credential fence when failure happens before the secrets rename", async () => {
    const dataDir = await temporaryDirectory();
    const marker = "revoked-before-secrets-rename";
    const baseline = createGatewayConfigPersistence({ dataDir });
    await baseline.save(
      { label: "credential-present" },
      {
        version: 3,
        providers: {},
        accounts: {},
        kiroOrganization: {
          version: 1,
          accounts: { "build-team": { kind: "api-key", apiKey: marker } },
        },
      },
    );

    let failed = false;
    const failing = createGatewayConfigPersistence({
      dataDir,
      fileSystem: {
        rename: async (source: string, target: string) => {
          if (!failed && target === join(dataDir, "kyrei-secrets.json")) {
            failed = true;
            throw new Error("injected-secrets-rename-failure");
          }
          return rename(source, target);
        },
      },
    });
    await failing.load();
    await expect(failing.save(
      { label: "credential-revoked" },
      { version: 3, providers: {}, accounts: {}, kiroOrganization: { version: 1, accounts: {} } },
    )).rejects.toThrow("injected-secrets-rename-failure");

    const recovery = createGatewayConfigPersistence({ dataDir });
    const recovered = await recovery.load();
    expect(JSON.stringify(recovered)).not.toContain(marker);
    expect(recovered.secrets).toEqual({});
    await recovery.save(recovered.config, recovered.secrets);
    await expect(readFile(recovery.secretMutationFencePath, "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(await createGatewayConfigPersistence({ dataDir }).load())).not.toContain(marker);
  });

  it("writes the durable fence before protected secret encoding can fail", async () => {
    const dataDir = await temporaryDirectory();
    const marker = "revoked-before-secret-encoding";
    const codec = reversibleCodec();
    const baseline = createGatewayConfigPersistence({ dataDir, secretsCodec: codec });
    await baseline.save(
      { label: "credential-present" },
      { providers: { primary: { apiKey: marker } } },
    );

    const failing = createGatewayConfigPersistence({
      dataDir,
      secretsCodec: {
        encode: async () => { throw new Error("injected-secret-encode-failure"); },
        decode: codec.decode,
      },
    });
    await failing.load();
    await expect(failing.save(
      { label: "credential-revoked" },
      { providers: {} },
    )).rejects.toThrow("injected-secret-encode-failure");
    await expect(readFile(failing.secretMutationFencePath, "utf8"))
      .resolves.toContain("pending-secret-mutation");

    const recovered = await createGatewayConfigPersistence({ dataDir, secretsCodec: codec }).load();
    expect(recovered.secrets).toEqual({});
    expect(JSON.stringify(recovered)).not.toContain(marker);
  });

  it("keeps credentials fail-closed when the durable fence cannot be cleared after main commit", async () => {
    const dataDir = await temporaryDirectory();
    const marker = "revoked-before-fence-clear";
    const baseline = createGatewayConfigPersistence({ dataDir });
    await baseline.save(
      { label: "credential-present" },
      { providers: { primary: { apiKey: marker } } },
    );

    const fencePath = join(dataDir, ".kyrei-secret-mutation-fence.json");
    let failed = false;
    const failing = createGatewayConfigPersistence({
      dataDir,
      fileSystem: {
        rm: async (path: string, options: Parameters<typeof rm>[1]) => {
          if (!failed && path === fencePath) {
            failed = true;
            throw new Error("injected-fence-clear-failure");
          }
          return rm(path, options);
        },
      },
    });
    await failing.load();
    await expect(failing.save(
      { label: "credential-revoked" },
      { providers: {} },
    )).rejects.toThrow("injected-fence-clear-failure");

    const recovered = await createGatewayConfigPersistence({ dataDir }).load();
    expect(recovered.secrets).toEqual({});
    expect(JSON.stringify(recovered)).not.toContain(marker);
  });

  it("restores a consistent revision when either main JSON file is corrupt", async () => {
    const dataDir = await temporaryDirectory();
    let server = await startGateway({ dataDir, preferredPort: 0 });
    liveServers.push(server);
    const initial = await gatewayRequest<{ activeProviderId: string }>(server, "/api/config");
    await gatewayRequest(server, `/api/providers/${initial.activeProviderId}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "recovery-test-secret" }),
    });

    await server.close();
    liveServers.splice(liveServers.indexOf(server), 1);
    await writeFile(join(dataDir, "kyrei-secrets.json"), "{broken", "utf8");
    server = await startGateway({ dataDir, preferredPort: 0 });
    liveServers.push(server);
    expect(await gatewayRequest<{ hasKey: boolean }>(server, "/api/config")).toMatchObject({ hasKey: true });

    await server.close();
    liveServers.splice(liveServers.indexOf(server), 1);
    await writeFile(join(dataDir, "kyrei-config.json"), "{broken", "utf8");
    server = await startGateway({ dataDir, preferredPort: 0 });
    liveServers.push(server);
    expect(await gatewayRequest<{ hasKey: boolean }>(server, "/api/config")).toMatchObject({ hasKey: true });
    const repairedConfig = await readFile(join(dataDir, "kyrei-config.json"), "utf8");
    const repairedSecrets = await readFile(join(dataDir, "kyrei-secrets.json"), "utf8");
    expect(() => JSON.parse(repairedConfig)).not.toThrow();
    expect(() => JSON.parse(repairedSecrets)).not.toThrow();
  });

  it("never bypasses an unavailable OS secret store with an older plaintext snapshot", async () => {
    const dataDir = await temporaryDirectory();
    const codec = reversibleCodec();
    const persistence = createGatewayConfigPersistence({ dataDir, secretsCodec: codec });
    await persistence.save(
      { label: "encrypted-current" },
      { providers: { current: { apiKey: "encrypted-current-secret" } } },
    );

    const snapshotDir = join(dataDir, ".kyrei-provider-state");
    const meta = { version: 1, revision: "stale-plaintext" };
    await writeFile(
      join(snapshotDir, "config-stale-plaintext.json"),
      JSON.stringify({ label: "stale", __kyreiPersistence: meta }),
      "utf8",
    );
    await writeFile(
      join(snapshotDir, "secrets-stale-plaintext.json"),
      JSON.stringify({ providers: { stale: { apiKey: "stale-plaintext-secret" } }, __kyreiPersistence: meta }),
      "utf8",
    );

    await expect(createGatewayConfigPersistence({ dataDir }).load())
      .rejects.toThrow("OS secret storage is unavailable");
  });

  it("fails closed for desktop secret writes when protected storage is unavailable", async () => {
    const dataDir = await temporaryDirectory();
    const persistence = createGatewayConfigPersistence({
      dataDir,
      requireProtectedSecrets: true,
    });
    await persistence.save(
      { label: "local-only" },
      { version: 2, providers: {}, accounts: {} },
    );
    await expect(persistence.save(
      { label: "must-not-commit" },
      { version: 2, providers: {}, accounts: { provider: { backup: { apiKey: "must-never-be-plaintext" } } } },
    )).rejects.toThrow("OS secret storage is unavailable");
    await expect(persistence.save(
      { label: "must-not-commit-kiro" },
      {
        version: 3,
        providers: {},
        accounts: {},
        kiroOrganization: {
          version: 1,
          accounts: { "build-team": { kind: "api-key", apiKey: "kiro-must-never-be-plaintext" } },
        },
      },
    )).rejects.toThrow("OS secret storage is unavailable");
    const persisted = await readFile(join(dataDir, "kyrei-secrets.json"), "utf8");
    expect(persisted).not.toContain("must-never-be-plaintext");
    expect(persisted).not.toContain("kiro-must-never-be-plaintext");
  });

  it("serializes concurrent provider transactions before deriving their next states", async () => {
    const dataDir = await temporaryDirectory();
    let releaseMutation!: () => void;
    let markMutationStarted!: () => void;
    const mutationStarted = new Promise<void>(resolve => { markMutationStarted = resolve; });
    const mutationRelease = new Promise<void>(resolve => { releaseMutation = resolve; });
    const codec = reversibleCodec(async call => {
      // Call 1 is gateway startup. Hold the first provider transaction while a
      // second request arrives to deterministically exercise stale-state races.
      if (call === 2) {
        markMutationStarted();
        await mutationRelease;
      }
    });
    let server = await startGateway({ dataDir, preferredPort: 0, secretsCodec: codec });
    liveServers.push(server);
    const createProvider = (id: string) => gatewayRequest(server, "/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: {
          id,
          name: id,
          protocol: "openai-chat",
          baseURL: `https://${id}.example/v1`,
          models: [{ id: `${id}-model` }],
          requiresApiKey: true,
        },
        apiKey: `${id}-test-secret`,
      }),
    });

    const alpha = createProvider("alpha");
    await mutationStarted;
    const beta = createProvider("beta");
    await new Promise(resolve => setTimeout(resolve, 25));
    releaseMutation();
    await Promise.all([alpha, beta]);

    const beforeRestart = await gatewayRequest<{
      providers: Array<{ id: string; hasKey: boolean }>;
    }>(server, "/api/providers");
    expect(beforeRestart.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "alpha", hasKey: true }),
      expect.objectContaining({ id: "beta", hasKey: true }),
    ]));

    await server.close();
    liveServers.splice(liveServers.indexOf(server), 1);
    server = await startGateway({ dataDir, preferredPort: 0, secretsCodec: codec });
    liveServers.push(server);
    const afterRestart = await gatewayRequest<typeof beforeRestart>(server, "/api/providers");
    expect(afterRestart.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "alpha", hasKey: true }),
      expect.objectContaining({ id: "beta", hasKey: true }),
    ]));
  });

  it("purges cleared credentials from both main and recovery generations", async () => {
    const dataDir = await temporaryDirectory();
    let server = await startGateway({ dataDir, preferredPort: 0 });
    liveServers.push(server);
    const initial = await gatewayRequest<{ activeProviderId: string }>(server, "/api/config");
    const marker = "cleared-provider-test-secret";
    await gatewayRequest(server, `/api/providers/${initial.activeProviderId}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: marker }),
    });
    await gatewayRequest(server, `/api/providers/${initial.activeProviderId}/secret`, {
      method: "DELETE",
    });
    await server.close();
    liveServers.splice(liveServers.indexOf(server), 1);

    const snapshotDir = join(dataDir, ".kyrei-provider-state");
    const persistedFiles = [
      join(dataDir, "kyrei-config.json"),
      join(dataDir, "kyrei-secrets.json"),
      ...(await readdir(snapshotDir)).map(name => join(snapshotDir, name)),
    ];
    const persistedText = (await Promise.all(persistedFiles.map(file => readFile(file, "utf8")))).join("\n");
    expect(persistedText).not.toContain(marker);

    await writeFile(join(dataDir, "kyrei-secrets.json"), "{broken", "utf8");
    server = await startGateway({ dataDir, preferredPort: 0 });
    liveServers.push(server);
    expect(await gatewayRequest<{ hasKey: boolean }>(server, "/api/config")).toMatchObject({ hasKey: false });
  });

  it("auto-activates the first ready provider and keeps it after restart", async () => {
    const dataDir = await temporaryDirectory();
    let server = await startGateway({ dataDir, preferredPort: 0 });
    liveServers.push(server);
    await gatewayRequest(server, "/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: {
          id: "ready-local",
          name: "Ready local",
          protocol: "openai-chat",
          baseURL: "http://127.0.0.1:11434/v1",
          models: [{ id: "local-model" }],
          requiresApiKey: false,
        },
      }),
    });
    // First ready provider promotes immediately while the seed default is unready.
    expect((await gatewayRequest<{ activeProviderId: string }>(server, "/api/config")).activeProviderId)
      .toBe("ready-local");

    await server.close();
    liveServers.splice(liveServers.indexOf(server), 1);
    server = await startGateway({ dataDir, preferredPort: 0 });
    liveServers.push(server);
    expect((await gatewayRequest<{ activeProviderId: string }>(server, "/api/config")).activeProviderId)
      .toBe("ready-local");
  });

  it("reconciles an unready persisted default to a ready provider on startup", async () => {
    const dataDir = await temporaryDirectory();
    let server = await startGateway({ dataDir, preferredPort: 0 });
    liveServers.push(server);
    const initial = await gatewayRequest<{ activeProviderId: string; activeModelId: string }>(server, "/api/config");
    await gatewayRequest(server, "/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: {
          id: "ready-local",
          name: "Ready local",
          protocol: "openai-chat",
          baseURL: "http://127.0.0.1:11434/v1",
          models: [{ id: "local-model" }],
          requiresApiKey: false,
        },
        useAsDefault: true,
      }),
    });
    // Point active back at the unready seed while a ready provider remains registered.
    const configPath = join(dataDir, "kyrei-config.json");
    const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    raw.activeProviderId = initial.activeProviderId;
    raw.activeModelId = initial.activeModelId;
    await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    await server.close();
    liveServers.splice(liveServers.indexOf(server), 1);
    server = await startGateway({ dataDir, preferredPort: 0 });
    liveServers.push(server);
    expect((await gatewayRequest<{ activeProviderId: string }>(server, "/api/config")).activeProviderId)
      .toBe("ready-local");
  });
});
