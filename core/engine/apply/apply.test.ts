import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePatch } from "./parse-patch.js";
import { applyPatch, ApplyError } from "./apply.js";
import { createSnapshotStore } from "./snapshot.js";

let ws: string;

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "kyrei-apply-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("applyPatch — update", () => {
  it("applies a context-anchored edit and preserves surrounding lines", async () => {
    await writeFile(join(ws, "a.txt"), "line1\nline2\nline3\n", "utf8");
    const patch = "*** Update File: a.txt\n line1\n-line2\n+LINE2X\n line3\n";
    const report = await applyPatch(ws, parsePatch(patch), createSnapshotStore(ws));
    expect(await readFile(join(ws, "a.txt"), "utf8")).toBe("line1\nLINE2X\nline3\n");
    expect(report.files).toHaveLength(1);
  });

  it("snapshot restore reverts the edit (Property 3)", async () => {
    const original = "alpha\nbeta\ngamma\n";
    await writeFile(join(ws, "a.txt"), original, "utf8");
    const snap = createSnapshotStore(ws);
    const patch = "*** Update File: a.txt\n alpha\n-beta\n+BETA\n gamma\n";
    const report = await applyPatch(ws, parsePatch(patch), snap);
    expect(await readFile(join(ws, "a.txt"), "utf8")).not.toBe(original);
    await snap.restore(report.snapshotId);
    expect(await readFile(join(ws, "a.txt"), "utf8")).toBe(original);
  });

  it("preserves CRLF line endings", async () => {
    await writeFile(join(ws, "crlf.txt"), "one\r\ntwo\r\nthree\r\n", "utf8");
    const patch = "*** Update File: crlf.txt\n one\n-two\n+TWO\n three\n";
    await applyPatch(ws, parsePatch(patch), createSnapshotStore(ws));
    expect(await readFile(join(ws, "crlf.txt"), "utf8")).toBe("one\r\nTWO\r\nthree\r\n");
  });
});

describe("applyPatch — reject != corruption (Property 10)", () => {
  it("rejects ambiguous anchor without modifying the file", async () => {
    const original = "x\ndup\ny\ndup\nz\n";
    await writeFile(join(ws, "b.txt"), original, "utf8");
    const patch = "*** Update File: b.txt\n-dup\n+DUP\n";
    await expect(applyPatch(ws, parsePatch(patch), createSnapshotStore(ws))).rejects.toMatchObject({
      code: "AMBIGUOUS",
    });
    expect(await readFile(join(ws, "b.txt"), "utf8")).toBe(original);
  });

  it("rejects not-found context without modifying the file", async () => {
    const original = "hello\nworld\n";
    await writeFile(join(ws, "c.txt"), original, "utf8");
    const patch = "*** Update File: c.txt\n-nonexistent\n+x\n";
    await expect(applyPatch(ws, parsePatch(patch), createSnapshotStore(ws))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await readFile(join(ws, "c.txt"), "utf8")).toBe(original);
  });
});

describe("applyPatch — add/delete/transactional (Property 11)", () => {
  it("adds a new file", async () => {
    const patch = "*** Add File: new/n.txt\n+hello\n+world\n";
    await applyPatch(ws, parsePatch(patch), createSnapshotStore(ws));
    expect(await readFile(join(ws, "new/n.txt"), "utf8")).toMatch(/hello/);
  });

  it("rolls back all files if any hunk fails (transactional)", async () => {
    await writeFile(join(ws, "ok.txt"), "keep\n", "utf8");
    await writeFile(join(ws, "bad.txt"), "real\n", "utf8");
    // First file would apply, second fails (context not found) → whole tx aborts, nothing written.
    const patch =
      "*** Update File: ok.txt\n-keep\n+CHANGED\n" + "*** Update File: bad.txt\n-missing\n+x\n";
    await expect(applyPatch(ws, parsePatch(patch), createSnapshotStore(ws))).rejects.toBeInstanceOf(ApplyError);
    expect(await readFile(join(ws, "ok.txt"), "utf8")).toBe("keep\n");
    expect(await readFile(join(ws, "bad.txt"), "utf8")).toBe("real\n");
  });

  it("refuses binary files", async () => {
    await writeFile(join(ws, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const patch = "*** Update File: bin.dat\n-x\n+y\n";
    await expect(applyPatch(ws, parsePatch(patch), createSnapshotStore(ws))).rejects.toMatchObject({
      code: "BINARY",
    });
  });
});
