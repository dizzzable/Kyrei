import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceLeaseStore } from "../core/workspace-lease-store.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "kyrei-workspace-leases-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("WorkspaceLeaseStore", () => {
  it("provides mutual exclusion, idempotent reacquisition, and owner-checked release", async () => {
    const dataDir = await root();
    const workspace = join(dataDir, "project");
    const first = new WorkspaceLeaseStore({ dataDir, instanceId: "gateway-a" });
    const lease = await first.acquire({ workspace, runId: "run-a", stageId: "write" });
    const same = await first.acquire({ workspace, runId: "run-a", stageId: "write" });
    expect(same.id).toBe(lease.id);

    const second = new WorkspaceLeaseStore({ dataDir, instanceId: "gateway-b" });
    await expect(second.acquire({ workspace, runId: "run-b", stageId: "write" })).rejects.toMatchObject({
      code: "workspace_lease_held",
    });
    await expect(second.release({ workspace, leaseId: lease.id })).rejects.toMatchObject({ code: "workspace_lease_not_owned" });
    expect(await first.release({ workspace, leaseId: lease.id })).toBe(true);
    expect(await first.get(workspace)).toBeNull();
  });

  it("preserves mutual exclusion when two instances cached state before either acquisition", async () => {
    const dataDir = await root();
    const workspace = join(dataDir, "project");
    const first = new WorkspaceLeaseStore({ dataDir, instanceId: "gateway-a" });
    const second = new WorkspaceLeaseStore({ dataDir, instanceId: "gateway-b" });
    await Promise.all([first.load(), second.load()]);

    const results = await Promise.allSettled([
      first.acquire({ workspace, runId: "run-a", stageId: "write" }),
      second.acquire({ workspace, runId: "run-b", stageId: "write" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "workspace_lease_held" },
    });
  });

  it("persists only a hash of the workspace path and redacts exact sensitive values", async () => {
    const dataDir = await root();
    const workspace = join(dataDir, "private-project-name");
    const exact = "opaque-workspace-lease-secret";
    const store = new WorkspaceLeaseStore({ dataDir, instanceId: "gateway", getSensitiveValues: () => [exact] });
    await store.acquire({ workspace, runId: "run-a", stageId: "write", resolutionMarker: { note: exact } });

    const raw = await readFile(store.file, "utf8");
    expect(raw).not.toContain(workspace);
    expect(raw).not.toContain("private-project-name");
    expect(raw).not.toContain(exact);
    expect(raw).toContain(store.hashFor(workspace));
    expect(raw).toContain("[REDACTED]");
  });

  it("cleans expired and crashed-process leases while preserving explicitly active runs", async () => {
    const dataDir = await root();
    let clock = Date.parse("2026-07-13T00:00:00.000Z");
    const now = () => new Date(clock);
    const old = new WorkspaceLeaseStore({ dataDir, instanceId: "old-gateway", now, defaultTtlMs: 2_000 });
    await old.acquire({ workspace: join(dataDir, "expired"), runId: "expired-run", stageId: "write" });
    await old.acquire({ workspace: join(dataDir, "active"), runId: "active-run", stageId: "write", ttlMs: 20_000 });
    clock += 3_000;

    const restarted = new WorkspaceLeaseStore({ dataDir, instanceId: "new-gateway", now });
    const removed = await restarted.recoverStale({ activeRunIds: ["active-run"] });
    expect(removed.map((lease: { runId: string }) => lease.runId)).toEqual(["expired-run"]);
    expect((await restarted.list()).map((lease: { runId: string }) => lease.runId)).toEqual(["active-run"]);

    const crashCleanup = await restarted.recoverStale();
    expect(crashCleanup.map((lease: { runId: string }) => lease.runId)).toEqual(["active-run"]);
  });

  it("quarantines a recovered active writer beyond TTL until verified resolution", async () => {
    const dataDir = await root();
    const workspace = join(dataDir, "project");
    let clock = Date.parse("2026-07-13T00:00:00.000Z");
    const now = () => new Date(clock);
    const old = new WorkspaceLeaseStore({ dataDir, instanceId: "old", now, defaultTtlMs: 1_000 });
    await old.acquire({ workspace, runId: "uncertain-run", stageId: "write" });
    clock += 60_000;

    const receipts = new WeakSet<object>();
    const restarted = new WorkspaceLeaseStore({
      dataDir,
      instanceId: "new",
      now,
      isVerifiedResolution: (marker) => receipts.has(marker as object),
    });
    expect(await restarted.recoverStale({ activeRunIds: ["uncertain-run"] })).toEqual([]);
    await expect(restarted.acquire({ workspace, runId: "other-run", stageId: "write" }))
      .rejects.toMatchObject({ code: "workspace_lease_held" });

    const marker = { outcome: "retry", workspaceDigest: "a".repeat(64) };
    receipts.add(marker);
    expect(await restarted.resolveQuarantine({ workspace, runId: "uncertain-run", resolutionMarker: marker })).toBe(true);
    await expect(restarted.acquire({ workspace, runId: "other-run", stageId: "write" }))
      .resolves.toMatchObject({ runId: "other-run" });
  });

  it("refuses to acquire a write lease for an unresolved uncertain outcome", async () => {
    const receipts = new WeakSet<object>();
    const store = new WorkspaceLeaseStore({
      dataDir: await root(),
      instanceId: "gateway",
      isVerifiedResolution: (marker) => receipts.has(marker as object),
    });
    const workspace = join(tmpdir(), "uncertain-project");
    await expect(store.acquire({ workspace, runId: "run", stageId: "write", uncertain: true })).rejects.toMatchObject({
      code: "workspace_write_outcome_uncertain",
    });
    const resolutionMarker = { outcome: "retry", evidence: "workspace inspection" };
    receipts.add(resolutionMarker);
    await expect(store.acquire({
      workspace,
      runId: "run",
      stageId: "write",
      uncertain: true,
      resolutionMarker,
    })).resolves.toMatchObject({ runId: "run", stageId: "write" });
  });

  it("fails closed when the durable lease state is corrupt", async () => {
    const dataDir = await root();
    const store = new WorkspaceLeaseStore({ dataDir, instanceId: "gateway" });
    await store.acquire({ workspace: join(dataDir, "project"), runId: "run-a", stageId: "write" });
    await writeFile(store.file, "{broken", "utf8");
    await expect(store.acquire({ workspace: join(dataDir, "other"), runId: "run-b", stageId: "write" }))
      .rejects.toMatchObject({ code: "workspace_lease_state_corrupt" });
    expect(await readFile(store.file, "utf8")).toBe("{broken");
  });

  it("fails closed on a malformed lease row instead of treating it as expired", async () => {
    const dataDir = await root();
    const store = new WorkspaceLeaseStore({ dataDir, instanceId: "gateway" });
    await store.acquire({ workspace: join(dataDir, "project"), runId: "run-a", stageId: "write" });
    const state = JSON.parse(await readFile(store.file, "utf8"));
    const hash = Object.keys(state.leases)[0];
    delete state.leases[hash].expiresAt;
    const malformed = JSON.stringify(state);
    await writeFile(store.file, malformed, "utf8");
    await expect(store.acquire({ workspace: join(dataDir, "other"), runId: "run-b", stageId: "write" }))
      .rejects.toMatchObject({ code: "workspace_lease_state_invalid" });
    expect(await readFile(store.file, "utf8")).toBe(malformed);
  });

  it.skipIf(process.platform !== "win32")("uses one lease identity for a workspace and its junction alias", async () => {
    const dataDir = await root();
    const workspace = join(dataDir, "project");
    const alias = join(dataDir, "project-alias");
    await mkdir(workspace);
    await symlink(workspace, alias, "junction");
    const first = new WorkspaceLeaseStore({ dataDir, instanceId: "gateway-a" });
    const second = new WorkspaceLeaseStore({ dataDir, instanceId: "gateway-b" });
    await first.acquire({ workspace, runId: "run-a", stageId: "write" });
    await expect(second.acquire({ workspace: alias, runId: "run-b", stageId: "write" }))
      .rejects.toMatchObject({ code: "workspace_lease_held" });
  });
});
