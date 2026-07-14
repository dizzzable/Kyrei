import type { ModelMessage } from "ai";
import { readdir } from "node:fs/promises";
import { relative } from "node:path";

import type { EngineConfig } from "../types.js";
import { parsePatch } from "../apply/parse-patch.js";
import { detectEcosystem } from "../reliability/verify.js";
import { safePath } from "./jail.js";
import { decideAll, type ActionContext, type Decision } from "./permissions.js";
import { runPreHooks, secretScanHook } from "./pre-hook.js";

export type GuardedToolName = "run_command" | "write_file" | "edit_file" | "diagnostics";

export interface ToolApprovalEvaluation {
  decision: Decision;
  reason: string;
  args: unknown;
  actions: ActionContext[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function canonicalTarget(workspace: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("tool_target_invalid");
  return relative(workspace, safePath(workspace, value)).replaceAll("\\", "/");
}

async function actionsFor(
  toolName: GuardedToolName,
  input: unknown,
  workspace: string,
): Promise<ActionContext[]> {
  const args = record(input);
  if (toolName === "run_command") {
    return [{ tool: toolName, command: String(args.command ?? "") }];
  }
  if (toolName === "write_file") {
    return [{ tool: toolName, target: canonicalTarget(workspace, args.path) }];
  }
  if (toolName === "edit_file") {
    if (typeof args.patch !== "string") throw new Error("tool_target_invalid");
    const patches = parsePatch(args.patch);
    if (patches.length === 0) throw new Error("tool_target_invalid");
    return patches.flatMap((patch) => [
      { tool: toolName, target: canonicalTarget(workspace, patch.file) },
      ...(patch.dest ? [{ tool: toolName, target: canonicalTarget(workspace, patch.dest) }] : []),
    ]);
  }

  const files = await readdir(workspace).catch(() => [] as string[]);
  const commands = detectEcosystem(files as string[]);
  const selected = commands.find((candidate) => candidate.ecosystem === "typescript")
    ?? commands.find((candidate) => ["python", "rust", "go"].includes(candidate.ecosystem));
  return selected
    ? [{ tool: toolName }, { tool: "run_command", command: selected.command }]
    : [{ tool: toolName }];
}

/**
 * Evaluate the same local policy used by guarded tool execution before AI SDK
 * decides whether to issue a signed user-approval request.
 */
export async function evaluateToolApproval(input: {
  toolName: string;
  args: unknown;
  workspace: string;
  config: EngineConfig;
}): Promise<ToolApprovalEvaluation | null> {
  if (!["run_command", "write_file", "edit_file", "diagnostics"].includes(input.toolName)) return null;
  const toolName = input.toolName as GuardedToolName;
  let actions: ActionContext[];
  try {
    actions = await actionsFor(toolName, input.args, input.workspace);
  } catch {
    return { decision: "deny", reason: "tool_target_invalid", args: input.args, actions: [] };
  }

  const preHook = await runPreHooks([secretScanHook], { tool: toolName, args: input.args }, true);
  if (!preHook.allow) {
    return { decision: "deny", reason: "secret_scan_rejected", args: input.args, actions };
  }

  const decision = decideAll(input.config.permissions, actions);
  return {
    decision,
    reason: decision === "ask"
      ? "permission_rule_requires_confirmation"
      : decision === "deny"
        ? "permission_rule_denied"
        : "permission_rule_allowed",
    args: input.args,
    actions,
  };
}

/**
 * Find the exact approved response for one tool call in a continuation prompt.
 * AI SDK validates the request HMAC before invoking the approval callback; this
 * helper only correlates the already-validated request and response.
 */
export function approvedApprovalId(messages: ModelMessage[], toolCallId: string): string | undefined {
  const last = messages.at(-1);
  if (last?.role !== "tool" || !Array.isArray(last.content)) return undefined;

  const requestById = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-approval-request") requestById.set(part.approvalId, part.toolCallId);
    }
  }
  for (const part of last.content) {
    if (
      part.type === "tool-approval-response"
      && part.approved
      && requestById.get(part.approvalId) === toolCallId
    ) return part.approvalId;
  }
  return undefined;
}
