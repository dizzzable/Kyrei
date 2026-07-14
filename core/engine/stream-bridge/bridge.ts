/**
 * Stream bridge: translates AI SDK `stream` parts into KyreiEvents via
 * `emit`, keeping the exact event shape the renderer expects.
 *
 * Invariants (design.md Correctness Properties):
 *  - Property 4: `abort` part → status "interrupted", NO `error` event.
 *  - Property 7: stable tool_call_id from tool-input-start through tool.complete.
 *  - Single error source: only the `error` part emits `error` (onError = log).
 *  - tool-error is a TOOL failure (not a stream failure): emits tool.complete{error},
 *    does not set st.errored — the model can self-heal.
 */

import type { KyreiEvent, MessagePart, TurnStatus, Usage } from "../types.js";
import type { ToolMeta } from "../tools/index.js";
import { initState, pushText, pushReasoning, type BridgeState, type ToolInFlight } from "./state.js";
import { computeStatus } from "./status.js";

export interface BridgeCtx {
  toolMeta: Map<string, ToolMeta>;
  provider: string;
  model: string;
  maxSteps?: number;
  approvalMeta?: Map<string, { reason: string; args: unknown; name?: string }>;
}

export interface BridgeResult {
  text: string;
  parts: MessagePart[];
  usage?: Usage;
  status: TurnStatus;
}

function toUsage(u: unknown): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const o = u as Record<string, number>;
  const inputTokens = o["inputTokens"] ?? o["promptTokens"];
  const outputTokens = o["outputTokens"] ?? o["completionTokens"];
  const totalTokens = o["totalTokens"] ?? ((inputTokens ?? 0) + (outputTokens ?? 0));
  return { inputTokens, outputTokens, totalTokens };
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function outputToText(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (typeof output === "object" && "output" in (output as Record<string, unknown>)) {
    return String((output as Record<string, unknown>)["output"] ?? "");
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function finalizeToolPart(st: BridgeState, t: ToolInFlight): void {
  st.parts.push({
    type: "tool",
    toolCallId: t.id,
    name: t.name,
    args: t.args,
    result: t.result,
    inlineDiff: t.inlineDiff,
    snapshotId: t.snapshotId,
    error: t.error,
    running: false,
    durationS: (Date.now() - t.startedAt) / 1000,
  });
}

function ensureTool(
  st: BridgeState,
  id: string,
  name: string,
  args: unknown,
  emit: (event: KyreiEvent) => void,
): ToolInFlight {
  const existing = st.tools.get(id);
  if (existing) return existing;
  const tool = { id, name: name || "tool", args, startedAt: Date.now() };
  st.tools.set(id, tool);
  emit({ type: "tool.start", payload: { tool_call_id: id, name: tool.name, args } });
  return tool;
}

export async function bridgeStream(
  stream: AsyncIterable<unknown>,
  emit: (e: KyreiEvent) => void,
  ctx: BridgeCtx,
): Promise<BridgeResult> {
  const st = initState();

  for await (const raw of stream) {
    const part = raw as Record<string, any>;
    switch (part["type"] as string) {
      case "start":
      case "text-start":
      case "text-end":
      case "reasoning-start":
      case "reasoning-end":
      case "tool-input-end":
      case "raw":
        break;

      case "start-step":
        st.stepCount += 1;
        break;

      case "text-delta": {
        const text = part["text"] ?? part["textDelta"] ?? "";
        if (text) {
          pushText(st, text);
          emit({ type: "message.delta", payload: { text } });
        }
        break;
      }

      case "reasoning-delta": {
        const text = part["text"] ?? part["textDelta"] ?? "";
        if (text) {
          pushReasoning(st, text);
          emit({ type: "reasoning.delta", payload: { text } });
        }
        break;
      }

      case "tool-input-start": {
        const id = String(part["id"] ?? part["toolCallId"] ?? "");
        const name = String(part["toolName"] ?? "");
        // Register early (for stable id) but defer tool.start until args are known.
        if (id && !st.tools.has(id)) st.tools.set(id, { id, name, startedAt: Date.now() });
        break;
      }

      case "tool-input-delta": {
        const id = String(part["id"] ?? part["toolCallId"] ?? "");
        const delta = part["delta"] ?? "";
        if (id && delta) emit({ type: "tool.progress", payload: { tool_call_id: id, text: String(delta) } });
        break;
      }

      case "tool-call": {
        const id = String(part["toolCallId"] ?? part["id"] ?? "");
        const name = String(part["toolName"] ?? "");
        const input = part["input"] ?? part["args"];
        let t = st.tools.get(id);
        if (!t) {
          t = { id, name, startedAt: Date.now() };
          st.tools.set(id, t);
        }
        t.args = input;
        // Emit tool.start once, with the finalized args (Property 7: stable id).
        emit({ type: "tool.start", payload: { tool_call_id: id, name: name || t.name, args: input } });
        break;
      }

      case "tool-approval-request": {
        if (part["isAutomatic"] === true) break;
        const toolCall = part["toolCall"] && typeof part["toolCall"] === "object"
          ? part["toolCall"] as Record<string, unknown>
          : {};
        const id = String(toolCall["toolCallId"] ?? part["toolCallId"] ?? "");
        const approvalId = String(part["approvalId"] ?? "");
        const current = st.tools.get(id);
        const name = String(toolCall["toolName"] ?? current?.name ?? "");
        const metadata = ctx.approvalMeta?.get(id);
        const args = metadata?.args ?? toolCall["input"] ?? current?.args;
        const reason = metadata?.reason ?? "permission_rule_requires_confirmation";
        if (!id || !approvalId) break;
        st.pendingApprovals += 1;
        st.parts.push({
          type: "approval",
          approvalId,
          toolCallId: id,
          name,
          args,
          reason,
          status: "pending",
        });
        emit({
          type: "approval.request",
          payload: {
            approval_id: approvalId,
            tool_call_id: id,
            name,
            args,
            reason,
          },
        });
        break;
      }

      case "tool-approval-response": {
        if (part["approved"] !== false) break;
        const toolCall = part["toolCall"] && typeof part["toolCall"] === "object"
          ? part["toolCall"] as Record<string, unknown>
          : {};
        const id = String(toolCall["toolCallId"] ?? part["toolCallId"] ?? "");
        const current = st.tools.get(id);
        if (current) current.error = String(part["reason"] ?? "permission_rule_denied");
        break;
      }

      case "tool-output-denied": {
        const id = String(part["toolCallId"] ?? "");
        const metadata = ctx.approvalMeta?.get(id);
        const current = ensureTool(
          st,
          id,
          String(part["toolName"] ?? metadata?.name ?? "tool"),
          metadata?.args,
          emit,
        );
        current.error ??= "permission_rule_denied";
        finalizeToolPart(st, current);
        emit({
          type: "tool.complete",
          payload: {
            tool_call_id: id,
            name: current.name,
            error: current.error,
            duration_s: (Date.now() - current.startedAt) / 1000,
          },
        });
        break;
      }

      case "tool-result": {
        const id = String(part["toolCallId"] ?? part["id"] ?? "");
        const metadata = ctx.approvalMeta?.get(id);
        const t = ensureTool(
          st,
          id,
          String(part["toolName"] ?? metadata?.name ?? "tool"),
          metadata?.args,
          emit,
        );
        const result = outputToText(part["output"] ?? part["result"]);
        const inlineDiff = ctx.toolMeta.get(id)?.inlineDiff;
        const snapshotId = ctx.toolMeta.get(id)?.snapshotId;
        t.result = result;
        t.inlineDiff = inlineDiff;
        t.snapshotId = snapshotId;
        finalizeToolPart(st, t);
        emit({
          type: "tool.complete",
          payload: {
            tool_call_id: id,
            name: t.name,
            result,
            inline_diff: inlineDiff,
            snapshot_id: snapshotId,
            duration_s: (Date.now() - t.startedAt) / 1000,
          },
        });
        break;
      }

      case "tool-error": {
        const id = String(part["toolCallId"] ?? part["id"] ?? "");
        const metadata = ctx.approvalMeta?.get(id);
        const t = ensureTool(
          st,
          id,
          String(part["toolName"] ?? metadata?.name ?? "tool"),
          metadata?.args,
          emit,
        );
        const message = errMsg(part["error"]);
        t.error = message;
        finalizeToolPart(st, t);
        emit({
          type: "tool.complete",
          payload: { tool_call_id: id, name: t.name, error: message, duration_s: (Date.now() - t.startedAt) / 1000 },
        });
        break; // tool-error != stream error; model self-heals.
      }

      case "finish-step": {
        const usage = toUsage(part["usage"]);
        if (usage) emit({ type: "status.update", payload: { provider: ctx.provider, model: ctx.model, usage } });
        break;
      }

      case "finish":
        st.finished = true;
        st.usage = toUsage(part["totalUsage"] ?? part["usage"]);
        break;

      case "abort":
        st.aborted = true;
        break;

      case "error":
        st.errored = true;
        emit({ type: "error", payload: { message: errMsg(part["error"]) } });
        break;

      default:
        break;
    }
  }

  const status = computeStatus(st, ctx.maxSteps);
  emit({ type: "message.complete", payload: { text: st.text, status, usage: st.usage } });
  return { text: st.text, parts: st.parts, usage: st.usage, status };
}
