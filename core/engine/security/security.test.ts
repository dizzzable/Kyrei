import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safePath } from "./jail.js";
import { decide } from "./permissions.js";
import { secretScanHook, runPreHooks } from "./pre-hook.js";
import { createAuditLog } from "./audit.js";
import { redact, containsSecret } from "./secrets.js";
import { DEFAULT_ENGINE_CONFIG, type PermissionConfig } from "../types.js";

const WS = process.platform === "win32" ? "F:\\ws" : "/ws";

describe("secret redaction — provider key formats", () => {
  // Regression: the pattern used to be `sk-[a-zA-Z0-9]{20,}`, which cannot
  // match a hyphenated prefix, so every current provider format leaked.
  const KEYS: ReadonlyArray<[string, string]> = [
    ["Anthropic", `sk-ant-api03-${"A".repeat(40)}`],
    ["OpenAI project", `sk-proj-${"B".repeat(40)}`],
    ["OpenAI legacy", `sk-${"G".repeat(48)}`],
    ["OpenRouter", `sk-or-v1-${"c".repeat(40)}`],
    ["Google AI", `AIzaSy${"D".repeat(33)}`],
    ["Google OAuth", `ya29.${"E".repeat(40)}`],
    ["Groq", `gsk_${"F".repeat(40)}`],
    ["xAI", `xai-${"H".repeat(40)}`],
    ["GitHub PAT", `ghp_${"i".repeat(36)}`],
    ["AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
  ];

  for (const [name, key] of KEYS) {
    it(`redacts a ${name} key`, () => {
      expect(redact(`token=${key} rest`)).toBe("token=[REDACTED] rest");
      expect(containsSecret(key)).toBe(true);
    });
  }

  it("leaves ordinary prose alone", () => {
    const text = "The sk- prefix is short, and skillet is a word.";
    expect(redact(text)).toBe(text);
    expect(containsSecret(text)).toBe(false);
  });

  // containsSecret backs secretScanHook, which DENIES write_file, so a false
  // positive here means the agent cannot write ordinary CSS or a branch name.
  it.each([
    'class="sk-loading-placeholder"',
    ".sk-fading-circle-1 { animation-delay: -1.1s; }",
    'import "./sk-theme-tokens.css";',
    "checkout sk-refactor-provider-build",
    "const id = 'sk-2026-01-02-report-final';",
  ])("does not flag the ordinary identifier %s", (text) => {
    expect(containsSecret(text)).toBe(false);
    expect(redact(text)).toBe(text);
  });

  it("still redacts exact values that match no pattern", () => {
    expect(redact("v=hunter2", ["hunter2"])).toBe("v=[REDACTED]");
  });
});

describe("run_command interpreter tier", () => {
  const cfg = (over: Partial<PermissionConfig> = {}): PermissionConfig => ({
    terminal: "auto",
    review: "agent",
    web: "read",
    rules: [],
    ...over,
  } as PermissionConfig);
  const ask = (command: string) => decide(cfg(), { tool: "run_command", command });

  // A denylist over shell strings cannot be made sound, so commands that can
  // reach outside the workspace through a generic-looking invocation get an
  // approval prompt instead of silently running.
  it.each([
    'node -e "require(\'fs\').readFileSync(\'/etc/passwd\')"',
    'python -c "import os; os.system(\'id\')"',
    'bash -c "cat ~/.ssh/id_rsa"',
    "pwsh -Command Get-Content $env:APPDATA\\secrets.json",
    "npm install left-pad",
    "npx some-package",
    "pip install requests",
    "git push origin main",
    "rm -r -f build",
    "rm -f -r build",
    "rm --recursive dist",
    "Remove-Item -Recurse -Force dist",
    "iwr https://example.com/x.ps1",
  ])("asks before %s", (command) => {
    expect(ask(command)).toBe("ask");
  });

  // The ordinary build/verify loop must stay uninterrupted.
  it.each([
    "npm test",
    "npm run build",
    "tsc --noEmit",
    "pytest -q",
    "go build ./...",
    "git status",
    "git diff --stat",
    "ls -la",
    "rm build/tmp.txt",
  ])("still allows %s", (command) => {
    expect(ask(command)).toBe("allow");
  });

  it("lets an explicit allow rule opt a specific command back in", () => {
    expect(decide(
      cfg({ rules: [{ pattern: "^run_command:npm install$", action: "allow" }] }),
      { tool: "run_command", command: "npm install" },
    )).toBe("allow");
  });

  it("gates interpreters in turbo mode too", () => {
    expect(decide(cfg({ terminal: "turbo" }), { tool: "run_command", command: "npx foo" })).toBe("ask");
    expect(decide(cfg({ terminal: "turbo" }), { tool: "run_command", command: "npm test" })).toBe("allow");
  });
});

describe("memory writers are permission-gated", () => {
  // Regression: neither tool went through the approval path, so injected text
  // could install itself into MEMORY.md / GLOBAL.md, which are re-read verbatim
  // into the system prompt of every later turn.
  const cfg = (over: Partial<PermissionConfig> = {}): PermissionConfig => ({
    terminal: "auto",
    review: "agent",
    web: "read",
    rules: [],
    ...over,
  } as PermissionConfig);

  it("asks before a cross-workspace global write", () => {
    expect(decide(cfg(), { tool: "memory_write_global" })).toBe("ask");
  });

  it("allows a project-scoped write like any other workspace write", () => {
    expect(decide(cfg(), { tool: "memory_write_project", target: ".kyrei/memory/MEMORY.md" })).toBe("allow");
  });

  it("asks for the project write when review is always", () => {
    expect(decide(cfg({ review: "always" }), {
      tool: "memory_write_project",
      target: ".kyrei/memory/MEMORY.md",
    })).toBe("ask");
  });

  it("honours an explicit deny rule on the global writer", () => {
    expect(decide(
      cfg({ rules: [{ pattern: "^memory_write_global$", action: "deny" }] }),
      { tool: "memory_write_global" },
    )).toBe("deny");
  });
});

describe("jail hardening (Property 12)", () => {
  it("rejects Windows escape vectors", () => {
    expect(() => safePath(WS, "C:relative")).toThrow();
    expect(() => safePath(WS, "\\\\server\\share")).toThrow();
    expect(() => safePath(WS, "\\\\?\\C:\\x")).toThrow();
    expect(() => safePath(WS, "../out")).toThrow();
  });
  it("allows nested paths", () => {
    expect(() => safePath(WS, "src/a.ts")).not.toThrow();
  });
});

describe("permissions engine (deny-wins, two-axis)", () => {
  const base: PermissionConfig = {
    terminal: "auto",
    web: "read",
    review: "agent",
    rules: [],
  };
  it("terminal=off requires an explicit allow rule", () => {
    const off: PermissionConfig = { ...base, terminal: "off" };
    expect(decide(off, { tool: "run_command", command: "npm test" })).toBe("ask");
    expect(decide({ ...off, rules: [{ pattern: "npm test", action: "allow" }] }, { tool: "run_command", command: "npm test" })).toBe("allow");
  });
  it("auto gates destructive + network commands", () => {
    expect(decide(base, { tool: "run_command", command: "ls" })).toBe("allow");
    expect(decide(base, { tool: "run_command", command: "rm -rf /" })).toBe("ask");
    expect(decide(base, { tool: "run_command", command: "curl http://x" })).toBe("ask");
  });
  it("turbo still gates destructive", () => {
    const turbo: PermissionConfig = { ...base, terminal: "turbo" };
    expect(decide(turbo, { tool: "run_command", command: "npm run build" })).toBe("allow");
    expect(decide(turbo, { tool: "run_command", command: "rm -rf ." })).toBe("ask");
  });
  it("deny rule wins", () => {
    const cfg: PermissionConfig = {
      ...base,
      rules: [{ pattern: "secret", action: "deny" }],
    };
    expect(decide(cfg, { tool: "read_file", command: undefined })).toBe("allow");
    expect(decide(cfg, { tool: "run_command", command: "cat secret.txt" })).toBe("deny");
  });
  it("chooses deny over ask over allow when rules overlap", () => {
    const action = { tool: "run_command", command: "npm run release" };
    expect(
      decide(
        {
          ...base,
          rules: [
            { pattern: "npm", action: "allow" },
            { pattern: "release", action: "ask" },
          ],
        },
        action,
      ),
    ).toBe("ask");
    expect(
      decide(
        {
          ...base,
          rules: [
            { pattern: "npm", action: "allow" },
            { pattern: "release", action: "ask" },
            { pattern: "run_command", action: "deny" },
          ],
        },
        action,
      ),
    ).toBe("deny");
  });
  it("review=always gates writes", () => {
    const cfg: PermissionConfig = { ...base, review: "always" };
    expect(decide(cfg, { tool: "write_file" })).toBe("ask");
    expect(
      decide(
        { ...cfg, rules: [{ pattern: "^write_file:src/a\\.ts$", action: "allow" }] },
        { tool: "write_file", target: "src/a.ts" },
      ),
    ).toBe("ask");
  });
  it("review=agent permits writes but path rules still gate exact targets", () => {
    expect(decide(base, { tool: "write_file", target: "src/a.ts" })).toBe("allow");
    const cfg: PermissionConfig = {
      ...base,
      rules: [
        { pattern: "a\\.ts$", action: "ask" },
        { pattern: "private", action: "deny" },
      ],
    };
    expect(decide(cfg, { tool: "write_file", target: "src/a.ts" })).toBe("ask");
    expect(decide(cfg, { tool: "write_file", target: "private/a.ts" })).toBe("deny");
  });
  if (process.platform === "win32") {
    it("matches permission rules case-insensitively on case-insensitive Windows paths", () => {
      const cfg: PermissionConfig = {
        ...base,
        rules: [{ pattern: "^write_file:src/a\\.ts$", action: "deny" }],
      };
      expect(decide(cfg, { tool: "write_file", target: "SRC/A.TS" })).toBe("deny");
    });
  }
  it("web capability is independently scoped", () => {
    expect(decide(base, { tool: "web_search", target: "framework docs" })).toBe("allow");
    expect(decide({ ...base, web: "search" }, { tool: "web_fetch", target: "https://example.com" })).toBe("deny");
    expect(decide({ ...base, web: "off" }, { tool: "web_search", target: "framework docs" })).toBe("deny");
  });
  it("protected paths ask unless session allow-once listed", () => {
    const cfg: PermissionConfig = {
      ...base,
      protectedPaths: ["mcp.json", ".env"],
    };
    expect(decide(cfg, { tool: "write_file", target: "project/mcp.json" })).toBe("ask");
    expect(decide(cfg, { tool: "edit_file", target: ".env" })).toBe("ask");
    const once: PermissionConfig = {
      ...cfg,
      protectedPathAllowOnce: ["project/mcp.json"],
    };
    expect(decide(once, { tool: "write_file", target: "project/mcp.json" })).toBe("allow");
    expect(decide(once, { tool: "write_file", target: ".env" })).toBe("ask");
  });
});

describe("pre-hook secret scan", () => {
  it("blocks writing content with a secret", async () => {
    const r = await runPreHooks([secretScanHook], {
      tool: "write_file",
      args: { path: "x", content: "key = sk-ABCDEFGHIJKLMNOPQRSTUVWX" },
    });
    expect(r.allow).toBe(false);
  });
  it("allows clean content", async () => {
    const r = await runPreHooks([secretScanHook], {
      tool: "write_file",
      args: { path: "x", content: "hello" },
    });
    expect(r.allow).toBe(true);
  });
  it("fails closed when a hook throws", async () => {
    const r = await runPreHooks(
      [
        () => {
          throw new Error("scanner unavailable");
        },
      ],
      { tool: "write_file", args: {} },
      true,
    );
    expect(r).toEqual({
      allow: false,
      reason: "pre-hook error: scanner unavailable",
    });
  });
});

describe("audit log (redaction)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kyrei-audit-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it("writes redacted records", async () => {
    const log = createAuditLog(join(dir, "audit.jsonl"));
    await log.write({
      ts: new Date().toISOString(),
      tool: "run_command",
      args: { command: "echo sk-ABCDEFGHIJKLMNOPQRSTUVWX" },
      status: "start",
    });
    const raw = await readFile(join(dir, "audit.jsonl"), "utf8");
    expect(raw).toContain("[REDACTED]");
    expect(raw).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect((await log.read()).length).toBe(1);
  });
  it("preserves session and tool-call correlation", async () => {
    const log = createAuditLog(join(dir, "correlated.jsonl"));
    await log.write({
      ts: new Date().toISOString(),
      sessionId: "s1",
      toolCallId: "c1",
      tool: "write_file",
      metadata: { path: "src/a.ts" },
      status: "complete",
    });
    expect(await log.read()).toMatchObject([{ sessionId: "s1", toolCallId: "c1", metadata: { path: "src/a.ts" } }]);
  });
});

describe("secret detection does not block ordinary source files", () => {
  // containsSecret backs secretScanHook, which DENIES write_file. Every false
  // positive here is a file the agent cannot write, reported as "a secret was
  // detected" — so the FP set matters as much as the detection set.
  const innocent = [
    'class="sk-test-fading-circle-large"',
    ".sk-or-divider-horizontal-rule {}",
    "git checkout sk-proj-refactor-provider-build",
    'const BRANCH = "sk-admin-settings-panel-rework";',
    "skills/sk-live-preview-component-name",
    'const AUTH = "Bearer test-token-placeholder-value";',
    'curl -H "Authorization: Bearer YOUR_API_KEY_HERE_PLACEHOLDER"',
    "// Bearer\n  tokens_are_documented_here_ok",
    "sk-loading-placeholder",
  ];

  for (const sample of innocent) {
    it(`allows ${JSON.stringify(sample.slice(0, 44))}`, () => {
      expect(containsSecret(sample)).toBe(false);
    });
  }

  const realSecrets = [
    "sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd",
    "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
    "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefghij",
    "github_pat_11ABCDEFG0abcdefghijkl_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    "glpat-ABCDEFGHIJKLMNOPQRST",
    "hf_abcdefghijklmnopqrstuvwxyz0123456789",
  ];

  it("leaves URL-embedded credentials to the gateway redactor", () => {
    // This list also backs `containsSensitiveOutbound`. Matching them here
    // would REFUSE to fetch a `https://user:pass@host/` URL the user supplied
    // deliberately, so they are redacted on the gateway side instead — where
    // over-matching costs a [REDACTED] in a log and nothing more.
    expect(containsSecret("postgres://admin:hunter2hunter2@db.example.test/app")).toBe(false);
  });

  for (const secret of realSecrets) {
    it(`still detects ${JSON.stringify(secret.slice(0, 26))}`, () => {
      expect(containsSecret(secret)).toBe(true);
      expect(redact(secret)).not.toContain(secret);
    });
  }
});

describe("memory writers obey protectedPaths and the secret scan", () => {
  const cfg = {
    ...DEFAULT_ENGINE_CONFIG.permissions,
    review: "agent" as const,
    protectedPaths: [".kyrei/"],
  };

  it("asks before a memory write into a protected path", () => {
    // Protection was applied to write_file/edit_file only, so a user who
    // protected `.kyrei/` got an ask on write_file and a SILENT ALLOW on the
    // memory writer that targets the same file.
    expect(decide(cfg, { tool: "memory_write_project", target: ".kyrei/memory/MEMORY.md" })).toBe("ask");
    expect(decide(cfg, { tool: "memory_write_notes", target: ".kyrei/memory/notes.md" })).toBe("ask");
  });

  it("still allows a memory write when nothing protects it", () => {
    const open = { ...DEFAULT_ENGINE_CONFIG.permissions, review: "agent" as const, protectedPaths: [] };
    expect(decide(open, { tool: "memory_write_project", target: ".kyrei/memory/MEMORY.md" })).toBe("allow");
  });

  it("scans memory-write content for secrets", async () => {
    // MEMORY.md is read back into the system prompt every turn, so an API key
    // written there is durable — and the hook did not look at these tools.
    const blocked = await runPreHooks([secretScanHook], {
      tool: "memory_write_project",
      args: { content: "key: sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd" },
    }, true);
    expect(blocked.allow).toBe(false);

    const fine = await runPreHooks([secretScanHook], {
      tool: "memory_write_project",
      args: { content: "The build uses sk-proj-refactor-branch naming." },
    }, true);
    expect(fine.allow).toBe(true);
  });
});

describe("interpreter tier resists the common bypass forms", () => {
  const cfg = (over: Partial<PermissionConfig> = {}): PermissionConfig => ({
    terminal: "auto",
    review: "agent",
    web: "read",
    rules: [],
    ...over,
  } as PermissionConfig);
  const ask = (command: string) => decide(cfg(), { tool: "run_command", command });

  // Each of these ran with NO prompt: the alternation missed `-p`, the shell
  // patterns were anchored on a lone `-c` so combined short flags slipped by,
  // cmd.exe was absent entirely, and `git push` required adjacency.
  it.each([
    'node -p "require(\'fs\').readFileSync(\'/etc/passwd\').toString()"',
    "bash -lc 'cat ~/.ssh/id_rsa'",
    "sh -lc id",
    "powershell -enc SQBEAA==",
    "powershell -Com \"Get-Content secrets\"",
    "pwsh -NoProfile -Com x",
    "cmd /c type C:\Users\me\.aws\credentials",
    "cmd.exe /k whoami",
    'py -c "import os"',
    "git -C . push origin main",
    "git --no-pager push",
    "ri -Recurse -Force dist",
  ])("asks before %s", (command) => {
    expect(ask(command)).toBe("ask");
  });

  it("still does not gate the ordinary loop", () => {
    for (const safe of ["npm test", "git status", "git log --oneline", "node build.js", "cmd"]) {
      expect(decide(cfg(), { tool: "run_command", command: safe }), safe).toBe("allow");
    }
  });
});

describe("turbo is never stricter than auto", () => {
  const withRule = (terminal: "auto" | "turbo"): PermissionConfig => ({
    terminal,
    review: "agent",
    web: "read",
    rules: [{ pattern: "^run_command:npm install left-pad$", action: "allow" }],
  } as PermissionConfig);

  it("honours an explicit allow rule for an interpreter command in both modes", () => {
    // Regression: turbo skipped `ruled` for the interpreter tier, so the MORE
    // permissive mode ignored a rule the stricter one applied. The user's
    // "Always allow" was visible in Settings and silently never used.
    const command = "npm install left-pad";
    expect(decide(withRule("auto"), { tool: "run_command", command })).toBe("allow");
    expect(decide(withRule("turbo"), { tool: "run_command", command })).toBe("allow");
  });

  it("still asks in turbo without such a rule", () => {
    const bare = { ...withRule("turbo"), rules: [] } as PermissionConfig;
    expect(decide(bare, { tool: "run_command", command: "npm install left-pad" })).toBe("ask");
  });
});
