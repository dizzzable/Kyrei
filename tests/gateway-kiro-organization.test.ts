import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../core/gateway.js";

type GatewayServer = { port: number; token: string; close(): Promise<void> };

let dataDir = "";
let server: GatewayServer | null = null;
let worker: ReturnType<typeof fakeOrganizationWorker>;

const secretsCodec = {
  encode: async (value: string) => Buffer.from(value, "utf8").toString("base64"),
  decode: async (value: string) => Buffer.from(value, "base64").toString("utf8"),
};

function fakeOrganizationWorker(overrides: Record<string, unknown> = {}) {
  return {
    verifyAccount: vi.fn(async () => ({ verified: true, method: "api-key", cliVersion: "2.3.0" })),
    discoverModels: vi.fn(async () => ({
      models: [{ id: "auto", name: "Auto" }, { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" }],
      count: 2,
    })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function launch(options: { protectedStorage?: boolean; workerOverrides?: Record<string, unknown> } = {}) {
  worker = fakeOrganizationWorker(options.workerOverrides);
  server = await startGateway({
    dataDir,
    preferredPort: 0,
    kiroOrganizationWorker: worker,
    ...(options.protectedStorage === false ? {} : { secretsCodec }),
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-kiro-organization-"));
  await launch();
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
  await rm(dataDir, { recursive: true, force: true });
});

async function rawRequest(path: string, init: RequestInit = {}, authenticated = true) {
  if (!server) throw new Error("test gateway is not running");
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? { "X-Kyrei-Gateway-Token": server.token } : {}),
      ...(init.headers ?? {}),
    },
  });
  return { response, body: await response.json() as Record<string, any> };
}

async function request<T = Record<string, any>>(path: string, init: RequestInit = {}): Promise<T> {
  const { response, body } = await rawRequest(path, init);
  if (!response.ok) {
    throw Object.assign(new Error(body.code ?? String(response.status)), { status: response.status, body });
  }
  return body as T;
}

async function createAccount(apiKey = "kiro-organization-test-secret") {
  const initial = await request<{ generation: number }>("/api/connectors/kiro/organization");
  return request<Record<string, any>>("/api/connectors/kiro/organization/accounts", {
    method: "POST",
    body: JSON.stringify({
      expectedGeneration: initial.generation,
      account: {
        id: "build-team",
        name: "Build team",
        enabled: true,
        weight: 2,
        priority: 10,
        maxConcurrency: 1,
        modelIds: ["auto"],
        projectIds: ["kyrei"],
      },
      credential: { apiKey },
    }),
  });
}

describe("gateway Kiro Organization boundary", () => {
  it("keeps the protected pool separate from the global Kiro connector and generic config", async () => {
    const before = worker.verifyAccount.mock.calls.length;
    const unauthenticated = await rawRequest("/api/connectors/kiro/organization", {}, false);
    expect(unauthenticated.response.status).toBe(401);
    expect(worker.verifyAccount).toHaveBeenCalledTimes(before);

    const snapshot = await request<Record<string, any>>("/api/connectors/kiro/organization");
    expect(snapshot).toMatchObject({
      version: 1,
      generation: 1,
      enabled: false,
      strategy: "balanced",
      sessionAffinity: true,
      protectedStorage: true,
      transport: "official-cli-headless",
      minimumCliVersion: "1.28.0",
      accounts: [],
    });
    const genericConfig = await request<Record<string, any>>("/api/config");
    expect(genericConfig).not.toHaveProperty("kiroOrganization");
  });

  it("creates, verifies, discovers models and updates policy without exposing the write-only key", async () => {
    const marker = "kiro-organization-test-secret";
    const created = await createAccount(marker);
    expect(created.accounts).toEqual([
      expect.objectContaining({
        id: "build-team",
        revision: 1,
        maxConcurrency: 1,
        status: "auth-required",
        hasStoredCredential: true,
      }),
    ]);
    expect(JSON.stringify(created)).not.toContain(marker);

    const verified = await request<Record<string, any>>(
      "/api/connectors/kiro/organization/accounts/build-team/verify",
      { method: "POST", body: JSON.stringify({ expectedRevision: 1 }) },
    );
    expect(verified.accounts[0]).toMatchObject({ status: "ready", hasStoredCredential: true });
    expect(worker.verifyAccount).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "build-team",
      apiKey: marker,
      signal: expect.any(AbortSignal),
    }));

    await expect(request("/api/connectors/kiro/organization/accounts/build-team/models", {
      method: "POST",
      body: "{}",
    })).resolves.toEqual({
      models: [{ id: "auto", name: "Auto" }, { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" }],
      count: 2,
    });
    expect(worker.discoverModels).toHaveBeenCalledWith(expect.objectContaining({ apiKey: marker }));

    worker.discoverModels.mockResolvedValueOnce({
      models: [{ id: "safe-model", name: `reflected-${marker}` }],
      count: 1,
    });
    const reflected = await rawRequest("/api/connectors/kiro/organization/accounts/build-team/models", {
      method: "POST",
      body: "{}",
    });
    expect(reflected.response.status).toBe(502);
    expect(reflected.body.code).toBe("kiro_organization_cli_output_invalid");
    expect(JSON.stringify(reflected.body)).not.toContain(marker);

    const updated = await request<Record<string, any>>(
      "/api/connectors/kiro/organization/accounts/build-team",
      {
        method: "PATCH",
        body: JSON.stringify({
          expectedRevision: 1,
          account: {
            id: "build-team",
            name: "Build platform",
            enabled: true,
            weight: 3,
            priority: 5,
            maxConcurrency: 1,
            modelIds: null,
            projectIds: ["kyrei"],
          },
        }),
      },
    );
    expect(updated.accounts[0]).toMatchObject({
      name: "Build platform",
      revision: 2,
      status: "ready",
      hasStoredCredential: true,
    });
    expect(updated.accounts[0]).not.toHaveProperty("modelIds");
    expect(JSON.stringify(updated)).not.toContain(marker);

    const persisted = await readFile(join(dataDir, "kyrei-secrets.json"), "utf8");
    expect(persisted).not.toContain(marker);
    expect(JSON.stringify(await request("/api/config"))).not.toContain(marker);
  });

  it("fails closed without protected storage and validates optimistic revisions", async () => {
    await server?.close();
    server = null;
    await rm(dataDir, { recursive: true, force: true });
    dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-kiro-organization-unprotected-"));
    await launch({ protectedStorage: false });
    const initial = await request<Record<string, any>>("/api/connectors/kiro/organization");
    expect(initial.protectedStorage).toBe(false);

    const marker = "must-never-be-plaintext";
    const unavailable = await rawRequest("/api/connectors/kiro/organization/accounts", {
      method: "POST",
      body: JSON.stringify({
        expectedGeneration: initial.generation,
        account: {
          id: "build-team",
          name: "Build team",
          enabled: true,
          weight: 1,
          priority: 0,
          maxConcurrency: 1,
        },
        credential: { apiKey: marker },
      }),
    });
    expect(unavailable.response.status).toBe(503);
    expect(unavailable.body.code).toBe("kiro_organization_protected_storage_required");
    expect(await readFile(join(dataDir, "kyrei-secrets.json"), "utf8")).not.toContain(marker);

    await server.close();
    server = null;
    await launch();
    await createAccount();
    const conflict = await rawRequest("/api/connectors/kiro/organization/accounts/build-team", {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: 99, account: { name: "Stale edit" } }),
    });
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.code).toBe("kiro_organization_revision_conflict");
  });

  it("aborts in-flight account work, purges recovery state and remains revoked after recovery", async () => {
    const marker = "revoked-kiro-organization-secret";
    await createAccount(marker);
    await request("/api/connectors/kiro/organization/accounts/build-team/verify", {
      method: "POST",
      body: JSON.stringify({ expectedRevision: 1 }),
    });

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    worker.discoverModels.mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
      markStarted();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), {
          name: "KiroOrganizationWorkerError",
          code: "kiro_organization_operation_aborted",
        })), { once: true });
      });
      return { models: [], count: 0 };
    });
    const models = rawRequest("/api/connectors/kiro/organization/accounts/build-team/models", {
      method: "POST",
      body: "{}",
    });
    await started;
    const revoked = await request<Record<string, any>>(
      "/api/connectors/kiro/organization/accounts/build-team/revoke",
      { method: "POST", body: JSON.stringify({ expectedRevision: 1 }) },
    );
    expect(revoked.accounts[0]).toMatchObject({
      revision: 2,
      status: "auth-required",
      hasStoredCredential: false,
    });
    expect((await models).response.ok).toBe(false);

    await server?.close();
    server = null;
    const audit = await readFile(join(dataDir, "kiro-organization-audit.jsonl"), "utf8");
    expect(audit).toContain("credential-revoked");
    expect(audit).not.toContain(marker);
    expect(await readFile(join(dataDir, "kyrei-secrets.json"), "utf8")).not.toContain(marker);

    await writeFile(join(dataDir, "kyrei-secrets.json"), "{broken", "utf8");
    await launch();
    const recovered = await request<Record<string, any>>("/api/connectors/kiro/organization");
    expect(recovered.accounts[0]).toMatchObject({ hasStoredCredential: false, status: "auth-required" });
    expect(JSON.stringify(recovered)).not.toContain(marker);
  });
});
