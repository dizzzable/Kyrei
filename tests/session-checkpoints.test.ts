import { mkdtemp, mkdir, readFile, realpath, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { beginSnapshotRestore, restoreSnapshotSequence } from "../core/session-checkpoints.js";

async function writeSnapshot(workspace: string, id: string, rows: Array<{ rel: string; existed: boolean; content?: string }>) {
  const root = join(workspace, ".kyrei", "snapshots", id);
  await mkdir(root, { recursive: true });
  for (const row of rows) {
    if (!row.existed) continue;
    const target = join(root, "files", row.rel);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, row.content ?? "", "utf8");
  }
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    id,
    ts: Date.now(),
    workspace: await realpath(workspace),
    files: rows.map(({ rel, existed }) => ({ rel, existed })),
  }), "utf8");
}

describe("session checkpoint restore", () => {
  it("restores edit snapshots newest-to-oldest", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kyrei-checkpoints-"));
    const file = join(workspace, "src", "value.txt");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(file, "two", "utf8");
    await writeSnapshot(workspace, "snap-old", [{ rel: "src/value.txt", existed: true, content: "original" }]);
    await writeSnapshot(workspace, "snap-new", [{ rel: "src/value.txt", existed: true, content: "one" }]);

    const result = await restoreSnapshotSequence({ workspace, snapshotIds: ["snap-new", "snap-old"] });

    expect(result).toEqual({ restoredSnapshots: 2, restoredFiles: 1 });
    expect(await readFile(file, "utf8")).toBe("original");
  });

  it("removes a file that did not exist at the checkpoint", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kyrei-checkpoints-new-"));
    const file = join(workspace, "created.txt");
    await writeFile(file, "new", "utf8");
    await writeSnapshot(workspace, "snap-create", [{ rel: "created.txt", existed: false }]);

    await restoreSnapshotSequence({ workspace, snapshotIds: ["snap-create"] });

    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("can compensate a completed file restore when a coordinated state commit fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kyrei-checkpoints-transaction-"));
    const file = join(workspace, "value.txt");
    await writeFile(file, "changed", "utf8");
    await writeSnapshot(workspace, "snap-transaction", [{ rel: "value.txt", existed: true, content: "original" }]);

    const transaction = await beginSnapshotRestore({ workspace, snapshotIds: ["snap-transaction"] });
    expect(await readFile(file, "utf8")).toBe("original");
    await transaction.rollback();

    expect(await readFile(file, "utf8")).toBe("changed");
    await expect(transaction.rollback()).resolves.toBe(false);
  });

  it("rejects a tampered manifest before modifying workspace files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kyrei-checkpoints-tampered-"));
    const file = join(workspace, "safe.txt");
    await writeFile(file, "current", "utf8");
    await writeSnapshot(workspace, "snap-bad", [{ rel: "../outside.txt", existed: false }]);

    await expect(restoreSnapshotSequence({ workspace, snapshotIds: ["snap-bad"] }))
      .rejects.toMatchObject({ code: "checkpoint_path_escape" });
    expect(await readFile(file, "utf8")).toBe("current");
  });

  it("rejects an oversized manifest before allocating or modifying files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kyrei-checkpoints-manifest-limit-"));
    const root = join(workspace, ".kyrei", "snapshots", "snap-huge-manifest");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "manifest.json"), "x".repeat(1_000_001), "utf8");

    await expect(restoreSnapshotSequence({ workspace, snapshotIds: ["snap-huge-manifest"] }))
      .rejects.toMatchObject({ code: "checkpoint_manifest_too_large" });
  });

  it("rejects oversized sparse payloads before reading them into memory", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kyrei-checkpoints-payload-limit-"));
    await writeSnapshot(workspace, "snap-huge-payload", [{ rel: "huge.bin", existed: true, content: "" }]);
    await truncate(join(workspace, ".kyrei", "snapshots", "snap-huge-payload", "files", "huge.bin"), 64 * 1024 * 1024 + 1);

    await expect(restoreSnapshotSequence({ workspace, snapshotIds: ["snap-huge-payload"] }))
      .rejects.toMatchObject({ code: "checkpoint_payload_too_large" });
  });

  it("rejects a snapshot created for a different canonical workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kyrei-checkpoints-workspace-a-"));
    await writeSnapshot(workspace, "snap-wrong-workspace", [{ rel: "safe.txt", existed: false }]);
    const manifestPath = join(workspace, ".kyrei", "snapshots", "snap-wrong-workspace", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.workspace = join(workspace, "other");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    await expect(restoreSnapshotSequence({ workspace, snapshotIds: ["snap-wrong-workspace"] }))
      .rejects.toMatchObject({ code: "checkpoint_manifest_invalid" });
  });
});
