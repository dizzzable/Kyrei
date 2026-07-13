/**
 * Tool set (Phase 1: parity with v1 — list_dir/read_file/write_file/run_command,
 * as AI SDK `tool()` + Zod). Ported from core/kyrei-engine.js.
 *
 * inline_diff travels out-of-band: execute writes it into `toolMeta` keyed by
 * toolCallId; the stream-bridge reads it when emitting `tool.complete`. This
 * keeps the model-visible output clean (a string) while the UI still gets the
 * diff — without double-emitting tool events.
 *
 * edit_file / grep_search / find_path / diagnostics / batch land in Phases 2/6.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";
import fg from "fast-glob";
import type { EngineConfig } from "../types.js";
import { safePath, validateWorkspaceTarget, validateWriteTarget } from "../security/jail.js";
import { decideAll, type ActionContext, type Decision } from "../security/permissions.js";
import { runPreHooks, secretScanHook } from "../security/pre-hook.js";
import type { AuditRecord } from "../security/audit.js";
import { createSandbox, maybeSandbox } from "../security/sandbox.js";
import { redact, sanitizeEnv } from "../security/secrets.js";
import { TOOL_DESCRIPTIONS } from "../prompt/tool-descriptions.js";
import { parsePatch } from "../apply/parse-patch.js";
import { applyPatch, ApplyError } from "../apply/apply.js";
import { renderFileDiff } from "../apply/diff.js";
import { createSnapshotStore } from "../apply/snapshot.js";
import { detectEcosystem } from "../reliability/verify.js";
import { buildProjectIntelTools } from "./project-intel.js";

export interface ToolMeta {
  inlineDiff?: string;
}

export interface ToolAuditWriter {
  write(record: AuditRecord): Promise<void>;
}

export interface BuildToolsOptions {
  abortSignal?: AbortSignal;
  audit?: ToolAuditWriter;
  sessionId?: string;
  sensitiveValues?: readonly string[];
}

const MAX_DIFF_LINES = 2000;
const WRITE_THRESHOLD_LINES = 400;

function normalizeBuildOptions(options?: BuildToolsOptions | AbortSignal): BuildToolsOptions {
  if (options && typeof (options as AbortSignal).addEventListener === "function") {
    return { abortSignal: options as AbortSignal };
  }
  return (options as BuildToolsOptions | undefined) ?? {};
}

function blockedResult(decision: Exclude<Decision, "allow">): string {
  return decision === "ask"
    ? "Tool action requires interactive approval, but interactive approval is not available yet; nothing was executed."
    : "Tool action was denied by the local permission policy; nothing was executed.";
}

function clip(text: unknown, limit: number): string {
  const s = String(text ?? "");
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}\n… [вывод обрезан, ${s.length} символов]`;
}

/** Compact LCS-based line diff (' ' context, '-' removed, '+' added). */
function lineDiff(oldStr: string, newStr: string): string {
  const a = oldStr.split("\n");
  const b = newStr.split("\n");
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return "";
  const m = a.length;
  const n = b.length;
  const dp: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = n - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(" " + a[i]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push("-" + a[i]);
      i++;
    } else {
      out.push("+" + b[j]);
      j++;
    }
  }
  while (i < m) out.push("-" + a[i++]);
  while (j < n) out.push("+" + b[j++]);
  return out.join("\n");
}

function abortError(): Error {
  const error = new Error("Tool execution was aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
    return;
  }
  if (process.platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); }
    catch {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }
    return;
  }
  await new Promise<void>((resolvePromise) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    const finish = () => resolvePromise();
    killer.once("error", () => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      finish();
    });
    killer.once("close", finish);
  });
}

function runCommand(command: string, cwd: string, timeoutMs: number, abortSignal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    if (abortSignal?.aborted) {
      reject(abortError());
      return;
    }
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      env: sanitizeEnv(process.env),
    });
    let out = "";
    let settled = false;
    let stoppedBy: "abort" | "timeout" | null = null;
    const cleanup = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (value: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };
    const stop = (reason: "abort" | "timeout") => {
      if (settled || stoppedBy) return;
      stoppedBy = reason;
      void terminateProcessTree(child).then(() => {
        fail(reason === "abort" ? abortError() : new Error("Command timed out"));
      });
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const onAbort = () => stop("abort");
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted) stop("abort");
    child.stdout?.on("data", (data) => { out += data.toString(); });
    child.stderr?.on("data", (data) => { out += data.toString(); });
    child.on("error", (error) => fail(new Error(`Command failed to start: ${error.message}`)));
    child.on("close", (code) => {
      if (stoppedBy === "abort") return fail(abortError());
      if (stoppedBy === "timeout") return fail(new Error("Command timed out"));
      if (code !== 0) return fail(new Error(`Command exited with code ${code}\n${clip(out, 2_000)}`));
      succeed(`(код выхода: ${code})\n${out}`.trim());
    });
  });
}

function runRg(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise) => {
    const child = spawn(rgPath, args, { cwd, windowsHide: true, env: sanitizeEnv(process.env) });
    let out = "";
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("error", () => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(out);
    });
    child.on("close", () => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(out);
    });
  });
}

export function buildTools(workspace: string, cfg: EngineConfig, toolMeta: Map<string, ToolMeta>, optionsOrSignal?: BuildToolsOptions | AbortSignal): ToolSet {
  const options = normalizeBuildOptions(optionsOrSignal);
  const safeClip = (value: unknown, limit: number): string => clip(
    redact(String(value ?? ""), options.sensitiveValues),
    limit,
  );
  const abortSignal = options.abortSignal;
  const snapshots = createSnapshotStore(workspace);
  const sandbox = createSandbox(cfg.sandbox);

  const audit = async (toolName: string, toolCallId: string, record: Omit<AuditRecord, "ts" | "tool" | "toolCallId" | "sessionId">): Promise<void> => {
    try {
      await options.audit?.write({
        ...record,
        ts: new Date().toISOString(),
        tool: toolName,
        toolCallId,
        sessionId: options.sessionId,
      });
    } catch {
      // Audit is best-effort and must never change a policy decision or effect result.
    }
  };

  const executeGuarded = async (
    toolName: "run_command" | "write_file" | "edit_file" | "diagnostics",
    toolCallId: string,
    actions: ActionContext[],
    hookArgs: unknown,
    metadata: Record<string, unknown>,
    effect: () => Promise<string>,
  ): Promise<string> => {
    const started = Date.now();
    const decision = decideAll(cfg.permissions, actions);
    if (decision !== "allow") {
      await audit(toolName, toolCallId, {
        decision,
        status: "denied",
        metadata,
        durationS: (Date.now() - started) / 1000,
      });
      return blockedResult(decision);
    }

    const hookResult = await runPreHooks([secretScanHook], { tool: toolName, args: hookArgs }, true);
    if (!hookResult.allow) {
      await audit(toolName, toolCallId, {
        decision: "deny",
        status: "denied",
        metadata: { ...metadata, blockedBy: "pre-hook" },
        durationS: (Date.now() - started) / 1000,
      });
      return `Tool action was denied by the secret-scan pre-hook; nothing was executed. ${hookResult.reason ?? ""}`.trim();
    }

    await audit(toolName, toolCallId, { decision, status: "start", metadata });
    try {
      if (abortSignal?.aborted) throw abortError();
      const result = await effect();
      await audit(toolName, toolCallId, {
        decision,
        status: "complete",
        metadata,
        durationS: (Date.now() - started) / 1000,
      });
      return safeClip(result, cfg.maxToolOutput);
    } catch (error) {
      await audit(toolName, toolCallId, {
        decision,
        status: isAbortError(error) ? "interrupted" : "error",
        metadata,
        error: error instanceof Error ? error.name : "ToolExecutionError",
        durationS: (Date.now() - started) / 1000,
      });
      throw error;
    }
  };

  const rejectInvalidInput = async (
    toolName: "write_file" | "edit_file",
    toolCallId: string,
    metadata: Record<string, unknown>,
  ): Promise<string> => {
    await audit(toolName, toolCallId, {
      decision: "deny",
      status: "denied",
      metadata,
      error: "InvalidToolTarget",
    });
    return "Tool action was denied because its target is invalid or outside the workspace; nothing was executed.";
  };

  const execListDir = async (path?: string): Promise<string> => {
    const dir = await validateWorkspaceTarget(workspace, path || ".");
    const entries = await readdir(dir, { withFileTypes: true });
    return safeClip(entries.length
      ? entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join("\n")
      : "(пусто)", cfg.maxToolOutput);
  };
  const execReadFile = async (path: string): Promise<string> =>
    safeClip(await readFile(await validateWorkspaceTarget(workspace, path), "utf8"), cfg.fileReadMaxChars);
  const execGrep = async (a: { query: string; path?: string; glob?: string; maxResults?: number }): Promise<string> => {
    const base = await validateWorkspaceTarget(workspace, a.path || ".");
    const args = ["--json", "--line-number", "-m", String(a.maxResults ?? 100), "--smart-case"];
    if (a.glob) args.push("--glob", a.glob);
    args.push("--", a.query, base);
    const raw = await runRg(args, workspace, abortSignal);
    const hits: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as {
          type: string;
          data: {
            path: { text: string };
            line_number: number;
            lines: { text: string };
          };
        };
        if (j.type === "match") {
          const p = relative(workspace, j.data.path.text).replaceAll("\\", "/");
          hits.push(`${p}:${j.data.line_number}: ${j.data.lines.text.trim()}`);
        }
      } catch {
        /* ignore non-json rg lines */
      }
    }
    return safeClip(hits.join("\n") || "(нет совпадений)", cfg.maxToolOutput);
  };
  const execFind = async (a: { pattern: string; limit?: number }): Promise<string> => {
    const entries = await fg(a.pattern.replace(/\\/g, "/"), {
      cwd: workspace,
      dot: false,
      onlyFiles: false,
      followSymbolicLinks: false,
      ignore: ["**/node_modules/**", "**/.git/**", ".kyrei/**"],
      suppressErrors: true,
    });
    const safe = entries.filter((e) => {
      try {
        safePath(workspace, e);
        return true;
      } catch {
        return false;
      }
    });
    return safeClip(safe.slice(0, a.limit ?? 200).join("\n") || "(нет совпадений)", cfg.maxToolOutput);
  };

  return {
    ...buildProjectIntelTools(workspace),
    list_dir: tool({
      description: TOOL_DESCRIPTIONS.list_dir,
      inputSchema: z.object({
        path: z.string().describe("Directory path relative to the workspace root. Use '.' for the root."),
      }),
      execute: async ({ path }) => execListDir(path),
    }),

    read_file: tool({
      description: TOOL_DESCRIPTIONS.read_file,
      inputSchema: z.object({
        path: z.string().describe("File path relative to the workspace root."),
      }),
      execute: async ({ path }) => execReadFile(path),
    }),

    write_file: tool({
      description: TOOL_DESCRIPTIONS.write_file,
      inputSchema: z.object({
        path: z.string().describe("File path relative to the workspace root."),
        content: z.string().describe("Full new content of the file."),
      }),
      execute: async ({ path, content }, { toolCallId }) => {
        const next = String(content ?? "");
        let file: string;
        let canonicalPath: string;
        try {
          file = safePath(workspace, path);
          canonicalPath = relative(workspace, file).replaceAll("\\", "/");
        } catch {
          return rejectInvalidInput("write_file", toolCallId, { pathLength: path.length, contentLength: next.length });
        }
        return executeGuarded("write_file", toolCallId, [{ tool: "write_file", target: canonicalPath }], { path: canonicalPath, content: next }, { path: canonicalPath, contentLength: next.length }, async () => {
          await validateWriteTarget(workspace, canonicalPath);
          if (abortSignal?.aborted) throw abortError();
          let previous: string | null = null;
          try {
            previous = await readFile(file, "utf8");
          } catch {
            /* new file */
          }
          if (previous !== null && previous.split("\n").length > WRITE_THRESHOLD_LINES) {
            return `Файл ${path} > ${WRITE_THRESHOLD_LINES} строк — используйте edit_file (точечная правка), а не write_file.`;
          }
          if (abortSignal?.aborted) throw abortError();
          await validateWriteTarget(workspace, canonicalPath);
          await mkdir(dirname(file), { recursive: true });
          if (abortSignal?.aborted) throw abortError();
          await validateWriteTarget(workspace, canonicalPath);
          await writeFile(file, next, "utf8");
          const rel = relative(workspace, file) || path;
          const diff = previous !== null ? lineDiff(previous, next) : "";
          if (diff) toolMeta.set(toolCallId, { inlineDiff: redact(diff, options.sensitiveValues) });
          return previous === null ? `Файл создан: ${rel} (${next.length} символов)` : `Файл обновлён: ${rel}`;
        });
      },
    }),

    edit_file: tool({
      description: TOOL_DESCRIPTIONS.edit_file,
      inputSchema: z.object({
        patch: z.string().describe("The context-anchored patch (see description)."),
      }),
      execute: async ({ patch }, { toolCallId }) => {
        const patches = parsePatch(patch);
        if (patches.length === 0) {
          return rejectInvalidInput("edit_file", toolCallId, { patchLength: patch.length, targetCount: 0 });
        }
        const canonicalTarget = (target: string): string =>
          relative(workspace, safePath(workspace, target)).replaceAll("\\", "/");
        let actions: ActionContext[];
        try {
          actions = patches.flatMap((filePatch) => [
            { tool: "edit_file", target: canonicalTarget(filePatch.file) },
            ...(filePatch.dest ? [{ tool: "edit_file", target: canonicalTarget(filePatch.dest) }] : []),
          ]);
        } catch {
          return rejectInvalidInput("edit_file", toolCallId, { patchLength: patch.length, targetCount: patches.length });
        }
        const paths = actions.map((action) => action.target!);
        return executeGuarded("edit_file", toolCallId, actions, { patch }, { paths, targetCount: paths.length, patchLength: patch.length }, async () => {
          try {
            const report = await applyPatch(workspace, patches, snapshots, abortSignal);
            const rendered = report.files.map((f) => renderFileDiff(f.op === "add" ? "add" : f.op === "delete" ? "delete" : "modify", f.rel, f.oldText, f.newText));
            const combined = rendered.map((r) => `${r.header} (${r.counter})\n${r.body}`).join("\n---\n");
            if (combined) toolMeta.set(toolCallId, { inlineDiff: redact(combined, options.sensitiveValues) });
            return rendered.map((r) => `${r.header} (${r.counter})`).join("\n");
          } catch (e) {
            if (e instanceof ApplyError) throw new Error(`Правка отклонена [${e.code}]: ${e.message}`);
            throw e;
          }
        });
      },
    }),

    run_command: tool({
      description: TOOL_DESCRIPTIONS.run_command,
      inputSchema: z.object({
        command: z.string().describe("The shell command to execute."),
      }),
      execute: async ({ command }, { toolCallId }) => {
        const exactCommand = String(command ?? "");
        return executeGuarded("run_command", toolCallId, [{ tool: "run_command", command: exactCommand }], { command: exactCommand }, { commandLength: exactCommand.length }, async () => {
          const sb = await maybeSandbox(sandbox, {
            command: exactCommand,
            cwd: workspace,
          }, { required: cfg.sandbox === "strict-required" });
          const out = await runCommand(sb.command, workspace, cfg.commandTimeoutMs, abortSignal);
          return safeClip(out, cfg.maxToolOutput);
        });
      },
    }),

    grep_search: tool({
      description: TOOL_DESCRIPTIONS.grep_search,
      inputSchema: z.object({
        query: z.string(),
        path: z.string().optional(),
        glob: z.string().optional(),
        maxResults: z.number().optional(),
      }),
      execute: async (a) => execGrep(a),
    }),

    find_path: tool({
      description: TOOL_DESCRIPTIONS.find_path,
      inputSchema: z.object({
        pattern: z.string(),
        limit: z.number().optional(),
      }),
      execute: async (a) => execFind(a),
    }),

    diagnostics: tool({
      description: TOOL_DESCRIPTIONS.diagnostics,
      inputSchema: z.object({}),
      execute: async (_args, { toolCallId }) => {
        const files = (await readdir(workspace).catch(() => [])) as string[];
        const cmds = detectEcosystem(files);
        const pick = cmds.find((c) => c.ecosystem === "typescript") ?? cmds.find((c) => ["python", "rust", "go"].includes(c.ecosystem));
        if (!pick) return "[типчекер/линтер не обнаружен]";
        return executeGuarded(
          "diagnostics",
          toolCallId,
          [{ tool: "diagnostics" }, { tool: "run_command", command: pick.command }],
          { command: pick.command },
          { ecosystem: pick.ecosystem, commandLength: pick.command.length },
          async () => {
            const wrapped = await maybeSandbox(
              sandbox,
              { command: pick.command, cwd: workspace },
              { required: cfg.sandbox === "strict-required" },
            );
            return safeClip(`$ ${pick.command}\n${await runCommand(wrapped.command, workspace, 60_000, abortSignal)}`, cfg.maxToolOutput);
          },
        );
      },
    }),

    batch: tool({
      description: TOOL_DESCRIPTIONS.batch,
      inputSchema: z.object({
        calls: z
          .array(
            z.object({
              tool: z.string(),
              args: z.record(z.string(), z.unknown()),
            }),
          )
          .max(16),
      }),
      execute: async ({ calls }) => {
        const dispatch: Record<string, (a: Record<string, unknown>) => Promise<string>> = {
          list_dir: (a) => execListDir(a["path"] as string | undefined),
          read_file: (a) => execReadFile(a["path"] as string),
          grep_search: (a) => execGrep(a as { query: string }),
          find_path: (a) => execFind(a as { pattern: string }),
        };
        const results = await Promise.allSettled(
          calls.map((c) => {
            const fn = dispatch[c.tool];
            return fn ? fn(c.args) : Promise.reject(new Error(`batch: '${c.tool}' не read-only`));
          }),
        );
        return results
          .map((r, i) => {
            const name = calls[i]!.tool;
            if (r.status === "fulfilled") return `## ${name} ✓\n${r.value}`;
            const reason = (r as PromiseRejectedResult).reason;
            return `## ${name} ✗\n${String(reason?.message ?? reason)}`;
          })
          .join("\n\n");
      },
    }),
  };
}
