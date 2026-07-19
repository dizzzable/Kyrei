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
import {
  closeReasoning,
  initState,
  openReasoning,
  pushReasoning,
  pushText,
  type BridgeState,
  type ToolInFlight,
} from "./state.js";
import { computeStatus } from "./status.js";

export interface BridgeCtx {
  toolMeta: Map<string, ToolMeta>;
  provider: string;
  model: string;
  maxSteps?: number;
  guardStopReason?: () =>
    | "max_steps"
    | "repeated_tool_call"
    | "budget_exceeded"
    | "heal_handoff"
    | undefined;
  approvalMeta?: Map<string, { reason: string; args: unknown; name?: string }>;
}

export interface BridgeResult {
  text: string;
  parts: MessagePart[];
  usage?: Usage;
  status: TurnStatus;
}

function finiteTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function tokenTotal(value: unknown): number | undefined {
  const direct = finiteTokenCount(value);
  if (direct !== undefined) return direct;
  if (!value || typeof value !== "object") return undefined;
  return finiteTokenCount((value as Record<string, unknown>)["total"]);
}

function tokenDetail(value: unknown, ...keys: string[]): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  for (const key of keys) {
    const count = finiteTokenCount(source[key]);
    if (count !== undefined) return count;
  }
  return undefined;
}

/**
 * AI SDK 6/7 exposes usage in two valid shapes:
 * - legacy flat `{ inputTokens: 12, outputTokens: 4 }`
 * - V4 `{ inputTokens: { total, cacheRead }, outputTokens: { total, reasoning } }`
 *
 * Keep the bridge boundary numeric. Passing the V4 detail objects through used
 * to poison context-budget arithmetic with `NaN`, so compaction could miss a
 * real provider-reported threshold.
 */
function toUsage(u: unknown): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const source = u as Record<string, unknown>;
  const inputRaw = source["inputTokens"] ?? source["promptTokens"];
  const outputRaw = source["outputTokens"] ?? source["completionTokens"];
  const inputTokens = tokenTotal(inputRaw);
  const outputTokens = tokenTotal(outputRaw);
  const explicitTotal = tokenTotal(source["totalTokens"]);
  const totalTokens = explicitTotal ?? (
    inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined
  );
  const cachedInputTokens = tokenDetail(
    inputRaw,
    "cacheRead",
    "cacheReadTokens",
  ) ?? tokenDetail(source["inputTokenDetails"], "cacheRead", "cacheReadTokens");
  const reasoningTokens = tokenDetail(
    outputRaw,
    "reasoning",
    "reasoningTokens",
  ) ?? tokenDetail(source["outputTokenDetails"], "reasoning", "reasoningTokens");

  const usage: Usage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
  return Object.keys(usage).length ? usage : undefined;
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
          const explicitSequence = typeof part["sequence"] === "number" ? part["sequence"] : undefined;
          const active = pushReasoning(st, text, {
            id: typeof part["id"] === "string" ? part["id"] : undefined,
            source: "provider",
            providerId: ctx.provider,
            modelId: ctx.model,
            sequence: explicitSequence,
          });
          if (!active) break;
          emit({
            type: "reasoning.delta",
            payload: {
              id: active.id,
              text,
              sequence: explicitSequence ?? st.nextReasoningSequence,
              source: active.source,
              provider_id: active.providerId,
              model_id: active.modelId,
              attempt: active.attempt,
              started_at: active.startedAt,
            },
          });
        }
        break;
      }

      case "reasoning-start": {
        const active = openReasoning(st, {
          id: typeof part["id"] === "string" ? part["id"] : undefined,
          source: "provider",
          providerId: ctx.provider,
          modelId: ctx.model,
          startedAt: typeof part["timestamp"] === "number" ? part["timestamp"] : undefined,
        });
        emit({
          type: "reasoning.start",
          payload: {
            id: active.id,
            source: active.source,
            provider_id: active.providerId,
            model_id: active.modelId,
            attempt: active.attempt,
            sequence: active.sequence,
            started_at: active.startedAt,
          },
        });
        break;
      }

      case "reasoning-end": {
        const closed = closeReasoning(st, {
          id: typeof part["id"] === "string" ? part["id"] : undefined,
          completedAt: typeof part["timestamp"] === "number" ? part["timestamp"] : undefined,
        });
        if (closed) {
          emit({
            type: "reasoning.complete",
            payload: {
              id: closed.id,
              state: "complete",
              sequence: closed.sequence,
              completed_at: closed.completedAt,
            },
          });
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

  const guardReason = ctx.guardStopReason?.();
  const status = computeStatus(st, ctx.maxSteps, guardReason ?? false);
  emit({ type: "message.complete", payload: { text: st.text, status, usage: st.usage } });
  return { text: st.text, parts: st.parts, usage: st.usage, status };
}
