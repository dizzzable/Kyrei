/**
 * Remove dangling tool pairs so history stays valid for the next request.
 * Requirements §9.2, Property 5/14.
 *
 * - Drops assistant tool-call parts that have no matching tool-result.
 * - Drops orphan tool-result messages that have no matching tool-call.
 * - Drops assistant messages that become empty after pruning.
 *
 * ONE DELIBERATE EXCEPTION: a tool call awaiting user approval.
 *
 * A call parked on an approval has no tool-result yet — that is the whole point
 * of the state, not a defect in the history. Pruning it broke the continuation
 * that the approval exists to enable: the AI SDK correlates the stored
 * `tool-approval-request` back to its `tool-call`, and with the call gone it
 * throws `ToolCallNotFoundForApprovalError`. The turn then died before reaching
 * the execution layer, so the one-shot receipt was never consumed — and an
 * unconsumed receipt refuses every later prompt in that session, with no TTL
 * sweep and no UI action able to clear it. Approving a command permanently
 * bricked the conversation.
 *
 * So a tool-call is also kept when an approval request references it. Its
 * `tool-approval-request` sibling is retained for the same reason: the SDK needs
 * the pair, including the signature it verifies.
 */

import type { ModelMessage } from "ai";

type Part = Record<string, unknown>;

function partsOf(message: ModelMessage): Part[] | undefined {
  return Array.isArray(message.content) ? message.content as unknown as Part[] : undefined;
}

function idOf(part: Part): string {
  return String(part["toolCallId"]);
}

/**
 * Tool calls parked on an approval request, plus the approvals already answered
 * in this history. Both sides are collected because a continuation prompt
 * carries the response in a trailing tool message while the request stays in the
 * assistant message that produced it.
 */
function approvalPendingCallIds(messages: ModelMessage[]): Set<string> {
  const requestedCallIdByApprovalId = new Map<string, string>();
  const resolvedApprovalIds = new Set<string>();

  for (const message of messages) {
    const parts = partsOf(message);
    if (!parts) continue;
    for (const part of parts) {
      if (part["type"] === "tool-approval-request" && part["approvalId"] != null && part["toolCallId"] != null) {
        requestedCallIdByApprovalId.set(String(part["approvalId"]), idOf(part));
      }
      if (part["type"] === "tool-approval-response" && part["approvalId"] != null) {
        resolvedApprovalIds.add(String(part["approvalId"]));
      }
    }
  }

  // Every requested call is kept, answered or not. An answered-and-approved call
  // is exactly the one the next request must execute; an unanswered one is still
  // awaiting the user. Only a call whose result already arrived is prunable, and
  // that is handled by the ordinary tool-result rule below.
  return new Set(requestedCallIdByApprovalId.values());
}

export function cleanupIncomplete(messages: ModelMessage[]): ModelMessage[] {
  const resultIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && Array.isArray(m.content)) {
      for (const p of m.content as unknown as Array<Record<string, unknown>>) {
        if (p["type"] === "tool-result" && p["toolCallId"]) resultIds.add(String(p["toolCallId"]));
      }
    }
  }
  const approvalPending = approvalPendingCallIds(messages);
  const keepCall = (p: Part): boolean => resultIds.has(idOf(p)) || approvalPending.has(idOf(p));

  const callIds = new Set<string>();
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const parts = m.content as unknown as Array<Record<string, unknown>>;
      const kept = parts.filter((p) => p["type"] !== "tool-call" || keepCall(p));
      for (const p of kept) if (p["type"] === "tool-call") callIds.add(String(p["toolCallId"]));
      if (kept.length === 0 && parts.length > 0) continue; // was tool-only, now empty → drop
      out.push(kept.length === parts.length ? m : ({ ...m, content: kept } as unknown as ModelMessage));
    } else if (m.role === "tool" && Array.isArray(m.content)) {
      const parts = m.content as unknown as Array<Record<string, unknown>>;
      const kept = parts.filter((p) => p["type"] !== "tool-result" || callIds.has(String(p["toolCallId"])));
      if (kept.length === 0 && parts.length > 0) continue;
      out.push(kept.length === parts.length ? m : ({ ...m, content: kept } as unknown as ModelMessage));
    } else {
      out.push(m);
    }
  }
  return out;
}
