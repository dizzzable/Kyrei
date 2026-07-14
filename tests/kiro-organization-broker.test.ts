import { describe, expect, it, vi } from "vitest";
import {
  KiroOrganizationBroker,
  KiroOrganizationBrokerError,
} from "../core/kiro-organization-broker.js";

function configuration() {
  return {
    enabled: true,
    strategy: "balanced",
    sessionAffinity: true,
    accounts: [
      {
        id: "research",
        name: "Research",
        enabled: true,
        weight: 1,
        priority: 0,
        maxConcurrency: 1,
        modelIds: ["claude-sonnet"],
        projectIds: ["project-a"],
      },
      {
        id: "executor",
        name: "Executor",
        enabled: true,
        weight: 2,
        priority: 1,
        maxConcurrency: 1,
        modelIds: ["claude-sonnet", "claude-opus"],
        projectIds: ["project-a", "project-b"],
      },
    ],
  };
}

function createBroker(overrides: Record<string, unknown> = {}) {
  let id = 0;
  const worker = {
    verifyAccount: vi.fn(async () => ({ verified: true, method: "api-key", cliVersion: "1.28.0" })),
    discoverModels: vi.fn(async () => ({ models: [{ id: "claude-sonnet", name: "Claude Sonnet" }], count: 1 })),
    close: vi.fn(async () => undefined),
  };
  const broker = new KiroOrganizationBroker({
    config: configuration(),
    secrets: {
      research: { apiKey: "secret-research" },
      executor: { apiKey: "secret-executor" },
    },
    worker,
    protectedStorage: true,
    idFactory: () => `opaque-${++id}`,
    ...overrides,
  });
  return { broker, worker };
}

describe("KiroOrganizationBroker", () => {
  it("requires both a stored and runtime-verified credential before routing", async () => {
    const { broker, worker } = createBroker();
    expect(broker.acquire({ modelId: "claude-sonnet", projectId: "project-a" })).toBeNull();
    expect(broker.snapshot().accounts.every((account) => account.status === "auth-required")).toBe(true);

    await broker.verifyAccount("research");
    const lease = broker.acquire({ modelId: "claude-sonnet", projectId: "project-a" });
    expect(lease).not.toBeNull();
    expect(Object.keys(lease!)).toEqual(["leaseId", "signal"]);
    expect(JSON.stringify({ lease, snapshot: broker.snapshot() })).not.toContain("secret-research");
    expect(worker.verifyAccount).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "research",
      apiKey: "secret-research",
      signal: expect.any(AbortSignal),
    }));
    expect(broker.release(lease)).toBe(true);
  });

  it("composes weighted routing with project/model filtering and one process per home", async () => {
    const { broker } = createBroker();
    await broker.verifyAccount("research");
    await broker.verifyAccount("executor");

    const first = broker.acquire({ modelId: "claude-sonnet", projectId: "project-a" })!;
    // Weight 2 wins the first balanced choice; its max concurrency is still one.
    expect(broker.snapshot().accounts.find((entry) => entry.id === "executor")?.inflight).toBe(1);
    const second = broker.acquire({ modelId: "claude-sonnet", projectId: "project-a" })!;
    expect(broker.snapshot().accounts.find((entry) => entry.id === "research")?.inflight).toBe(1);
    expect(broker.acquire({ modelId: "claude-sonnet", projectId: "project-a" })).toBeNull();
    broker.release(first);
    broker.release(second);

    const projectB = broker.acquire({ modelId: "claude-opus", projectId: "project-b" })!;
    expect(projectB).not.toBeNull();
    expect(broker.snapshot().accounts.find((entry) => entry.id === "executor")?.inflight).toBe(1);
    broker.release(projectB);
    expect(broker.acquire({ modelId: "claude-opus", projectId: "unknown" })).toBeNull();
  });

  it("fences and aborts opaque leases on every reconfiguration", async () => {
    const { broker } = createBroker();
    await broker.verifyAccount("research");
    const lease = broker.acquire({ modelId: "claude-sonnet", projectId: "project-a" })!;
    expect(lease.signal.aborted).toBe(false);

    const before = broker.snapshot();
    const after = broker.reconfigure({ config: configuration() });
    expect(after.revision).toBe(before.revision);
    expect(after.generation).toBe(before.generation + 1);
    expect(lease.signal.aborted).toBe(true);
    expect(() => broker.assertLease(lease)).toThrow(KiroOrganizationBrokerError);

    // Same secret remains verified across a routing fence, while the stale
    // lease cannot be revived.
    expect(broker.acquire({ modelId: "claude-sonnet", projectId: "project-a" })).not.toBeNull();
  });

  it("does not let an aborted pre-fence verification clear retained post-fence state", async () => {
    const { broker, worker } = createBroker();
    await broker.verifyAccount("research");
    worker.verifyAccount.mockImplementationOnce(({ signal }: { signal: AbortSignal }) => (
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("private"), { code: "aborted" })), { once: true });
      })
    ));
    const pending = broker.verifyAccount("research");
    await vi.waitFor(() => expect(worker.verifyAccount).toHaveBeenCalledTimes(2));
    broker.reconfigure({ config: configuration() });
    await expect(pending).rejects.toMatchObject({ code: "kiro_organization_operation_stale" });

    const lease = broker.acquire({
      accountId: "research",
      modelId: "claude-sonnet",
      projectId: "project-a",
    });
    expect(lease).not.toBeNull();
    broker.release(lease);
  });

  it("revokes credentials, aborts active work and never sends secret material to audit", async () => {
    const audit = vi.fn();
    const { broker } = createBroker({ audit });
    await broker.verifyAccount("research");
    const lease = broker.acquire({ modelId: "claude-sonnet", projectId: "project-a" })!;

    const revoked = broker.revoke("research");
    expect(revoked).toMatchObject({
      hasStoredCredential: false,
      status: "auth-required",
      reasonCode: "credential_required",
    });
    expect(lease.signal.aborted).toBe(true);
    expect(broker.acquire({
      accountId: "research",
      modelId: "claude-sonnet",
      projectId: "project-a",
    })).toBeNull();
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/secret-research|apiKey/i);
    expect(audit.mock.calls.map(([event]) => event.type)).toContain("credential-revoke-pending");
    expect(audit.mock.calls.map(([event]) => event.type)).not.toContain("credential-revoked");
    broker.markRevocationPersistenceFailed("research", 1);
    expect(audit.mock.calls.map(([event]) => event.type)).toContain("credential-revoke-persist-failed");
    expect(audit.mock.calls.map(([event]) => event.type)).not.toContain("credential-revoked");
    broker.markRevocationCommitted("research", 1);
    expect(audit.mock.calls.map(([event]) => event.type)).toContain("credential-revoked");
  });

  it("discovers models only after verification and returns the worker's sanitized catalog", async () => {
    const { broker, worker } = createBroker();
    await expect(broker.discoverModels("executor")).rejects.toMatchObject({
      code: "kiro_organization_verification_required",
    });
    await broker.verifyAccount("executor");
    await expect(broker.discoverModels("executor")).resolves.toEqual({
      models: [{ id: "claude-sonnet", name: "Claude Sonnet" }],
      count: 1,
    });
    expect(worker.discoverModels).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "executor",
      apiKey: "secret-executor",
      signal: expect.any(AbortSignal),
    }));
  });

  it("maps auth rejection to a generation fence and requires re-verification", async () => {
    const { broker } = createBroker();
    await broker.verifyAccount("executor");
    const lease = broker.acquire({
      accountId: "executor",
      modelId: "claude-opus",
      projectId: "project-b",
    })!;
    const state = broker.reportFailure(lease, { statusCode: 401, error: "private detail" });
    expect(state).toMatchObject({ status: "auth-required", reasonCode: "verification_required" });
    expect(lease.signal.aborted).toBe(true);
    expect(broker.acquire({
      accountId: "executor",
      modelId: "claude-opus",
      projectId: "project-b",
    })).toBeNull();
  });

  it("immediately aborts an active lease when re-verification fails", async () => {
    const { broker, worker } = createBroker();
    await broker.verifyAccount("research");
    const lease = broker.acquire({
      accountId: "research",
      modelId: "claude-sonnet",
      projectId: "project-a",
    })!;
    worker.verifyAccount.mockRejectedValueOnce(Object.assign(new Error("private upstream detail"), {
      code: "credential-rejected",
    }));

    await expect(broker.verifyAccount("research")).rejects.toMatchObject({
      code: "kiro_organization_verification_failed",
    });
    expect(lease.signal.aborted).toBe(true);
    expect(broker.acquire({
      accountId: "research",
      modelId: "claude-sonnet",
      projectId: "project-a",
    })).toBeNull();
  });

  it("distinguishes temporary rate limits from hard quota and entitlement stops", async () => {
    const { broker } = createBroker();
    await broker.verifyAccount("research");
    await broker.verifyAccount("executor");

    const rateLimited = broker.acquire({
      accountId: "executor",
      modelId: "claude-opus",
      projectId: "project-b",
    })!;
    const cooldown = broker.reportFailure(rateLimited, { statusCode: 429, retryable: true });
    expect(rateLimited.signal.aborted).toBe(false);
    expect(cooldown.status).toBe("cooldown");
    broker.release(rateLimited);

    const exhausted = broker.acquire({
      accountId: "research",
      modelId: "claude-sonnet",
      projectId: "project-a",
    })!;
    const blocked = broker.reportFailure(exhausted, { statusCode: 402, quotaExhausted: true });
    expect(exhausted.signal.aborted).toBe(true);
    expect(blocked).toMatchObject({ status: "disabled", reasonCode: "quota_exhausted" });

    broker.reconfigure({ config: configuration() });
    expect(broker.snapshot().accounts.find((account) => account.id === "research"))
      .toMatchObject({ status: "disabled", reasonCode: "quota_exhausted" });

    broker.reconfigure({
      config: configuration(),
      secrets: {
        research: { apiKey: "rotated-research-key" },
        executor: { apiKey: "secret-executor" },
      },
    });
    expect(broker.snapshot().accounts.find((account) => account.id === "research"))
      .toMatchObject({ status: "auth-required", reasonCode: "verification_required" });
  });
});
