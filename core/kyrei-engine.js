import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { spawn } from "node:child_process";

/**
 * Kyrei Engine — the built-in agent core.
 *
 * Owns the agent loop: exposes workspace-scoped tools to the LLM (OpenAI
 * function calling), executes the tool calls the model requests, feeds results
 * back, and repeats until a final answer. Streams tokens from the provider and
 * emits structured events through an `emit(event)` sink so any transport can
 * relay them. Returns { text, parts } for durable persistence.
 *
 * Events: message.start | message.delta{text} | reasoning.delta{text}
 *         tool.start{tool_call_id,name,args} | tool.complete{...,inline_diff}
 *         message.complete{text,status,usage} | error{message}
 */

const MAX_STEPS = 8;
const MAX_TOOL_OUTPUT = 12_000;
const COMMAND_TIMEOUT_MS = 60_000;
const MAX_DIFF_LINES = 2000;

const TOOL_SCHEMAS = [
  { type: "function", function: { name: "list_dir", description: "List files and folders inside a directory of the workspace.", parameters: { type: "object", properties: { path: { type: "string", description: "Directory path relative to the workspace root. Use '.' for the root." } }, required: ["path"] } } },
  { type: "function", function: { name: "read_file", description: "Read the UTF-8 text content of a file in the workspace.", parameters: { type: "object", properties: { path: { type: "string", description: "File path relative to the workspace root." } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Create or overwrite a text file in the workspace. Parent folders are created automatically.", parameters: { type: "object", properties: { path: { type: "string", description: "File path relative to the workspace root." }, content: { type: "string", description: "Full new content of the file." } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "run_command", description: "Run a shell command in the workspace root and return its combined stdout/stderr.", parameters: { type: "object", properties: { command: { type: "string", description: "The shell command to execute." } }, required: ["command"] } } },
];

function clip(text) {
  const s = String(text ?? "");
  return s.length > MAX_TOOL_OUTPUT ? `${s.slice(0, MAX_TOOL_OUTPUT)}\n… [вывод обрезан, ${s.length} символов]` : s;
}

function safePath(workspace, target) {
  const abs = resolve(workspace, target ?? ".");
  const rel = relative(workspace, abs);
  if (rel.startsWith("..") || (rel.length > 1 && rel[0] === "." && rel[1] === ".")) {
    throw new Error(`Путь вне рабочей папки запрещён: ${target}`);
  }
  return abs;
}

/** Compact LCS-based unified-ish line diff (prefixes: ' ' context, '-' removed, '+' added). */
function lineDiff(oldStr, newStr) {
  const a = oldStr.split("\n");
  const b = newStr.split("\n");
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return "";
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push(" " + a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push("-" + a[i]); i++; }
    else { out.push("+" + b[j]); j++; }
  }
  while (i < m) out.push("-" + a[i++]);
  while (j < n) out.push("+" + b[j++]);
  return out.join("\n");
}

function runCommand(command, cwd) {
  return new Promise(resolvePromise => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let out = "";
    const timer = setTimeout(() => { child.kill(); out += "\n[превышен таймаут команды]"; }, COMMAND_TIMEOUT_MS);
    child.stdout?.on("data", d => { out += d.toString(); });
    child.stderr?.on("data", d => { out += d.toString(); });
    child.on("error", err => { clearTimeout(timer); resolvePromise(`Ошибка запуска: ${err.message}`); });
    child.on("close", code => { clearTimeout(timer); resolvePromise(`(код выхода: ${code})\n${out}`.trim()); });
  });
}

/** Execute a tool. Returns { result: string, inlineDiff?: string }. */
async function executeTool(name, args, workspace) {
  switch (name) {
    case "list_dir": {
      const dir = safePath(workspace, args.path || ".");
      const entries = await readdir(dir, { withFileTypes: true });
      return { result: entries.length ? entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).sort().join("\n") : "(пусто)" };
    }
    case "read_file":
      return { result: clip(await readFile(safePath(workspace, args.path), "utf8")) };
    case "write_file": {
      const file = safePath(workspace, args.path);
      const next = String(args.content ?? "");
      let previous = null;
      try { previous = await readFile(file, "utf8"); } catch { /* new file */ }
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, next, "utf8");
      const rel = relative(workspace, file) || args.path;
      const inlineDiff = previous !== null ? lineDiff(previous, next) : "";
      return {
        result: previous === null ? `Файл создан: ${rel} (${next.length} символов)` : `Файл обновлён: ${rel}`,
        inlineDiff,
      };
    }
    case "run_command":
      return { result: clip(await runCommand(String(args.command ?? ""), workspace)) };
    default:
      return { result: `Неизвестный инструмент: ${name}` };
  }
}

async function isDirectory(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

/** One streaming provider turn. Emits content deltas live; returns accumulated content + tool calls. */
async function streamStep({ providerBase, apiKey, model, messages, tools, emit, isCancelled }) {
  const resp = await fetch(`${providerBase.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(tools ? { model, messages, tools, tool_choice: "auto", stream: true } : { model, messages, stream: true }),
  });
  if (!resp.ok || !resp.body) {
    const detail = await resp.text().catch(() => "");
    const err = new Error(`Провайдер вернул ${resp.status}: ${detail.slice(0, 400)}`);
    err.status = resp.status;
    throw err;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCalls = [];

  while (true) {
    if (isCancelled?.()) { try { await reader.cancel(); } catch { /* ignore */ } break; }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") continue;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) { content += delta.content; emit({ type: "message.delta", payload: { text: delta.content } }); }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          toolCalls[i] ??= { id: "", name: "", args: "" };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].name += tc.function.name;
          if (tc.function?.arguments) toolCalls[i].args += tc.function.arguments;
        }
      }
    }
  }
  return { content, toolCalls: toolCalls.filter(Boolean) };
}

/**
 * Run the agent loop. Emits events; returns { text, parts } for persistence.
 */
export async function runKyreiChat({ emit, messages, providerBase, apiKey, model, workspace, isCancelled }) {
  emit({ type: "message.start" });
  const parts = [];
  const pushText = delta => {
    const last = parts[parts.length - 1];
    if (last && last.type === "text") last.text += delta;
    else parts.push({ type: "text", text: delta });
  };

  if (!apiKey) {
    const guidance =
      "⚠️ **Не задан API-ключ провайдера.**\n\n" +
      "Откройте **Настройки** и укажите провайдера (Base URL), API-ключ и модель. " +
      "Например: `https://api.openai.com/v1`, `https://api.deepseek.com/v1` или `https://openrouter.ai/api/v1`.";
    emit({ type: "message.delta", payload: { text: guidance } });
    emit({ type: "message.complete", payload: { text: guidance, status: "complete" } });
    return { text: guidance, parts: [{ type: "text", text: guidance }] };
  }

  const convo = [...messages];
  const toolsEnabled = Boolean(workspace) && (await isDirectory(workspace));
  if (toolsEnabled) {
    convo.unshift({
      role: "system",
      content:
        `Ты — Kyrei, встроенный AI-агент для работы с кодом. Рабочая папка: ${workspace}.\n` +
        "Тебе доступны инструменты: list_dir, read_file, write_file, run_command. " +
        "Используй их, чтобы исследовать проект, читать и изменять файлы и запускать команды. " +
        "Не выдумывай содержимое файлов — читай их инструментами. Пути указывай относительно рабочей папки. Отвечай на русском.",
    });
  }

  let finalText = "";
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (isCancelled?.()) break;

      let content = "";
      let toolCalls = [];
      try {
        const res = await streamStep({ providerBase, apiKey, model, messages: convo, tools: toolsEnabled ? TOOL_SCHEMAS : null, emit, isCancelled });
        content = res.content;
        toolCalls = res.toolCalls;
      } catch (err) {
        if (toolsEnabled && [400, 404, 422].includes(err.status)) {
          const res = await streamStep({ providerBase, apiKey, model, messages: convo, tools: null, emit, isCancelled });
          content = res.content;
          toolCalls = [];
        } else {
          throw err;
        }
      }

      if (content) { finalText += content; pushText(content); }

      if (toolCalls.length === 0 || isCancelled?.()) {
        emit({ type: "message.complete", payload: { text: finalText, status: isCancelled?.() ? "interrupted" : "complete" } });
        return { text: finalText, parts };
      }

      convo.push({
        role: "assistant",
        content: content || "",
        tool_calls: toolCalls.map(tc => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.args } })),
      });

      for (const call of toolCalls) {
        let args = {};
        try { args = JSON.parse(call.args || "{}"); } catch { /* keep {} */ }
        emit({ type: "tool.start", payload: { tool_call_id: call.id, name: call.name, args } });
        const startedAt = Date.now();
        let out = { result: "" };
        let error;
        try { out = await executeTool(call.name, args, workspace); }
        catch (e) { out = { result: `Ошибка инструмента: ${e.message}` }; error = e.message; }
        const durationS = (Date.now() - startedAt) / 1000;
        emit({ type: "tool.complete", payload: { tool_call_id: call.id, name: call.name, result: out.result, inline_diff: out.inlineDiff, error, duration_s: durationS } });
        parts.push({ type: "tool", toolCallId: call.id, name: call.name, args, result: out.result, inlineDiff: out.inlineDiff || undefined, error, running: false, durationS });
        convo.push({ role: "tool", tool_call_id: call.id, name: call.name, content: out.result });
      }
    }

    emit({ type: "message.complete", payload: { text: finalText, status: "complete" } });
    return { text: finalText, parts };
  } catch (err) {
    const text = `Ошибка движка Kyrei: ${err.message}`;
    emit({ type: "message.delta", payload: { text: `\n\n${text}` } });
    pushText(`\n\n${text}`);
    emit({ type: "message.complete", payload: { text: finalText + `\n\n${text}`, status: "error" } });
    return { text: finalText + `\n\n${text}`, parts };
  }
}
