/**
 * A4b helpers: map engine SessionStore rows ↔ gateway JSON session/message shapes.
 * When memory.sessionMirror.enginePrimary is on, public GET paths prefer engine
 * rows (JSON is still written for approvals/rewind durability).
 */

/**
 * @param {object | null | undefined} rec engine SessionRecord
 * @returns {object | null} gateway-shaped session (without runtime status)
 */
export function engineSessionToGateway(rec) {
  if (!rec || typeof rec !== "object" || typeof rec.id !== "string") return null;
  const meta = rec.meta && typeof rec.meta === "object" ? rec.meta : {};
  const updatedAt =
    typeof meta.updatedAt === "string" && Number.isFinite(Date.parse(meta.updatedAt))
      ? meta.updatedAt
      : typeof rec.startedAt === "string"
        ? rec.startedAt
        : new Date().toISOString();
  const createdAt =
    typeof rec.startedAt === "string" && Number.isFinite(Date.parse(rec.startedAt))
      ? rec.startedAt
      : updatedAt;
  // Gateway UI uses idle | working; engine uses active/complete/interrupted/error/working.
  const status =
    rec.status === "working" || rec.status === "active"
      ? undefined // runtime overlay supplies idle/working
      : rec.status === "interrupted" || rec.status === "error" || rec.status === "complete"
        ? undefined
        : undefined;
  const archived = meta.archived === true;
  const archivedAt =
    typeof meta.archivedAt === "string" && Number.isFinite(Date.parse(meta.archivedAt))
      ? meta.archivedAt
      : undefined;
  const parentSessionId =
    typeof meta.parentSessionId === "string" && meta.parentSessionId.trim()
      ? meta.parentSessionId.trim()
      : undefined;
  const rootSessionId =
    typeof meta.rootSessionId === "string" && meta.rootSessionId.trim()
      ? meta.rootSessionId.trim()
      : undefined;
  const forkedFromMessageId =
    typeof meta.forkedFromMessageId === "string" && meta.forkedFromMessageId.trim()
      ? meta.forkedFromMessageId.trim()
      : undefined;
  const forkedAt =
    typeof meta.forkedAt === "string" && Number.isFinite(Date.parse(meta.forkedAt))
      ? meta.forkedAt
      : undefined;
  const lineageKind = meta.lineageKind === "branch" || meta.lineageKind === "continuation"
    ? meta.lineageKind
    : undefined;
  return {
    id: rec.id,
    title: typeof rec.title === "string" ? rec.title : "",
    createdAt,
    updatedAt,
    ...(typeof rec.providerId === "string" && rec.providerId ? { providerId: rec.providerId } : {}),
    ...(typeof rec.modelId === "string" && rec.modelId ? { modelId: rec.modelId } : {}),
    ...(typeof rec.providerAccountId === "string" && rec.providerAccountId
      ? { providerAccountId: rec.providerAccountId }
      : {}),
    ...(status ? { status } : {}),
    ...(archived ? { archived: true, ...(archivedAt ? { archivedAt } : {}) } : { archived: false }),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(rootSessionId ? { rootSessionId } : {}),
    ...(forkedFromMessageId ? { forkedFromMessageId } : {}),
    ...(forkedAt ? { forkedAt } : {}),
    ...(lineageKind ? { lineageKind } : {}),
    ...(typeof meta.continuationSourceSessionId === "string" && meta.continuationSourceSessionId
      ? { continuationSourceSessionId: meta.continuationSourceSessionId }
      : {}),
    ...(Number(meta.continuationPacketVersion) === 1 ? { continuationPacketVersion: 1 } : {}),
    ...(typeof meta.continuationCreatedAt === "string" && meta.continuationCreatedAt
      ? { continuationCreatedAt: meta.continuationCreatedAt }
      : {}),
    source: "engine-mirror",
  };
}

/**
 * @param {object | null | undefined} msg engine StoredMessage
 * @param {string} sessionId
 * @returns {object | null} gateway-shaped stored message
 */
export function engineMessageToGateway(msg, sessionId) {
  if (!msg || typeof msg !== "object") return null;
  const seq = Number.isFinite(msg.seq) ? msg.seq : 0;
  const clientId =
    typeof msg.clientId === "string" && msg.clientId.trim()
      ? msg.clientId.trim()
      : `msg-engine-${String(sessionId).slice(0, 24)}-${seq}`;
  const at =
    typeof msg.createdAt === "string" && Number.isFinite(Date.parse(msg.createdAt))
      ? msg.createdAt
      : new Date().toISOString();
  const role =
    msg.role === "system" || msg.role === "user" || msg.role === "assistant" || msg.role === "tool"
      ? msg.role
      : "assistant";
  const text = typeof msg.text === "string" ? msg.text : "";
  const parts = Array.isArray(msg.parts) ? msg.parts : text ? [{ type: "text", text }] : [];
  return {
    id: clientId,
    role,
    text,
    content: text,
    at,
    parts,
    ...(msg.pending === true ? { pending: true } : {}),
    ...(typeof msg.turnStatus === "string" && msg.turnStatus ? { turnStatus: msg.turnStatus } : {}),
    ...(msg.approvalModelParams && typeof msg.approvalModelParams === "object"
      ? { approvalModelParams: msg.approvalModelParams }
      : {}),
  };
}

/**
 * Prefer engine list when it covers all JSON ids or when engine has more sessions.
 * Always union: engine rows win on id collision; JSON-only sessions kept as backup.
 *
 * @param {readonly object[]} jsonSessions
 * @param {readonly object[]} engineSessions gateway-shaped
 */
export function mergeSessionsPreferEngine(jsonSessions, engineSessions) {
  const byId = new Map();
  for (const s of Array.isArray(jsonSessions) ? jsonSessions : []) {
    if (s && typeof s.id === "string") byId.set(s.id, { ...s, _source: "json" });
  }
  for (const s of Array.isArray(engineSessions) ? engineSessions : []) {
    if (s && typeof s.id === "string") {
      const prev = byId.get(s.id);
      // Prefer engine for mirrored fields; keep JSON title if engine empty.
      byId.set(s.id, {
        ...prev,
        ...s,
        title: s.title || prev?.title || "",
        providerId: s.providerId || prev?.providerId,
        modelId: s.modelId || prev?.modelId,
        providerAccountId: s.providerAccountId || prev?.providerAccountId,
        _source: "engine",
      });
    }
  }
  return [...byId.values()]
    .map(({ _source, ...rest }) => rest)
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
}

/**
 * Prefer engine messages when they are at least as long as JSON (mirror caught up).
 * Otherwise keep JSON (authoritative for in-flight turns / approvals).
 *
 * @param {readonly object[]} jsonMessages
 * @param {readonly object[]} engineMessages gateway-shaped
 */
export function preferMessagesForPrimary(jsonMessages, engineMessages) {
  const json = Array.isArray(jsonMessages) ? jsonMessages : [];
  const eng = Array.isArray(engineMessages) ? engineMessages : [];
  if (eng.length === 0) return { messages: json, source: "json" };
  if (eng.length >= json.length) return { messages: eng, source: "engine" };
  return { messages: json, source: "json" };
}
