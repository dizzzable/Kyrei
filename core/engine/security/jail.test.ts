import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, isAbsolute, join, resolve } from "node:path";
import { safePath, validateWriteTarget } from "./jail.js";

const WS = process.platform === "win32" ? "F:\\ws" : "/ws";

describe("jail — Property 1: safePath never escapes the workspace", () => {
  it("returns a path within workspace or throws", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (target) => {
        let abs: string;
        try {
          abs = safePath(WS, target);
        } catch {
          return true; // rejection is acceptable
        }
        const rel = relative(WS, abs);
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
      }),
      { numRuns: 500, seed: 42 },
    );
  });

  it("rejects explicit parent-escape", () => {
    expect(() => safePath(WS, "../secret")).toThrow();
    expect(() => safePath(WS, "a/../../secret")).toThrow();
  });

  it("allows nested paths", () => {
    expect(() => safePath(WS, "src/app.ts")).not.toThrow();
  });
});

describe("validateWriteTarget", () => {
  const tempRoots: string[] = [];

  async function makeTempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "kyrei-jail-"));
    tempRoots.push(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("allows a nested missing write target below the nearest existing parent", async () => {
    const root = await makeTempRoot();
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "existing"), { recursive: true });

    await expect(validateWriteTarget(workspace, "existing/missing/deep/file.txt")).resolves.toBe(
      resolve(workspace, "existing/missing/deep/file.txt"),
    );
  });

  it("rejects lexical paths outside the workspace", async () => {
    const root = await makeTempRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);

    await expect(validateWriteTarget(workspace, "../outside.txt")).rejects.toThrow();
  });

  it("rejects a real symlink or junction component", async ({ skip }) => {
    const root = await makeTempRoot();
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    const link = join(workspace, "redirect");
    await mkdir(workspace);
    await mkdir(outside);

    try {
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
        skip(`OS cannot create test symlink/junction (${code})`);
      }
      throw error;
    }

    await expect(validateWriteTarget(workspace, "redirect/escaped.txt")).rejects.toThrow(/symbolic|reparse|junction/i);
  });

  it.runIf(process.platform === "win32")("rejects Windows ADS and trailing dot/space aliases", async () => {
    const root = await makeTempRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);

    await expect(validateWriteTarget(workspace, "notes.txt:secret")).rejects.toThrow(/ADS|alias/i);
    await expect(validateWriteTarget(workspace, "folder./notes.txt")).rejects.toThrow(/alias/i);
    await expect(validateWriteTarget(workspace, "folder /notes.txt")).rejects.toThrow(/alias/i);
  });

  it("revalidates filesystem components on every call", async ({ skip }) => {
    const root = await makeTempRoot();
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    const mutableParent = join(workspace, "mutable");
    await mkdir(mutableParent, { recursive: true });
    await mkdir(outside);

    await expect(validateWriteTarget(workspace, "mutable/file.txt")).resolves.toBe(join(mutableParent, "file.txt"));
    await rm(mutableParent, { recursive: true });
    try {
      await symlink(outside, mutableParent, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
        skip(`OS cannot create test symlink/junction (${code})`);
      }
      throw error;
    }

    await expect(validateWriteTarget(workspace, "mutable/file.txt")).rejects.toThrow(/symbolic|reparse|junction/i);
  });
});
