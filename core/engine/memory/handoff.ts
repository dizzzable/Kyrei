/**
 * Clean-window handoff artifact (Requirements §6.4). A distilled summary written
 * before hitting the window limit / at phase end, so a fresh window can resume
 * by reading this artifact instead of the full chat history.
 *
 * Phase 1: heuristic extraction (no LLM summary call) — writes minimal artifact
 * to preserve key files + intent from last user message. Phase 2 (full LLM
 * summarization) deferred to consolidate.ts idle-time processing.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { z } from "zod";
import type { ModelMessage } from "ai";

export const HandoffSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  sessionId: z.string(),
  trigger: z.enum(["window_limit", "phase_complete", "explicit", "heal_handoff"]),
  intent: z.string(),
  constraints: z.array(z.string()).default([]),
  done: z.array(z.string()).default([]),
  nextActions: z.array(z.string()).default([]),
  keyFiles: z.array(z.object({ path: z.string(), why: z.string() })).default([]),
  decisions: z.array(z.object({ decision: z.string(), rationale: z.string() })).default([]),
  openQuestions: z.array(z.string()).default([]),
});

export type HandoffArtifact = z.infer<typeof HandoffSchema>;

function handoffPath(workspace: string, id: string): string {
  return join(workspace, ".kyrei", "handoff", `${id}.md`);
}

function render(a: HandoffArtifact): string {
  const fm = [
    "---",
    `id: ${a.id}`,
    `created_at: ${a.createdAt}`,
    `session_id: ${a.sessionId}`,
    `trigger: ${a.trigger}`,
    `intent: ${JSON.stringify(a.intent)}`,
    `constraints: ${JSON.stringify(a.constraints)}`,
    "---",
  ].join("\n");
  const body = [
    "## Done",
    ...a.done.map((d) => `- ${d}`),
    "## Next actions",
    ...a.nextActions.map((n) => `- ${n}`),
    "## Key files",
    ...a.keyFiles.map((f) => `- ${f.path} — ${f.why}`),
    "## Decisions",
    ...a.decisions.map((d) => `- ${d.decision} — ${d.rationale}`),
    "## Open questions",
    ...a.openQuestions.map((q) => `- ${q}`),
  ].join("\n");
  return `${fm}\n\n${body}\n`;
}

export async function writeHandoff(workspace: string, artifact: HandoffArtifact): Promise<string> {
  const parsed = HandoffSchema.parse(artifact);
  const path = handoffPath(workspace, parsed.id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, render(parsed), "utf8");
  return path;
}

/** Build the reseed system context for a fresh window from a handoff artifact. */
export function reseedFromHandoff(a: HandoffArtifact): string {
  return [
    `Продолжение задачи (чистое окно, seeded from handoff ${a.id}).`,
    `Цель: ${a.intent}`,
    a.constraints.length ? `Ограничения: ${a.constraints.join("; ")}` : "",
    a.done.length ? `Уже сделано:\n${a.done.map((d) => `- ${d}`).join("\n")}` : "",
    a.nextActions.length ? `Следующие шаги:\n${a.nextActions.map((n) => `- ${n}`).join("\n")}` : "",
    a.keyFiles.length ? `Ключевые файлы:\n${a.keyFiles.map((f) => `- ${f.path} (${f.why})`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function readHandoff(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/**
 * Phase 1 heuristic handoff: extracts keyFiles from recent tool calls and intent
 * from the last user message. No LLM summarization (fast, deterministic).
 * Used for checkpoint-mark triggered handoffs (20/45/70% budget).
 */
export function extractHeuristicHandoff(
  messages: readonly ModelMessage[],
  sessionId: string,
  trigger: "window_limit" | "phase_complete" | "explicit" | "heal_handoff",
): HandoffArtifact {
  const now = new Date().toISOString();
  const id = `handoff_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  // Extract intent from last user message
  let intent = "Continue current task";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && typeof m.content === "string" && m.content.trim()) {
      intent = m.content.trim().slice(0, 200);
      break;
    }
  }
  
  // Extract *completed* local writes from tool receipts. Tool-call intent alone
  // is not proof: it may be denied, awaiting approval, or interrupted.
  const keyFiles: Array<{ path: string; why: string }> = [];
  const seenFiles = new Set<string>();
  const completedToolCalls = new Set<string>();
  const toolFailures: string[] = [];
  for (const message of messages) {
    if (message?.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content as Array<Record<string, unknown>>) {
      const callId = typeof part.toolCallId === "string" ? part.toolCallId : "";
      if (!callId) continue;
      if (part.type === "tool-result" && !part.error) completedToolCalls.add(callId);
      if (part.type === "tool-error") {
        const text = typeof part.errorText === "string"
          ? part.errorText
          : typeof part.error === "string" ? part.error : "tool_error";
        toolFailures.push(text.slice(0, 400));
      }
    }
  }
  
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - 10); i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const parts = Array.isArray(m.content) ? m.content : [];
    for (const p of parts) {
      if (typeof p === "object" && p && "type" in p && p.type === "tool-call") {
        const tc = p as { toolName?: string; toolCallId?: string; args?: Record<string, unknown>; input?: Record<string, unknown> };
        if (!completedToolCalls.has(String(tc.toolCallId ?? ""))) continue;
        if (tc.toolName === "write_file" || tc.toolName === "edit_file") {
          const args = tc.input && typeof tc.input === "object" ? tc.input : tc.args;
          const candidates = [
            args?.path,
            args?.file,
            ...(Array.isArray(args?.patch)
              ? args.patch.flatMap((patch) => patch && typeof patch === "object"
                ? [patch.file, patch.dest]
                : [])
              : []),
          ];
          for (const candidate of candidates) {
            if (typeof candidate !== "string" || !candidate || seenFiles.has(candidate)) continue;
            seenFiles.add(candidate);
            keyFiles.push({ path: candidate, why: tc.toolName === "write_file" ? "created" : "modified" });
            if (keyFiles.length >= 10) break;
          }
        }
      }
    }
    if (keyFiles.length >= 10) break;
  }
  
  return {
    id,
    createdAt: now,
    sessionId,
    trigger,
    intent,
    constraints: [],
    done: keyFiles.map((file) => `${file.why === "created" ? "Created" : "Modified"}: ${file.path} (completed Kyrei tool receipt)`),
    nextActions: [],
    keyFiles,
    decisions: [],
    openQuestions: toolFailures.slice(-5).map((failure) => `Recent tool failure: ${failure}`),
  };
}
