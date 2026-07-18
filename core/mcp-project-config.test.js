import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mergeMcpScopes,
  readProjectMcpConfig,
  writeProjectMcpConfig,
} from "./mcp-project-config.js";

describe("workspace MCP configuration", () => {
  it("keeps global and trusted project servers separate, with project overrides", () => {
    const merged = mergeMcpScopes(
      {
        enabled: true,
        timeoutMs: 30_000,
        servers: [
          { id: "github", command: "global-github" },
          { id: "docs", command: "global-docs" },
        ],
      },
      {
        valid: true,
        config: {
          enabled: true,
          servers: [
            { id: "github", command: "project-github" },
            { id: "local-db", command: "project-db" },
          ],
        },
      },
      { projectTrusted: true },
    );
    expect(merged.servers).toEqual([
      { id: "docs", command: "global-docs", source: "global" },
      { id: "github", command: "project-github", source: "project" },
      { id: "local-db", command: "project-db", source: "project" },
    ]);
    expect(merged.enabled).toBe(true);
  });

  it("does not activate repository MCP commands before the workspace is trusted", () => {
    const merged = mergeMcpScopes(
      { enabled: true, servers: [{ id: "safe", command: "safe" }] },
      { valid: true, config: { enabled: true, servers: [{ id: "repo", command: "untrusted" }] } },
    );
    expect(merged.servers).toEqual([{ id: "safe", command: "safe", source: "global" }]);
  });

  it("stores project configuration in the Kyrei-owned workspace directory", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kyrei-project-mcp-"));
    try {
      await writeProjectMcpConfig(workspace, {
        enabled: true,
        servers: [{ id: "project", command: "node", args: ["server.mjs"] }],
      });
      const stored = await readProjectMcpConfig(workspace);
      expect(stored).toMatchObject({ exists: true, valid: true, config: { enabled: true } });
      expect(stored.config.servers).toEqual([{ id: "project", command: "node", args: ["server.mjs"] }]);
      expect(await readFile(join(workspace, ".kyrei", "mcp.json"), "utf8")).toContain('"version": 1');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked .kyrei root instead of following it outside the project", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kyrei-project-mcp-"));
    const outside = await mkdtemp(join(tmpdir(), "kyrei-project-mcp-outside-"));
    try {
      try {
        await symlink(outside, join(workspace, ".kyrei"), "junction");
      } catch {
        return; // Symlink privileges vary on Windows CI; ownership is covered above.
      }
      await expect(readProjectMcpConfig(workspace)).rejects.toMatchObject({ code: "project_mcp_root_unavailable" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
