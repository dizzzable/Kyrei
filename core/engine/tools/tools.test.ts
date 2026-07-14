import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSet } from "ai";
import { buildTools, type ToolMeta } from "./index.js";
import { DEFAULT_ENGINE_CONFIG } from "../types.js";
import type { AuditRecord } from "../security/audit.js";

let ws: string;
let tools: ToolSet;

async function exec(name: string, args: unknown): Promise<string> {
  return execFrom(tools, name, args);
}

async function execFrom(toolSet: ToolSet, name: string, args: unknown, toolCallId = "t"): Promise<string> {
  const t = toolSet[name] as {
    execute: (a: unknown, o: unknown) => Promise<unknown>;
  };
  const out = await t.execute(args, { toolCallId, messages: [] });
  return String(out);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

describe("tools — guarded mutations and audit", () => {
  it("fails closed for commands requiring approval without running them", async () => {
    const cfg = {
      ...DEFAULT_ENGINE_CONFIG,
      permissions: {
        ...DEFAULT_ENGINE_CONFIG.permissions,
        terminal: "off" as const,
      },
    };
    const records: AuditRecord[] = [];
    const audit = {
      write: async (record: AuditRecord) => void records.push(record),
    };
    const commandRunner = { run: vi.fn(async () => "must not run") };
    const guarded = buildTools(ws, cfg, new Map(), {
      audit,
      sessionId: "session-a",
      commandRunner,
    });
    const command = `node -e "require('node:fs').writeFileSync('command-ran.txt','yes')"`;
    const out = await execFrom(guarded, "run_command", { command }, "call-denied");
    expect(out).toContain("interactive approval");
    expect(out).toContain("nothing was executed");
    expect(await exists(join(ws, "command-ran.txt"))).toBe(false);
    expect(commandRunner.run).not.toHaveBeenCalled();
    expect(records).toMatchObject([{ sessionId: "session-a", toolCallId: "call-denied", status: "denied" }]);
    expect(JSON.stringify(records)).not.toContain(command);
  });

  it("executes an allowed safe command and audits its lifecycle", async () => {
    const records: AuditRecord[] = [];
    const commandRunner = { run: vi.fn(async () => "(exit code: 0)\nallowed-command") };
    const guarded = buildTools(ws, DEFAULT_ENGINE_CONFIG, new Map(), {
      audit: { write: async (record) => void records.push(record) },
      sessionId: "session-safe",
      actorId: "main",
      commandRunner,
    });

    const out = await execFrom(
      guarded,
      "run_command",
      { command: `node -e "console.log('allowed-command')"` },
      "call-safe",
    );

    expect(out).toContain("allowed-command");
    expect(commandRunner.run).toHaveBeenCalledTimes(1);
    expect(commandRunner.run).toHaveBeenCalledWith(expect.objectContaining({
      command: `node -e "console.log('allowed-command')"`,
      cwd: ws,
      timeoutMs: DEFAULT_ENGINE_CONFIG.commandTimeoutMs,
      ownerId: "session-safe",
      actorId: "main",
      toolCallId: "call-safe",
    }));
    expect(records.map((record) => record.status)).toEqual(["start", "complete"]);
    expect(records[0]).toMatchObject({
      sessionId: "session-safe",
      toolCallId: "call-safe",
      decision: "allow",
    });
  });

  it("does not invoke the internal command runner for an explicit deny rule", async () => {
    const commandRunner = { run: vi.fn(async () => "must not run") };
    const guarded = buildTools(ws, {
      ...DEFAULT_ENGINE_CONFIG,
      permissions: {
        ...DEFAULT_ENGINE_CONFIG.permissions,
        rules: [{ pattern: "^run_command:", action: "deny" as const }],
      },
    }, new Map(), {
      sessionId: "session-denied",
      commandRunner,
    });

    const out = await execFrom(guarded, "run_command", { command: "npm test" }, "call-denied-rule");
    expect(out).toContain("denied by the local permission policy");
    expect(commandRunner.run).not.toHaveBeenCalled();
  });

  it("does not inherit arbitrary parent credentials into agent commands", async () => {
    const previousDatabase = process.env.DATABASE_URL;
    const previousCustom = process.env.CUSTOM_CREDENTIAL;
    process.env.DATABASE_URL = "postgres://user:password@db/private";
    process.env.CUSTOM_CREDENTIAL = "custom-local-secret";
    try {
      const guarded = buildTools(ws, DEFAULT_ENGINE_CONFIG, new Map());
      const out = await execFrom(guarded, "run_command", {
        command: "node -e \"console.log(process.env.DATABASE_URL, process.env.CUSTOM_CREDENTIAL)\"",
      });
      expect(out).toContain("undefined undefined");
      expect(out).not.toContain("postgres://");
      expect(out).not.toContain("custom-local-secret");
    } finally {
      if (previousDatabase == null) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabase;
      if (previousCustom == null) delete process.env.CUSTOM_CREDENTIAL;
      else process.env.CUSTOM_CREDENTIAL = previousCustom;
    }
  });

  it("redacts exact runtime credentials of any length from tool output", async () => {
    const guarded = buildTools(ws, DEFAULT_ENGINE_CONFIG, new Map(), {
      sensitiveValues: ["x", "tiny"],
    });
    const out = await execFrom(guarded, "run_command", {
      command: "node -e \"console.log('x tiny')\"",
    });
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("tiny");
  });

  it("routes diagnostics through terminal policy", async () => {
    await writeFile(join(ws, "tsconfig.json"), "{}", "utf8");
    const guarded = buildTools(
      ws,
      {
        ...DEFAULT_ENGINE_CONFIG,
        permissions: { ...DEFAULT_ENGINE_CONFIG.permissions, terminal: "off" },
      },
      new Map(),
    );

    const out = await execFrom(guarded, "diagnostics", {});
    expect(out).toContain("interactive approval");
    expect(out).toContain("nothing was executed");

    const ruleDenied = buildTools(
      ws,
      {
        ...DEFAULT_ENGINE_CONFIG,
        permissions: {
          ...DEFAULT_ENGINE_CONFIG.permissions,
          terminal: "turbo",
          rules: [{ pattern: "^diagnostics$", action: "deny" }],
        },
      },
      new Map(),
    );
    expect(await execFrom(ruleDenied, "diagnostics", {})).toContain("denied by the local permission policy");
  });

  it("routes allowed diagnostics through the same internal command process", async () => {
    await writeFile(join(ws, "tsconfig.json"), "{}", "utf8");
    const commandRunner = { run: vi.fn(async () => "(exit code: 0)\nclean") };
    const guarded = buildTools(ws, DEFAULT_ENGINE_CONFIG, new Map(), {
      sessionId: "session-diagnostics",
      actorId: "main",
      commandRunner,
    });

    await execFrom(guarded, "diagnostics", {}, "call-diagnostics");
    expect(commandRunner.run).toHaveBeenCalledTimes(1);
    expect(commandRunner.run).toHaveBeenCalledWith(expect.objectContaining({
      cwd: ws,
      timeoutMs: 60_000,
      ownerId: "session-diagnostics",
      actorId: "main",
      toolCallId: "call-diagnostics",
    }));
  });

  it("treats a pre-aborted signal as an effect barrier", async () => {
    const controller = new AbortController();
    controller.abort();
    const records: AuditRecord[] = [];
    const guarded = buildTools(ws, DEFAULT_ENGINE_CONFIG, new Map(), {
      abortSignal: controller.signal,
      audit: { write: async (record) => void records.push(record) },
    });
    const before = await readFile(join(ws, "src", "a.ts"), "utf8");

    await expect(
      execFrom(guarded, "write_file", { path: "aborted.txt", content: "no" }, "abort-write"),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      execFrom(guarded, "edit_file", {
        patch: [
          "*** Begin Patch",
          "*** Update File: src/a.ts",
          "@@",
          "-export const foo = 1;",
          "+export const foo = 99;",
          " export const bar = 2;",
          "*** End Patch",
        ].join("\n"),
      }, "abort-edit"),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      execFrom(guarded, "run_command", {
        command: `node -e "require('node:fs').writeFileSync('aborted-command.txt','no')"`,
      }, "abort-command"),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(await exists(join(ws, "aborted.txt"))).toBe(false);
    expect(await exists(join(ws, "aborted-command.txt"))).toBe(false);
    expect(await readFile(join(ws, "src", "a.ts"), "utf8")).toBe(before);
    expect(records.filter((record) => record.status === "interrupted")).toHaveLength(3);
  });

  it("terminates a running command tree on cancellation", async () => {
    const controller = new AbortController();
    const records: AuditRecord[] = [];
    const guarded = buildTools(ws, DEFAULT_ENGINE_CONFIG, new Map(), {
      abortSignal: controller.signal,
      audit: { write: async (record) => void records.push(record) },
    });
    const pending = execFrom(guarded, "run_command", {
      command: `node -e "setTimeout(()=>require('node:fs').writeFileSync('late-child.txt','x'),500)"`,
    }, "abort-tree");
    setTimeout(() => controller.abort(), 75);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 650));
    expect(await exists(join(ws, "late-child.txt"))).toBe(false);
    expect(records.at(-1)).toMatchObject({ toolCallId: "abort-tree", status: "interrupted" });
  });

  it("blocks review and path-rule writes before mutation", async () => {
    const review = buildTools(
      ws,
      {
        ...DEFAULT_ENGINE_CONFIG,
        permissions: {
          ...DEFAULT_ENGINE_CONFIG.permissions,
          review: "always" as const,
        },
      },
      new Map(),
    );
    expect(
      await execFrom(review, "write_file", {
        path: "blocked.txt",
        content: "x",
      }),
    ).toContain("interactive approval");
    expect(await exists(join(ws, "blocked.txt"))).toBe(false);

    const deny = buildTools(
      ws,
      {
        ...DEFAULT_ENGINE_CONFIG,
        permissions: {
          ...DEFAULT_ENGINE_CONFIG.permissions,
          rules: [{ pattern: "^write_file:src/a\\.ts$", action: "deny" as const }],
        },
      },
      new Map(),
    );
    const before = await readFile(join(ws, "src", "a.ts"), "utf8");
    expect(
      await execFrom(deny, "write_file", {
        path: "./src/a.ts",
        content: "changed",
      }),
    ).toContain("denied by the local permission policy");
    expect(await readFile(join(ws, "src", "a.ts"), "utf8")).toBe(before);
  });

  it("secret-scans writes and patches before mutation", async () => {
    const guarded = buildTools(ws, DEFAULT_ENGINE_CONFIG, new Map());
    expect(
      await execFrom(guarded, "write_file", {
        path: "new/secret.txt",
        content: "token = sk-ABCDEFGHIJKLMNOPQRSTUVWX",
      }),
    ).toContain("secret");
    expect(await exists(join(ws, "new"))).toBe(false);
    const before = await readFile(join(ws, "src", "a.ts"), "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-export const foo = 1;",
      "+export const foo = 'sk-ABCDEFGHIJKLMNOPQRSTUVWX';",
      " export const bar = 2;",
      "*** End Patch",
    ].join("\n");
    expect(await execFrom(guarded, "edit_file", { patch })).toContain("secret");
    expect(await readFile(join(ws, "src", "a.ts"), "utf8")).toBe(before);
  });

  it("uses the strongest target decision and blocks multi-file edits atomically", async () => {
    const cfg = {
      ...DEFAULT_ENGINE_CONFIG,
      permissions: {
        ...DEFAULT_ENGINE_CONFIG.permissions,
        rules: [{ pattern: "^edit_file:src/b\\.ts$", action: "deny" as const }],
      },
    };
    const guarded = buildTools(ws, cfg, new Map());
    const beforeA = await readFile(join(ws, "src", "a.ts"), "utf8");
    const beforeB = await readFile(join(ws, "src", "b.ts"), "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-export const foo = 1;",
      "+export const foo = 10;",
      " export const bar = 2;",
      "*** Update File: src/b.ts",
      "@@",
      "-console.log('hello');",
      "+console.log('changed');",
      "*** End Patch",
    ].join("\n");
    expect(await execFrom(guarded, "edit_file", { patch })).toContain("denied by the local permission policy");
    expect(await readFile(join(ws, "src", "a.ts"), "utf8")).toBe(beforeA);
    expect(await readFile(join(ws, "src", "b.ts"), "utf8")).toBe(beforeB);
  });

  it("records metadata-only start/complete audit and ignores sink failures", async () => {
    const records: AuditRecord[] = [];
    const content = "unique-file-content-payload";
    const guarded = buildTools(ws, DEFAULT_ENGINE_CONFIG, new Map(), {
      audit: { write: async (r) => void records.push(r) },
      sessionId: "s1",
    });
    await execFrom(guarded, "write_file", { path: "audit.txt", content }, "write-1");
    expect(records.map((r) => r.status)).toEqual(["start", "complete"]);
    expect(records[0]).toMatchObject({
      sessionId: "s1",
      toolCallId: "write-1",
      metadata: { path: "audit.txt", contentLength: content.length },
    });
    expect(JSON.stringify(records)).not.toContain(content);

    const brokenAudit = {
      write: async () => {
        throw new Error("unavailable");
      },
    };
    const resilient = buildTools(ws, DEFAULT_ENGINE_CONFIG, new Map(), {
      audit: brokenAudit,
    });
    await expect(
      execFrom(resilient, "write_file", {
        path: "resilient.txt",
        content: "ok",
      }),
    ).resolves.toContain("resilient.txt");
  });
});

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "kyrei-tools-"));
  await mkdir(join(ws, "src"), { recursive: true });
  await writeFile(join(ws, "src", "a.ts"), "export const foo = 1;\nexport const bar = 2;\n", "utf8");
  await writeFile(join(ws, "src", "b.ts"), "console.log('hello');\n", "utf8");
  tools = buildTools(ws, DEFAULT_ENGINE_CONFIG, new Map<string, ToolMeta>());
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("tools — read-only search", () => {
  it("list_dir lists the root", async () => {
    expect(await exec("list_dir", { path: "." })).toContain("src/");
  });
  it("read_file reads content", async () => {
    expect(await exec("read_file", { path: "src/a.ts" })).toContain("foo");
  });
  it("find_path globs TS files", async () => {
    const out = await exec("find_path", { pattern: "src/**/*.ts" });
    expect(out).toContain("a.ts");
    expect(out).toContain("b.ts");
  });
  it("grep_search finds matches via ripgrep", async () => {
    const out = await exec("grep_search", { query: "foo" });
    expect(out).toContain("a.ts");
  });
});

describe("tools — batch (partial success, read-only only)", () => {
  it("runs read-only tools in parallel", async () => {
    const out = await exec("batch", {
      calls: [
        { tool: "read_file", args: { path: "src/a.ts" } },
        { tool: "find_path", args: { pattern: "src/**/*.ts" } },
      ],
    });
    expect(out).toContain("read_file ✓");
    expect(out).toContain("find_path ✓");
  });
  it("rejects non-read-only tools", async () => {
    const out = await exec("batch", {
      calls: [{ tool: "write_file", args: { path: "x", content: "y" } }],
    });
    expect(out).toContain("write_file ✗");
    expect(out).toContain("не read-only");
  });
});
