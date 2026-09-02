/**
 * Pure session mutation algorithms (approvals + rewind).
 * Used by JSON SessionStore and by engine-primary gateway paths so logic is
 * shared and can run on either store's message list.
 */

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export class SessionMutationError extends Error {
  constructor(code) {
    super(code);
    this.name = "SessionMutationError";
    this.code = code;
  }
}

function approvalTimestamp(value, fallback) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function findApproval(messages, approvalId) {
  const list = Array.isArray(messages) ? messages : [];
  for (let messageIndex = list.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = list[messageIndex];
    if (!Array.isArray(message?.parts)) continue;
    const partIndex = message.parts.findIndex(
      (part) => part?.type === "approval" && part.approvalId === approvalId,
    );
    if (partIndex >= 0) {
      return { message, messageIndex, partIndex, approval: message.parts[partIndex] };
    }
  }
  return null;
}

/**
 * Immutable resolve of an approval part inside a message list.
 *
 * `force` exists as the manual escape from a stranded receipt. Without it a
 * receipt already marked `approved` could never be re-decided:
 * `approval_decision_conflict` rejected the only decision that would have
 * released the session, so an approval whose continuation never reached the
 * execution layer blocked every later prompt with no way out. A forced decision
 * consumes the receipt in the same step, because there is no effect left to run.
 *
 * The options bag is annotated because a destructured parameter infers its type
 * from the DEFAULTS alone: `approved` has none, so without this every call site
 * reported it as an unknown property. `messages` is deliberately left
 * un-annotated — the stored message shape is not typed here, and pinning it to
 * `object[]` only trades one set of spurious errors for another.
 *
 * @param {*} messages
 * @param {string} approvalId
 * @param {{ approved?: boolean, reason?: string, now?: string, force?: boolean }} [options]
 * @returns {{ messages: object[], approval: object, messageId: string, ready: boolean, modelParams?: unknown }}
 */
export function resolveApprovalInMessages(
  messages,
  approvalId,
  { approved, reason = "", now = new Date().toISOString(), force = false } = {},
) {
  if (typeof approved !== "boolean") throw new SessionMutationError("approval_decision_invalid");
  const list = Array.isArray(messages) ? messages.map((m) => ({
    ...m,
    parts: Array.isArray(m.parts) ? m.parts.map((p) => (p && typeof p === "object" ? { ...p } : p)) : m.parts,
  })) : [];
  const found = findApproval(list, approvalId);
  if (!found) throw new SessionMutationError("approval_not_found");
  const decisionAt = approvalTimestamp(now, new Date().toISOString());
  const current = found.approval;
  if (current.consumedAt) throw new SessionMutationError("approval_already_consumed");
  const expired = current.status === "expired"
    || (current.expiresAt && Date.parse(current.expiresAt) <= Date.parse(decisionAt));

  let approval;
  if (expired) {
    approval = {
      ...current,
      status: "expired",
      resolvedAt: current.resolvedAt ?? decisionAt,
      decisionReason: "approval_expired",
      consumedAt: current.consumedAt ?? decisionAt,
    };
  } else {
    const status = approved ? "approved" : "denied";
    if (!force && current.status !== "pending" && current.status !== status) {
      throw new SessionMutationError("approval_decision_conflict");
    }
    approval = {
      ...current,
      status,
      resolvedAt: current.resolvedAt ?? decisionAt,
      // A forced decision is terminal by construction: nothing will execute this
      // call, so leaving the receipt open would keep the session blocked.
      ...(!approved || force ? { consumedAt: current.consumedAt ?? decisionAt } : {}),
      ...(reason ? { decisionReason: String(reason).slice(0, 500) } : {}),
    };
  }

  const message = { ...found.message, parts: [...found.message.parts] };
  message.parts[found.partIndex] = approval;
  list[found.messageIndex] = message;
  const ready = message.parts
    .filter((part) => part?.type === "approval")
    .every((part) => part.status !== "pending");

  return {
    messages: list,
    approval,
    messageId: message.id,
    ready,
    modelParams: message.approvalModelParams,
  };
}

/**
 * @returns {{ messages: object[], approval: object }}
 */
export function consumeApprovalInMessages(messages, approvalId, now = new Date().toISOString()) {
  const list = Array.isArray(messages) ? messages.map((m) => ({
    ...m,
    parts: Array.isArray(m.parts) ? m.parts.map((p) => (p && typeof p === "object" ? { ...p } : p)) : m.parts,
  })) : [];
  const found = findApproval(list, approvalId);
  if (!found) throw new SessionMutationError("approval_not_found");
  if (found.approval.consumedAt) {
    return { messages: list, approval: found.approval };
  }
  if (
    found.approval.status !== "approved"
    && found.approval.status !== "denied"
    && found.approval.status !== "expired"
  ) {
    throw new SessionMutationError("approval_not_resolved");
  }
  const approval = {
    ...found.approval,
    consumedAt: approvalTimestamp(now, new Date().toISOString()),
  };
  const message = { ...found.message, parts: [...found.message.parts] };
  message.parts[found.partIndex] = approval;
  list[found.messageIndex] = message;
  return { messages: list, approval };
}

/**
 * Plan rewind to a user message id (inclusive truncate from that message).
 * @returns {object | null} plan
 */
export function planRewindInMessages(messages, messageId, session = null) {
  const list = Array.isArray(messages) ? messages : [];
  const index = list.findIndex((message) => message.id === messageId);
  if (index < 0 || list[index]?.role !== "user") return null;
  const removed = list.slice(index);
  const snapshotIds = removed.flatMap((message) => (Array.isArray(message.parts)
    ? message.parts.flatMap((part) => (
      part?.type === "tool" && typeof part.snapshotId === "string" ? [part.snapshotId] : []
    ))
    : []));
  return {
    sessionId: session?.id,
    messageId,
    index,
    expectedLength: list.length,
    originalMessages: list.slice(),
    originalSession: session ? { ...session } : null,
    draft: typeof list[index].content === "string"
      ? list[index].content
      : typeof list[index].text === "string"
        ? list[index].text
        : "",
    workspace: typeof list[index].workspace === "string" ? list[index].workspace : "",
    snapshotIds,
  };
}

/**
 * Apply a rewind plan to a message list (truncate).
 * @returns {{ ok: boolean, messages: object[] }}
 */
export function commitRewindInMessages(messages, plan) {
  if (!plan || typeof plan !== "object") return { ok: false, messages: Array.isArray(messages) ? messages : [] };
  const list = Array.isArray(messages) ? messages : [];
  if (
    list.length !== plan.expectedLength
    || list[plan.index]?.id !== plan.messageId
    || list[plan.index]?.role !== "user"
  ) {
    return { ok: false, messages: list };
  }
  return { ok: true, messages: list.slice(0, plan.index) };
}
