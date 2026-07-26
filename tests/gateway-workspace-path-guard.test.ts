import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";

type GatewayServer = { port: number; token: string; close(): Promise<void> | void };

let dataDir = "";
let workspace = "";
let server: GatewayServer | null = null;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-jail-"));
  workspace = await mkdtemp(join(tmpdir(), "kyrei-workspace-jail-"));
  await writeFile(join(dataDir, "kyrei-config.json"), `${JSON.stringify({ workspace }, null, 2)}\n`, "utf8");
  // A marker OUTSIDE the workspace: `dataDir` is a sibling temp dir, so
  // `../<basename(dataDir)>` from the workspace reaches it.
  await writeFile(join(workspace, "inside.txt"), "inside", "utf8");
  await mkdir(join(workspace, "sub"), { recursive: true });
  await writeFile(join(workspace, "sub", "nested.txt"), "nested", "utf8");
  // A real in-workspace entry whose name merely STARTS with two dots. The old
  // `startsWith("..")` fallback rejected this legitimate file.
  await writeFile(join(workspace, "..dotdot"), "not a traversal", "utf8");

  server = await startGateway({
    dataDir,
    preferredPort: 0,
    // Deliberately a bundle WITHOUT `safePath`: that is the fallback branch of
    // `workspacePath`, i.e. the path taken when the engine bundle fails to
    // load. It is the branch that used to be unguarded.
    engineLoader: async () => ({ listModels: () => [] }),
  });
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
    /* ignore close races */
  }
  server = null;
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

async function call(path: string, init?: RequestInit) {
  if (!server) throw new Error("test gateway is not running");
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Kyrei-Gateway-Token": server.token,
      ...(init?.headers ?? {}),
    },
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const complete = (path: string) => call("/api/complete-path", {
  method: "POST",
  body: JSON.stringify({ path }),
});

describe("workspace path guard", () => {
  it("refuses traversal on /api/complete-path instead of listing the parent", async () => {
    // Regression: this endpoint had no fallback guard at all, so with no engine
    // bundle it resolved `../` and happily enumerated the workspace's PARENT.
    const escaped = await complete("../");
    expect(escaped.status).toBe(400);
    expect(escaped.body.entries).toBeUndefined();

    const deep = await complete("../../");
    expect(deep.status).toBe(400);
  });

  it("still returns an empty completion for a directory that does not exist yet", async () => {
    // The user is mid-keystroke. This must NOT be conflated with a traversal.
    const typing = await complete("no-such-dir/frag");
    expect(typing.status).toBe(200);
    expect(typing.body.entries).toEqual([]);
  });

  it("completes real workspace entries", async () => {
    const root = await complete("ins");
    expect(root.status).toBe(200);
    expect(root.body.entries).toEqual([
      { name: "inside.txt", path: "inside.txt", dir: false },
    ]);

    const nested = await complete("sub/nes");
    expect(nested.status).toBe(200);
    expect(nested.body.entries).toEqual([
      { name: "nested.txt", path: "sub/nested.txt", dir: false },
    ]);
  });

  it("does not mistake an in-workspace name beginning with two dots for a traversal", async () => {
    // `relative(workspace, workspace/..dotdot)` is `"..dotdot"`, which passes
    // the old `startsWith("..")` test and was wrongly rejected.
    const hit = await complete("..dot");
    expect(hit.status).toBe(200);
    expect(hit.body.entries).toEqual([
      { name: "..dotdot", path: "..dotdot", dir: false },
    ]);
  });

  it("refuses UNC and Windows drive-relative targets on the explorer endpoints", async () => {
    // These escape `resolve()` without ever producing a `..` segment, so the
    // old `startsWith("..")` fallback let them through on Windows.
    for (const hostile of ["\\\\server\\share", "//server/share", "C:relative"]) {
      expect((await call(`/api/files?path=${encodeURIComponent(hostile)}`)).status).toBe(400);
      expect((await call(`/api/file?path=${encodeURIComponent(hostile)}`)).status).toBe(400);
    }
  });

  it("refuses UNC and drive-relative DIRECTORY parts on /api/complete-path", async () => {
    // completePath jails only the directory part; the trailing fragment is a
    // name filter, never a path. So a hostile value must carry a separator to
    // be a directory at all.
    for (const hostile of ["\\\\server\\share\\x", "//server/share/x", "C:rel/x"]) {
      expect((await complete(hostile)).status).toBe(400);
    }
  });

  it("treats a separator-free fragment as a name filter, not a path", async () => {
    // `C:relative` has no directory component, so there is nothing to escape:
    // it filters the workspace root and matches nothing. Rejecting it would be
    // wrong, and resolving it as a path would be the actual bug.
    const bare = await complete("C:relative");
    expect(bare.status).toBe(200);
    expect(bare.body.entries).toEqual([]);
  });

  it("refuses traversal on the file explorer endpoints", async () => {
    const listing = await call("/api/files?path=..");
    expect(listing.status).toBe(400);

    const read = await call(`/api/file?path=${encodeURIComponent("../secret.txt")}`);
    expect(read.status).toBe(400);
  });

  it("still serves in-workspace files through the explorer endpoints", async () => {
    const listing = await call("/api/files?path=sub");
    expect(listing.status).toBe(200);
    expect(listing.body.entries).toEqual([
      { name: "nested.txt", path: "sub/nested.txt", dir: false },
    ]);

    const read = await call(`/api/file?path=${encodeURIComponent("sub/nested.txt")}`);
    expect(read.status).toBe(200);
    expect(read.body.content).toBe("nested");
  });
});

describe("protected paths apply to reads, not only writes", () => {
  // The jail only proves a path is INSIDE the workspace. `protectedPaths` says
  // a file inside it is still off limits, and it was enforced on writes only —
  // so `GET /api/file?path=.env` returned the file verbatim. The explorer
  // listing hides dotfiles, which made this look safe while a direct request
  // was not.
  /**
   * A FRESH dataDir per case: the suite's shared one already belongs to the
   * stub gateway from `beforeEach`, whose own config write wins over anything
   * we put there afterwards.
   */
  async function guardedGateway(protectedPaths: string[]) {
    await server?.close();
    server = null;
    dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-protected-"));
    await writeFile(join(dataDir, "kyrei-config.json"), `${JSON.stringify({
      workspace,
      engine: { permissions: { protectedPaths } },
    }, null, 2)}\n`, "utf8");
    server = await startGateway({
      dataDir,
      preferredPort: 0,
      // The REAL bundle: `matchesProtectedPath` comes from the engine.
      engineLoader: async () => import("../core/engine/.dist/index.mjs"),
    });
  }

  it("refuses to read a protected file", async () => {
    await writeFile(join(workspace, ".env"), "OPENAI_API_KEY=sk-real-looking-value", "utf8");
    await guardedGateway([".env", "kyrei-secrets.json"]);

    const blocked = await call(`/api/file?path=${encodeURIComponent(".env")}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("path_protected");
  });

  it("still serves an ordinary file when protected paths are configured", async () => {
    await writeFile(join(workspace, "readme.md"), "hello", "utf8");
    await guardedGateway([".env"]);

    const ok = await call(`/api/file?path=${encodeURIComponent("readme.md")}`);
    expect(ok.status).toBe(200);
    expect(ok.body.content).toBe("hello");
  });
});
