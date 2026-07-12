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
import { spawn } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";
import fg from "fast-glob";
import type { EngineConfig } from "../types.js";
import { safePath } from "../security/jail.js";
import { createSandbox, maybeSandbox } from "../security/sandbox.js";
import { TOOL_DESCRIPTIONS } from "../prompt/tool-descriptions.js";
import { parsePatch } from "../apply/parse-patch.js";
import { applyPatch, ApplyError } from "../apply/apply.js";
import { renderFileDiff } from "../apply/diff.js";
import { createSnapshotStore } from "../apply/snapshot.js";
import { detectEcosystem, runVerify } from "../reliability/verify.js";

export interface ToolMeta {
  inlineDiff?: string;
}

const MAX_DIFF_LINES = 2000;
const WRITE_THRESHOLD_LINES = 400;

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

function runCommand(command: string, cwd: string, timeoutMs: number, abortSignal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      out += "\n[превышен таймаут команды]";
    }, timeoutMs);
    const onAbort = () => {
      child.kill();
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (d) => {
      out += d.toString();
    });
    child.stderr?.on("data", (d) => {
      out += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      resolvePromise(`Ошибка запуска: ${err.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      resolvePromise(`(код выхода: ${code})\n${out}`.trim());
    });
  });
}

function runRg(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise) => {
    const child = spawn(rgPath, args, { cwd, windowsHide: true });
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

export function buildTools(
  workspace: string,
  cfg: EngineConfig,
  toolMeta: Map<string, ToolMeta>,
  abortSignal?: AbortSignal,
): ToolSet {
  const snapshots = createSnapshotStore(workspace);
  const sandbox = createSandbox(cfg.sandbox);

  const execListDir = async (path?: string): Promise<string> => {
    const dir = safePath(workspace, path || ".");
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.length ? entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort().join("\n") : "(пусто)";
  };
  const execReadFile = async (path: string): Promise<string> =>
    clip(await readFile(safePath(workspace, path), "utf8"), cfg.maxToolOutput);
  const execGrep = async (a: { query: string; path?: string; glob?: string; maxResults?: number }): Promise<string> => {
    const base = safePath(workspace, a.path || ".");
    const args = ["--json", "--line-number", "-m", String(a.maxResults ?? 100), "--smart-case"];
    if (a.glob) args.push("--glob", a.glob);
    args.push("--", a.query, base);
    const raw = await runRg(args, workspace, abortSignal);
    const hits: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as { type: string; data: { path: { text: string }; line_number: number; lines: { text: string } } };
        if (j.type === "match") {
          const p = relative(workspace, j.data.path.text).replaceAll("\\", "/");
          hits.push(`${p}:${j.data.line_number}: ${j.data.lines.text.trim()}`);
        }
      } catch {
        /* ignore non-json rg lines */
      }
    }
    return clip(hits.join("\n") || "(нет совпадений)", cfg.maxToolOutput);
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
    return safe.slice(0, a.limit ?? 200).join("\n") || "(нет совпадений)";
  };

  return {
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
        const file = safePath(workspace, path);
        const next = String(content ?? "");
        let previous: string | null = null;
        try {
          previous = await readFile(file, "utf8");
        } catch {
          /* new file */
        }
        if (previous !== null && previous.split("\n").length > WRITE_THRESHOLD_LINES) {
          return `Файл ${path} > ${WRITE_THRESHOLD_LINES} строк — используйте edit_file (точечная правка), а не write_file.`;
        }
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, next, "utf8");
        const rel = relative(workspace, file) || path;
        const diff = previous !== null ? lineDiff(previous, next) : "";
        if (diff) toolMeta.set(toolCallId, { inlineDiff: diff });
        return previous === null
          ? `Файл создан: ${rel} (${next.length} символов)`
          : `Файл обновлён: ${rel}`;
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
          return "Пустой/неразобранный патч. Ожидается строка '*** Update File: <путь>' с хунками (@@, ' ', '-', '+').";
        }
        try {
          const report = await applyPatch(workspace, patches, snapshots);
          const rendered = report.files.map((f) =>
            renderFileDiff(f.op === "add" ? "add" : f.op === "delete" ? "delete" : "modify", f.rel, f.oldText, f.newText),
          );
          const combined = rendered.map((r) => `${r.header} (${r.counter})\n${r.body}`).join("\n---\n");
          if (combined) toolMeta.set(toolCallId, { inlineDiff: combined });
          return rendered.map((r) => `${r.header} (${r.counter})`).join("\n");
        } catch (e) {
          if (e instanceof ApplyError) return `Правка отклонена [${e.code}]: ${e.message}`;
          return `Ошибка применения патча: ${(e as Error).message}`;
        }
      },
    }),

    run_command: tool({
      description: TOOL_DESCRIPTIONS.run_command,
      inputSchema: z.object({
        command: z.string().describe("The shell command to execute."),
      }),
      execute: async ({ command }) => {
        const sb = await maybeSandbox(sandbox, { command: String(command ?? ""), cwd: workspace });
        const out = await runCommand(sb.command, workspace, cfg.commandTimeoutMs, abortSignal);
        return clip(out, cfg.maxToolOutput);
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
      inputSchema: z.object({ pattern: z.string(), limit: z.number().optional() }),
      execute: async (a) => execFind(a),
    }),

    diagnostics: tool({
      description: TOOL_DESCRIPTIONS.diagnostics,
      inputSchema: z.object({}),
      execute: async () => {
        const files = (await readdir(workspace).catch(() => [])) as string[];
        const cmds = detectEcosystem(files);
        const pick = cmds.find((c) => c.ecosystem === "typescript") ?? cmds.find((c) => ["python", "rust", "go"].includes(c.ecosystem));
        if (!pick) return "[типчекер/линтер не обнаружен]";
        const r = await runVerify(pick.command, workspace, 60_000);
        return clip(`$ ${pick.command}\n${r.output}`, cfg.maxToolOutput);
      },
    }),

    batch: tool({
      description: TOOL_DESCRIPTIONS.batch,
      inputSchema: z.object({
        calls: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) })).max(16),
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
