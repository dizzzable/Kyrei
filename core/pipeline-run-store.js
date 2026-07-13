import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { redactSensitiveText, redactSensitiveValue } from "./secret-redaction.js";

const SCHEMA_VERSION = 1;
const FILE_LOCK_TIMEOUT_MS = 5_000;
const FILE_LOCK_STALE_MS = 30_000;
const MAX_RUN_ARTIFACTS = 2_000;
const MAX_RUN_APPROVALS = 2_000;
const JOURNAL_EVENT_VERSION = 2;
const JOURNAL_HEAD_VERSION = 1;
const JOURNAL_DEFAULT_LIMIT = 100;
const JOURNAL_MAX_LIMIT = 1_000;
const MAX_JOURNAL_DELTA_OPERATIONS = 10_000;
const MAX_JOURNAL_DELTA_BYTES = 2 * 1024 * 1024;
const MAX_JOURNAL_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACT_SERIALIZED_BYTES = 512 * 1024;
const MAX_ARTIFACT_COLLECTION_ITEMS = 2_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const ARTIFACT_ROOT_KEYS = new Set([
  "schemaVersion",
  "id",
  "kind",
  "runId",
  "stageId",
  "producerId",
  "createdAt",
  "summary",
  "workspaceDigest",
  "inputDigests",
  "assumptions",
  "uncertainties",
  "unchecked",
  "provenance",
  "metrics",
  "claims",
  "evidence",
  "checks",
  "contradictions",
]);
const ARTIFACT_PROVENANCE_KEYS = new Set(["providerId", "modelId", "policyDigest"]);
const ARTIFACT_METRICS_KEYS = new Set([
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "providerCalls",
  "durationMs",
]);
let artifactEnvelopeModulePromise;
const RUN_STATUSES = new Set([
  "queued",
  "running",
  "paused",
  "budget_paused",
  "awaiting_approval",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const STAGE_STATUSES = new Set([
  "pending",
  "running",
  "awaiting_approval",
  "blocked",
  "budget_paused",
  "completed",
  "failed",
  "skipped",
  "cancelled",
  "interrupted",
  "uncertain",
]);
const STAGE_TRANSITIONS = {
  pending: new Set(["running", "awaiting_approval", "blocked", "skipped", "cancelled"]),
  running: new Set(["awaiting_approval", "blocked", "budget_paused", "interrupted", "uncertain", "completed", "failed", "cancelled"]),
  awaiting_approval: new Set(["blocked", "completed", "failed", "cancelled"]),
  blocked: new Set(["running", "failed", "skipped", "cancelled"]),
  budget_paused: new Set(["running", "interrupted", "failed", "cancelled"]),
  interrupted: new Set(["running", "failed", "cancelled"]),
  // Uncertain writes are resolved only through the verifier-gated branch in
  // updateStage(); ordinary transition edges deliberately cannot resurrect
  // them.
  uncertain: new Set(),
  failed: new Set(["running", "skipped", "cancelled"]),
  completed: new Set(),
  skipped: new Set(),
  cancelled: new Set(),
};
const RUN_TRANSITIONS = {
  queued: new Set(["running", "cancelled"]),
  running: new Set([
    "paused",
    "budget_paused",
    "awaiting_approval",
    "blocked",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  paused: new Set(["running", "cancelled"]),
  budget_paused: new Set(["failed", "cancelled"]),
  awaiting_approval: new Set(["running", "blocked", "interrupted", "failed", "cancelled"]),
  blocked: new Set(["running", "interrupted", "failed", "cancelled"]),
  interrupted: new Set(["running", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

function safeId(value, name = "id", max = 300) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\0-\x1f]/.test(value)) {
    throw new Error(`pipeline_${name}_invalid`);
  }
  return value.trim();
}

function optionalId(value, name, max) {
  return value == null || value === "" ? "" : safeId(value, name, max);
}

function boundedText(value, max = 32_000) {
  if (value == null) return "";
  const text = typeof value === "string" ? value : String(value);
  if (text.length > max || text.includes("\0")) throw new Error("pipeline_text_invalid");
  return text;
}

function iso(value, fallback = new Date().toISOString()) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function publicValue(value, sensitiveValues) {
  return redactSensitiveValue(value, sensitiveValues, {
    maxDepth: 64,
    maxStringChars: 32_000,
  });
}

function publicText(value, sensitiveValues, max = 32_000) {
  return redactSensitiveText(boundedText(value, max), sensitiveValues).slice(0, max);
}

function plainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, keys) {
  return plainRecord(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key));
}

function artifactText(value, maximum = 1_000_000) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function artifactDigest(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function validArtifactArray(value, validator = () => true) {
  return Array.isArray(value)
    && value.length <= MAX_ARTIFACT_COLLECTION_ITEMS
    // Do not pass Array#every's index and array arguments through: validators
    // such as artifactText use their second parameter as a length bound.
    && value.every((item) => validator(item));
}

/**
 * The engine owns semantic ArtifactEnvelope validation. This small synchronous
 * check is intentionally limited to persisted-state integrity and lineage so a
 * snapshot can be rejected before the compiled engine is loaded during crash
 * recovery.
 */
function validPersistedArtifactEnvelope(artifact, runId, stageIds) {
  if (!exactKeys(artifact, ARTIFACT_ROOT_KEYS)) return false;
  let serialized;
  try {
    serialized = JSON.stringify(artifact);
  } catch {
    return false;
  }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_ARTIFACT_SERIALIZED_BYTES) return false;
  if (
    artifact.schemaVersion !== 1
    || !artifactText(artifact.id, 512)
    || artifact.runId !== runId
    || !artifactText(artifact.stageId, 512)
    || !stageIds.has(artifact.stageId)
    || !artifactText(artifact.producerId, 512)
    || !artifactText(artifact.summary)
    || !Number.isFinite(Date.parse(artifact.createdAt ?? ""))
    || !artifactDigest(artifact.workspaceDigest)
    || !new Set(["department", "action", "verification", "improvement", "assistance"]).has(artifact.kind)
    || !validArtifactArray(artifact.inputDigests, artifactDigest)
    || !validArtifactArray(artifact.assumptions, artifactText)
    || !validArtifactArray(artifact.uncertainties, artifactText)
    || !validArtifactArray(artifact.unchecked, artifactText)
    || !exactKeys(artifact.provenance, ARTIFACT_PROVENANCE_KEYS)
    || !artifactText(artifact.provenance.providerId, 512)
    || !artifactText(artifact.provenance.modelId, 512)
    || !artifactDigest(artifact.provenance.policyDigest)
    || !exactKeys(artifact.metrics, ARTIFACT_METRICS_KEYS)
  ) return false;
  for (const field of ARTIFACT_METRICS_KEYS) {
    if (!Number.isSafeInteger(artifact.metrics[field]) || artifact.metrics[field] < 0) return false;
  }
  if (artifact.metrics.totalTokens !== artifact.metrics.inputTokens + artifact.metrics.outputTokens) return false;
  return validArtifactArray(artifact.claims, plainRecord)
    && validArtifactArray(artifact.evidence, plainRecord)
    && validArtifactArray(artifact.checks, plainRecord)
    && validArtifactArray(artifact.contradictions, plainRecord);
}

async function canonicalArtifactEnvelope(artifact, { runId, stage, sensitiveValues }) {
  let engine;
  try {
    artifactEnvelopeModulePromise ??= import("./engine/.dist/index.mjs");
    engine = await artifactEnvelopeModulePromise;
  } catch {
    throw new Error("pipeline_artifact_validator_unavailable");
  }
  if (typeof engine.createArtifactEnvelope !== "function") {
    throw new Error("pipeline_artifact_validator_unavailable");
  }

  let envelope;
  try {
    envelope = engine.createArtifactEnvelope(artifact);
  } catch {
    throw new Error("pipeline_artifact_invalid");
  }
  if (envelope.runId !== runId || envelope.stageId !== stage.id) {
    throw new Error("pipeline_artifact_lineage_invalid");
  }
  const expectedKind = stage.kind === "department"
    ? "department"
    : isWriteStage(stage)
      ? "action"
      : stage.kind === "truth-gate"
        ? "verification"
        : null;
  if (expectedKind && envelope.kind !== expectedKind) {
    throw new Error("pipeline_artifact_kind_invalid");
  }

  // Artifact IDs, digests, and stage/run lineage are structural receipts. Do
  // not redact-and-rewrite them: reject a secret-bearing envelope instead.
  const serialized = JSON.stringify(envelope);
  if (redactSensitiveText(serialized, sensitiveValues) !== serialized) {
    throw new Error("pipeline_artifact_sensitive_value");
  }
  return structuredClone(envelope);
}

function workspaceHash(workspace) {
  return createHash("sha256").update(workspace).digest("hex");
}

function normalizeStage(value, knownIds, sensitiveValues) {
  const source = value && typeof value === "object" ? value : {};
  const id = safeId(source.id, "stage_id", 160);
  const dependsOn = [...new Set((Array.isArray(source.dependsOn) ? source.dependsOn : []).map((item) => safeId(item, "stage_dependency", 160)))];
  if (dependsOn.includes(id)) throw new Error("pipeline_stage_self_dependency");
  for (const dependency of dependsOn) {
    if (knownIds && !knownIds.has(dependency)) throw new Error("pipeline_stage_dependency_missing");
  }
  return {
    id,
    name: publicText(source.name ?? source.label ?? id, sensitiveValues, 500),
    kind: optionalId(source.kind ?? source.type, "stage_kind", 120) || "work",
    departmentId: optionalId(source.departmentId, "department_id", 160) || undefined,
    teamProfileId: optionalId(source.teamProfileId, "team_profile_id", 160) || undefined,
    dependsOn,
    writeCapable: source.writeCapable === true
      || source.write === true
      || source.mutatesWorkspace === true
      || source.kind === "action"
      || source.type === "action",
    status: "pending",
    attempts: 0,
    executionClaimId: null,
    artifactIds: [],
    uncertain: false,
    startedAt: null,
    finishedAt: null,
    resolution: null,
    workspaceDigestBefore: null,
    metadata: publicValue(source.metadata && typeof source.metadata === "object" ? source.metadata : {}, sensitiveValues),
  };
}

function isWriteStage(stage) {
  return stage?.writeCapable === true || stage?.kind === "action";
}

function normalizeStages(values, sensitiveValues) {
  if (!Array.isArray(values)) throw new Error("pipeline_stages_invalid");
  const ids = values.map((value) => safeId(value?.id, "stage_id", 160));
  if (new Set(ids).size !== ids.length) throw new Error("pipeline_stage_id_duplicate");
  const known = new Set(ids);
  return values.map((value) => normalizeStage(value, known, sensitiveValues));
}

function normalizeSessionIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => safeId(value, "session_id", 300)))].slice(0, 1_000);
}

function hasDurableCompletionReceipt(stage) {
  if (stage.kind === "truth-gate") return Boolean(stage.truthGateReceipt);
  if (isWriteStage(stage)) {
    return Boolean(stage.actionReceipt) || stage.resolution?.outcome === "applied";
  }
  if (stage.kind === "department") return stage.artifactIds.length > 0;
  return true;
}

function clone(value) {
  return structuredClone(value);
}

function objectValue(value) {
  return value !== null && typeof value === "object";
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().flatMap((key) => (
    value[key] === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(value[key])}`]
  )).join(",")}}`;
}

function digestValue(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function buildDelta(before, after, path = [], operations = []) {
  if (Object.is(before, after)) return operations;
  if (Array.isArray(before) && Array.isArray(after)) {
    const shared = Math.min(before.length, after.length);
    for (let index = 0; index < shared; index += 1) {
      buildDelta(before[index], after[index], [...path, index], operations);
    }
    for (let index = before.length - 1; index >= after.length; index -= 1) {
      operations.push({ op: "remove", path: [...path, index] });
    }
    for (let index = shared; index < after.length; index += 1) {
      operations.push({ op: "set", path: [...path, index], value: clone(after[index]) });
    }
    return operations;
  }
  if (objectValue(before) && objectValue(after) && !Array.isArray(before) && !Array.isArray(after)) {
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key)) operations.push({ op: "remove", path: [...path, key] });
    }
    for (const key of Object.keys(after)) {
      if (!Object.hasOwn(before, key)) {
        operations.push({ op: "set", path: [...path, key], value: clone(after[key]) });
      } else {
        buildDelta(before[key], after[key], [...path, key], operations);
      }
    }
    return operations;
  }
  operations.push({ op: "set", path, value: clone(after) });
  return operations;
}

function validDeltaPath(path) {
  return Array.isArray(path)
    && path.length <= 64
    && path.every((segment) => (
      (Number.isSafeInteger(segment) && segment >= 0)
      || (
        typeof segment === "string"
        && segment.length > 0
        && segment.length <= 300
        && !["__proto__", "prototype", "constructor"].includes(segment)
      )
    ));
}

function applyDelta(base, operations) {
  let value = clone(base);
  for (const operation of operations) {
    if (
      !operation
      || typeof operation !== "object"
      || !new Set(["set", "remove"]).has(operation.op)
      || !validDeltaPath(operation.path)
    ) throw new Error("pipeline_run_state_corrupt");
    if (operation.path.length === 0) {
      if (operation.op !== "set" || !Object.hasOwn(operation, "value")) {
        throw new Error("pipeline_run_state_corrupt");
      }
      value = clone(operation.value);
      continue;
    }
    let parent = value;
    for (const segment of operation.path.slice(0, -1)) {
      if (!objectValue(parent) || !Object.hasOwn(parent, segment)) {
        throw new Error("pipeline_run_state_corrupt");
      }
      parent = parent[segment];
    }
    if (!objectValue(parent)) throw new Error("pipeline_run_state_corrupt");
    const key = operation.path.at(-1);
    if (Array.isArray(parent)) {
      if (!Number.isSafeInteger(key) || key < 0 || key > parent.length) {
        throw new Error("pipeline_run_state_corrupt");
      }
      if (operation.op === "remove") {
        if (key >= parent.length) throw new Error("pipeline_run_state_corrupt");
        parent.splice(key, 1);
      } else {
        if (!Object.hasOwn(operation, "value")) throw new Error("pipeline_run_state_corrupt");
        parent[key] = clone(operation.value);
      }
      continue;
    }
    if (typeof key !== "string") throw new Error("pipeline_run_state_corrupt");
    if (operation.op === "remove") {
      if (!Object.hasOwn(parent, key)) throw new Error("pipeline_run_state_corrupt");
      delete parent[key];
    } else {
      if (!Object.hasOwn(operation, "value")) throw new Error("pipeline_run_state_corrupt");
      parent[key] = clone(operation.value);
    }
  }
  return value;
}

function validSnapshot(value, runId) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || (value.journalVersion !== undefined && value.journalVersion !== JOURNAL_EVENT_VERSION)
    || value.runId !== runId
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 1
    || typeof value.pipelineId !== "string"
    || !value.pipelineId
    || typeof value.definitionRevision !== "string"
    || !value.definitionRevision
    || !/^[a-f0-9]{64}$/.test(value.definitionDigest ?? "")
    || !/^[a-f0-9]{64}$/.test(value.runtimeFingerprint ?? "")
    || !/^[a-f0-9]{64}$/.test(value.workspaceBaselineDigest ?? "")
    || !/^[a-f0-9]{64}$/.test(value.workspaceCheckpointDigest ?? "")
    || typeof value.workspace !== "string"
    || !value.workspace
    || value.workspaceHash !== workspaceHash(value.workspace)
    || typeof value.goal !== "string"
    || !RUN_STATUSES.has(value.status)
    || !Number.isFinite(Date.parse(value.workspaceBaselineObservedAt ?? ""))
    || !Number.isFinite(Date.parse(value.workspaceCheckpointObservedAt ?? ""))
    || !Number.isFinite(Date.parse(value.createdAt ?? ""))
    || !Number.isFinite(Date.parse(value.updatedAt ?? ""))
    || (value.startedAt != null && !Number.isFinite(Date.parse(value.startedAt)))
    || (value.finishedAt != null && !Number.isFinite(Date.parse(value.finishedAt)))
    || !Array.isArray(value.attachedSessionIds)
    || value.attachedSessionIds.length > 1_000
    || value.attachedSessionIds.some((id) => typeof id !== "string" || !id)
    || new Set(value.attachedSessionIds).size !== value.attachedSessionIds.length
    || !Array.isArray(value.stages)
    || !Array.isArray(value.artifacts)
    || value.artifacts.length > MAX_RUN_ARTIFACTS
    || !Array.isArray(value.approvals)
    || value.approvals.length > MAX_RUN_APPROVALS
    || !value.budget
    || typeof value.budget !== "object"
    || Array.isArray(value.budget)
  ) return false;

  const stageIds = new Set();
  for (const stage of value.stages) {
    if (
      !stage
      || typeof stage !== "object"
      || Array.isArray(stage)
      || typeof stage.id !== "string"
      || !stage.id
      || stageIds.has(stage.id)
      || typeof stage.kind !== "string"
      || !STAGE_STATUSES.has(stage.status)
      || !Number.isSafeInteger(stage.attempts)
      || stage.attempts < 0
      || !Array.isArray(stage.dependsOn)
      || !Array.isArray(stage.artifactIds)
      || typeof stage.writeCapable !== "boolean"
      || typeof stage.uncertain !== "boolean"
      || (
        stage.executionClaimId !== undefined
        && stage.executionClaimId !== null
        && (typeof stage.executionClaimId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stage.executionClaimId))
      )
      || (stage.startedAt != null && !Number.isFinite(Date.parse(stage.startedAt)))
      || (stage.finishedAt != null && !Number.isFinite(Date.parse(stage.finishedAt)))
      || !stage.metadata
      || typeof stage.metadata !== "object"
      || Array.isArray(stage.metadata)
      || (
        stage.actionReceipt !== undefined
        && (
          !plainRecord(stage.actionReceipt)
          || !artifactDigest(stage.actionReceiptDigest)
          || stage.actionReceiptDigest !== digestValue(stage.actionReceipt)
        )
      )
      || (stage.actionReceipt === undefined && stage.actionReceiptDigest !== undefined)
      || (
        stage.truthGateReceipt !== undefined
        && (
          !plainRecord(stage.truthGateReceipt)
          || !artifactDigest(stage.truthGateReceiptDigest)
          || stage.truthGateReceiptDigest !== digestValue(stage.truthGateReceipt)
          || !validReceiptDigestList(stage.truthGateReceipt.actionReceiptDigests)
        )
      )
      || (stage.truthGateReceipt === undefined && stage.truthGateReceiptDigest !== undefined)
    ) return false;
    stageIds.add(stage.id);
  }
  for (const stage of value.stages) {
    if (
      stage.dependsOn.some((dependency) => typeof dependency !== "string" || !stageIds.has(dependency))
      || new Set(stage.dependsOn).size !== stage.dependsOn.length
      || stage.artifactIds.some((artifactId) => typeof artifactId !== "string" || !artifactId)
      || new Set(stage.artifactIds).size !== stage.artifactIds.length
    ) return false;
  }

  const artifactIds = new Set();
  for (const artifact of value.artifacts) {
    const validArtifact = validPersistedArtifactEnvelope(artifact, runId, stageIds);
    if (!validArtifact || artifactIds.has(artifact.id)) return false;
    artifactIds.add(artifact.id);
  }
  for (const stage of value.stages) {
    if (stage.artifactIds.some((artifactId) => !artifactIds.has(artifactId))) return false;
  }
  if (value.artifacts.some((artifact) => !value.stages.find((stage) => stage.id === artifact.stageId)?.artifactIds.includes(artifact.id))) {
    return false;
  }
  for (const stage of value.stages) {
    if (stage.kind !== "truth-gate" || stage.truthGateReceipt === undefined) continue;
    try {
      const expected = upstreamActionReceiptDigests(value, stage);
      const actual = [...stage.truthGateReceipt.actionReceiptDigests]
        .map((digest) => digest.toLowerCase())
        .sort();
      if (expected.length === 0 || !sameDigestSet(expected, actual)) return false;
    } catch {
      return false;
    }
  }
  if (value.approvals.some((approval) => (
    !approval
    || typeof approval !== "object"
    || Array.isArray(approval)
    || typeof approval.id !== "string"
    || !approval.id
    || typeof approval.stageId !== "string"
    || !stageIds.has(approval.stageId)
    || !Number.isFinite(Date.parse(approval.recordedAt ?? ""))
  ))) return false;
  if (
    TERMINAL_RUN_STATUSES.has(value.status)
    && value.stages.some((stage) => stage.status === "running" || stage.status === "uncertain" || stage.uncertain)
  ) return false;
  if (
    value.status === "completed"
    && value.stages.some((stage) => stage.status !== "completed" || !hasDurableCompletionReceipt(stage))
  ) return false;
  return true;
}

function journalEventBody(row) {
  const { eventDigest: _eventDigest, ...body } = row;
  return body;
}

function validateJournalRow(row, runId, rawBytes) {
  if (
    !row
    || typeof row !== "object"
    || Array.isArray(row)
    || row.schemaVersion !== SCHEMA_VERSION
    || row.runId !== runId
    || !Number.isSafeInteger(row.sequence)
    || row.sequence < 1
    || typeof row.type !== "string"
    || !row.type
    || typeof row.at !== "string"
    || !Number.isFinite(Date.parse(row.at))
  ) throw new Error("pipeline_run_state_corrupt");

  if (row.eventVersion === undefined && row.state !== undefined) {
    if (rawBytes > MAX_JOURNAL_CHECKPOINT_BYTES || !validSnapshot(row.state, runId) || row.state.sequence !== row.sequence) {
      throw new Error("pipeline_run_state_corrupt");
    }
    return { format: "legacy", row };
  }

  if (
    row.eventVersion !== JOURNAL_EVENT_VERSION
    || !new Set(["checkpoint", "delta"]).has(row.kind)
    || !/^[a-f0-9]{64}$/.test(row.payloadDigest ?? "")
    || row.payloadDigest !== digestValue(row.payload ?? {})
    || !/^[a-f0-9]{64}$/.test(row.resultDigest ?? "")
    || !/^[a-f0-9]{64}$/.test(row.eventDigest ?? "")
    || digestValue(journalEventBody(row)) !== row.eventDigest
  ) throw new Error("pipeline_run_state_corrupt");

  if (row.kind === "checkpoint") {
    if (
      rawBytes > MAX_JOURNAL_CHECKPOINT_BYTES
      || !validSnapshot(row.checkpoint, runId)
      || row.checkpoint.sequence !== row.sequence
      || digestValue(row.checkpoint) !== row.resultDigest
    ) throw new Error("pipeline_run_state_corrupt");
    return { format: "checkpoint", row };
  }

  if (
    rawBytes > MAX_JOURNAL_DELTA_BYTES
    || !Number.isSafeInteger(row.baseSequence)
    || row.baseSequence < 1
    || row.sequence !== row.baseSequence + 1
    || !/^[a-f0-9]{64}$/.test(row.previousDigest ?? "")
    || !Array.isArray(row.delta)
    || row.delta.length > MAX_JOURNAL_DELTA_OPERATIONS
  ) throw new Error("pipeline_run_state_corrupt");
  return { format: "delta", row };
}

function makeJournalHead(row, state, journalBytes) {
  return {
    headVersion: JOURNAL_HEAD_VERSION,
    runId: state.runId,
    sequence: state.sequence,
    stateDigest: digestValue(state),
    eventDigest: row.eventDigest ?? digestValue(row),
    resultDigest: row.resultDigest ?? digestValue(state),
    journalBytes,
  };
}

function validJournalHead(head, state) {
  return Boolean(
    head
    && typeof head === "object"
    && !Array.isArray(head)
    && head.headVersion === JOURNAL_HEAD_VERSION
    && head.runId === state.runId
    && head.sequence === state.sequence
    && head.stateDigest === digestValue(state)
    && head.resultDigest === digestValue(state)
    && /^[a-f0-9]{64}$/.test(head.eventDigest ?? "")
    && Number.isSafeInteger(head.journalBytes)
    && head.journalBytes >= 0
  );
}

function validJournalHeadShape(head, runId) {
  return Boolean(
    head
    && typeof head === "object"
    && !Array.isArray(head)
    && head.headVersion === JOURNAL_HEAD_VERSION
    && head.runId === runId
    && Number.isSafeInteger(head.sequence)
    && head.sequence >= 1
    && /^[a-f0-9]{64}$/.test(head.stateDigest ?? "")
    && /^[a-f0-9]{64}$/.test(head.resultDigest ?? "")
    && /^[a-f0-9]{64}$/.test(head.eventDigest ?? "")
    && Number.isSafeInteger(head.journalBytes)
    && head.journalBytes > 0
  );
}

function recoverJournalState(raw, runId) {
  let state = null;
  let lastRow = null;
  let byteOffset = 0;
  let committedBytes = 0;
  const lines = raw.split("\n");
  const trailingPartialAllowed = !raw.endsWith("\n");
  for (const [index, line] of lines.entries()) {
    const spanBytes = Buffer.byteLength(line) + (index < lines.length - 1 ? 1 : 0);
    if (!line.trim()) {
      byteOffset += spanBytes;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      const trailingPartial = trailingPartialAllowed && index === lines.length - 1;
      if (trailingPartial) break;
      throw new Error("pipeline_run_state_corrupt");
    }
    const validated = validateJournalRow(parsed, runId, Buffer.byteLength(line));
    if (validated.format === "legacy" || validated.format === "checkpoint") {
      const checkpoint = validated.format === "legacy" ? parsed.state : parsed.checkpoint;
      if (state && checkpoint.sequence !== state.sequence + 1) throw new Error("pipeline_run_state_corrupt");
      if (!state && checkpoint.sequence !== 1) throw new Error("pipeline_run_state_corrupt");
      state = clone(checkpoint);
      lastRow = parsed;
      committedBytes = byteOffset + spanBytes;
      byteOffset += spanBytes;
      continue;
    }
    if (
      !state
      || parsed.baseSequence !== state.sequence
      || parsed.previousDigest !== digestValue(state)
    ) throw new Error("pipeline_run_state_corrupt");
    const recovered = applyDelta(state, parsed.delta);
    if (
      !validSnapshot(recovered, runId)
      || recovered.sequence !== parsed.sequence
      || digestValue(recovered) !== parsed.resultDigest
    ) throw new Error("pipeline_run_state_corrupt");
    state = recovered;
    lastRow = parsed;
    committedBytes = byteOffset + spanBytes;
    byteOffset += spanBytes;
  }
  if (!state) throw new Error("pipeline_run_state_corrupt");
  return { state, lastRow, committedBytes };
}

function runIdFromJournal(raw, expectedHash) {
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error("pipeline_run_state_corrupt");
    }
    if (
      typeof row?.runId !== "string"
      || !row.runId
      || createHash("sha256").update(row.runId).digest("hex") !== expectedHash
    ) throw new Error("pipeline_run_state_corrupt");
    return row.runId;
  }
  throw new Error("pipeline_run_state_corrupt");
}

function publicJournalEvent(row) {
  return {
    schemaVersion: row.schemaVersion,
    eventVersion: row.eventVersion ?? 1,
    runId: row.runId,
    sequence: row.sequence,
    type: row.type,
    payload: clone(row.payload ?? {}),
    payloadDigest: row.payloadDigest ?? digestValue(row.payload ?? {}),
    resultDigest: row.resultDigest ?? digestValue(row.state),
    eventDigest: row.eventDigest ?? digestValue(row),
    at: row.at,
    ...(row.kind ? { kind: row.kind } : {}),
  };
}

async function fileEndsWithNewline(path, committedBytes = null) {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const size = committedBytes ?? info.size;
    if (!Number.isSafeInteger(size) || size < 0 || info.size < size) {
      throw new Error("pipeline_run_state_corrupt");
    }
    if (size === 0) return true;
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, size - 1);
    return buffer[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path, value) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

function resolutionForStage(options, stageId, uncertainCount) {
  const direct = options?.resolutionMarkers?.[stageId];
  if (direct != null) return direct;
  if (uncertainCount === 1 && options?.resolutionMarker != null) return options.resolutionMarker;
  return null;
}

function applyResolution(stage, marker, sensitiveValues, at, isVerifiedResolution) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) throw new Error("pipeline_write_resolution_required");
  if (!isVerifiedResolution(marker)) throw new Error("pipeline_write_resolution_unverified");
  const value = publicValue(marker, sensitiveValues);
  const outcome = String(marker.outcome ?? "");
  if (!new Set(["retry", "applied", "abandoned"]).has(outcome)) {
    throw new Error("pipeline_write_resolution_invalid");
  }
  return {
    ...stage,
    status: outcome === "applied" ? "completed" : outcome === "abandoned" ? "failed" : "interrupted",
    uncertain: false,
    finishedAt: outcome === "applied" || outcome === "abandoned" ? at : null,
    resolution: {
      marker: value,
      outcome,
      resolvedAt: at,
      // A verified no-write result authorizes one crash-recovery attempt. The
      // authorization is consumed below when that attempt starts; it is not a
      // general increase to the configured retry budget.
      retryAuthorizedAt: outcome === "retry" ? at : null,
      retryConsumedAt: null,
    },
    ...(outcome === "applied"
      ? {
        // A verifier-backed applied resolution is itself the durable write
        // receipt for an interrupted action. Truth gates must cite this exact
        // persisted digest just as they cite a normal action receipt.
        actionReceipt: value,
        actionReceiptDigest: digestValue(value),
      }
      : {}),
  };
}

function canonicalReceipt(value, sensitiveValues, invalidCode) {
  if (!plainRecord(value)) throw new Error(invalidCode);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(invalidCode);
  }
  if (typeof serialized !== "string" || redactSensitiveText(serialized, sensitiveValues) !== serialized) {
    throw new Error(invalidCode);
  }
  return JSON.parse(serialized);
}

function validReceiptDigestList(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_ARTIFACT_COLLECTION_ITEMS
    && value.every(artifactDigest)
    && new Set(value).size === value.length;
}

function upstreamActionReceiptDigests(state, stage) {
  const stages = new Map(state.stages.map((candidate) => [candidate.id, candidate]));
  const visited = new Set();
  const digests = new Set();
  const visit = (stageId) => {
    if (visited.has(stageId)) return;
    visited.add(stageId);
    const candidate = stages.get(stageId);
    if (!candidate) throw new Error("pipeline_stage_dependency_missing");
    for (const dependencyId of candidate.dependsOn) visit(dependencyId);
    if (isWriteStage(candidate)) {
      if (!artifactDigest(candidate.actionReceiptDigest)) {
        throw new Error("pipeline_truth_gate_action_lineage_invalid");
      }
      digests.add(candidate.actionReceiptDigest.toLowerCase());
    }
  };
  for (const dependencyId of stage.dependsOn) visit(dependencyId);
  return [...digests].sort();
}

function sameDigestSet(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

const BUDGET_INTEGER_FIELDS = Object.freeze([
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "calls",
  "wallTimeMs",
  "repairCycles",
  "assistanceRequests",
]);
const BUDGET_USAGE_FIELDS = Object.freeze([...BUDGET_INTEGER_FIELDS, "costUsd"]);
const BUDGET_DELTA_FIELDS = Object.freeze([...BUDGET_USAGE_FIELDS, "unmeteredCalls"]);

function budgetConsumed(state) {
  const value = state.budget?.consumed;
  return plainRecord(value) ? value : {};
}

function applyBudgetPatch(state, patch, at) {
  if (!plainRecord(patch)) throw new Error("pipeline_budget_invalid");
  if (Object.keys(patch).some((key) => !["consumed", "unmeteredCalls"].includes(key))) {
    throw new Error("pipeline_budget_limits_immutable");
  }
  if (patch.consumed !== undefined && !plainRecord(patch.consumed)) {
    throw new Error("pipeline_budget_usage_invalid");
  }
  const supplied = patch.consumed ?? {};
  if (Object.keys(supplied).some((field) => !BUDGET_USAGE_FIELDS.includes(field))) {
    throw new Error("pipeline_budget_usage_invalid");
  }
  const previous = budgetConsumed(state);
  const consumed = { ...previous };
  for (const field of BUDGET_USAGE_FIELDS) {
    if (!Object.hasOwn(supplied, field)) continue;
    const value = supplied[field];
    const prior = Number(previous[field] ?? 0);
    if (
      !Number.isFinite(value)
      || value < prior
      || value < 0
      || (BUDGET_INTEGER_FIELDS.includes(field) && !Number.isSafeInteger(value))
    ) {
      throw new Error(
        Number.isFinite(value) && value >= 0 && value < prior
          ? "pipeline_budget_non_monotonic"
          : "pipeline_budget_usage_invalid",
      );
    }
    consumed[field] = value;
  }
  if (
    Object.hasOwn(consumed, "totalTokens")
    && Number(consumed.totalTokens) < Number(consumed.inputTokens ?? 0) + Number(consumed.outputTokens ?? 0)
  ) {
    throw new Error("pipeline_budget_total_invalid");
  }
  const unmeteredCalls = patch.unmeteredCalls ?? state.budget?.unmeteredCalls ?? 0;
  if (!Number.isSafeInteger(unmeteredCalls) || unmeteredCalls < 0) {
    throw new Error("pipeline_budget_usage_invalid");
  }
  if (unmeteredCalls < Number(state.budget?.unmeteredCalls ?? 0)) {
    throw new Error("pipeline_budget_non_monotonic");
  }
  const limits = state.budget?.limits ?? {};
  const usage = {
    inputTokens: Number(consumed.inputTokens ?? 0),
    outputTokens: Number(consumed.outputTokens ?? 0),
    totalTokens: Object.hasOwn(consumed, "totalTokens")
      ? Number(consumed.totalTokens)
      : Number(consumed.inputTokens ?? 0) + Number(consumed.outputTokens ?? 0),
    calls: Number(consumed.calls ?? 0) + unmeteredCalls,
    wallTimeMs: Number(consumed.wallTimeMs ?? 0),
    repairCycles: Number(consumed.repairCycles ?? 0),
    assistanceRequests: Number(consumed.assistanceRequests ?? 0),
    costUsd: Number(consumed.costUsd ?? 0),
  };
  const limitByField = {
    inputTokens: limits.maxInputTokens,
    outputTokens: limits.maxOutputTokens,
    totalTokens: limits.maxTotalTokens,
    calls: limits.maxCalls,
    wallTimeMs: limits.maxWallTimeMs,
    repairCycles: limits.maxRepairCycles,
    assistanceRequests: limits.maxAssistanceRequests,
    costUsd: limits.maxCostUsd,
  };
  const overage = {};
  let exhausted = false;
  let overdrawn = false;
  for (const [field, used] of Object.entries(usage)) {
    const limit = limitByField[field];
    if (!Number.isFinite(limit)) continue;
    if (used >= limit) exhausted = true;
    if (used > limit) {
      overdrawn = true;
      overage[field] = used - limit;
    }
  }
  exhausted ||= state.budget?.exhausted === true;
  overdrawn ||= state.budget?.overdrawn === true;
  state.budget = {
    ...state.budget,
    consumed,
    unmeteredCalls,
    exhausted,
    overdrawn,
    overage,
    ...(exhausted ? { exhaustedAt: state.budget?.exhaustedAt ?? at } : {}),
    ...(overdrawn ? { overdrawnAt: state.budget?.overdrawnAt ?? at } : {}),
  };
}

function applyBudgetDelta(state, delta, at) {
  if (!plainRecord(delta) || Object.keys(delta).some((field) => !BUDGET_DELTA_FIELDS.includes(field))) {
    throw new Error("pipeline_budget_usage_invalid");
  }
  const tokenFields = ["inputTokens", "outputTokens", "totalTokens"];
  const hasTokenUsage = tokenFields.some((field) => Object.hasOwn(delta, field));
  if (hasTokenUsage && !tokenFields.every((field) => Object.hasOwn(delta, field))) {
    throw new Error("pipeline_budget_usage_invalid");
  }
  const previous = budgetConsumed(state);
  const consumed = {};
  for (const field of BUDGET_USAGE_FIELDS) {
    const increment = Object.hasOwn(delta, field) ? delta[field] : 0;
    if (
      !Number.isFinite(increment)
      || increment < 0
      || (BUDGET_INTEGER_FIELDS.includes(field) && !Number.isSafeInteger(increment))
    ) {
      throw new Error("pipeline_budget_usage_invalid");
    }
    const prior = Number(previous[field] ?? 0);
    const next = prior + increment;
    if (!Number.isFinite(next) || (BUDGET_INTEGER_FIELDS.includes(field) && !Number.isSafeInteger(next))) {
      throw new Error("pipeline_budget_usage_invalid");
    }
    consumed[field] = next;
  }
  const unmeteredIncrement = Object.hasOwn(delta, "unmeteredCalls") ? delta.unmeteredCalls : 0;
  if (!Number.isSafeInteger(unmeteredIncrement) || unmeteredIncrement < 0) {
    throw new Error("pipeline_budget_usage_invalid");
  }
  const priorUnmetered = Number(state.budget?.unmeteredCalls ?? 0);
  const unmeteredCalls = priorUnmetered + unmeteredIncrement;
  if (!Number.isSafeInteger(unmeteredCalls)) throw new Error("pipeline_budget_usage_invalid");
  applyBudgetPatch(state, { consumed, unmeteredCalls }, at);
}

export class PipelineRunStore {
  constructor({ dataDir, getSensitiveValues = () => [], now = () => new Date(), isVerifiedResolution = () => false, isVerifiedTruthGate = () => false, isVerifiedActionReceipt = () => false, onJournalAppend = async () => {} } = {}) {
    if (typeof dataDir !== "string" || !dataDir) throw new Error("pipeline_run_store_dir_required");
    if (typeof getSensitiveValues !== "function") throw new Error("pipeline_run_store_sensitive_values_invalid");
    if (typeof isVerifiedResolution !== "function") throw new Error("pipeline_run_store_resolution_verifier_invalid");
    if (typeof isVerifiedTruthGate !== "function") throw new Error("pipeline_run_store_truth_gate_verifier_invalid");
    if (typeof isVerifiedActionReceipt !== "function") throw new Error("pipeline_run_store_action_receipt_verifier_invalid");
    if (typeof onJournalAppend !== "function") throw new Error("pipeline_run_store_journal_hook_invalid");
    this.dir = join(dataDir, "pipeline-runs");
    this.getSensitiveValues = getSensitiveValues;
    this.now = now;
    this.isVerifiedResolution = isVerifiedResolution;
    this.isVerifiedTruthGate = isVerifiedTruthGate;
    this.isVerifiedActionReceipt = isVerifiedActionReceipt;
    this.onJournalAppend = onJournalAppend;
    this.tails = new Map();
  }

  pathFor(runId) {
    const id = safeId(runId, "run_id");
    return join(this.dir, `${createHash("sha256").update(id).digest("hex")}.json`);
  }

  journalPathFor(runId) {
    return this.pathFor(runId).replace(/\.json$/, ".jsonl");
  }

  headPathFor(runId) {
    return this.pathFor(runId).replace(/\.json$/, ".head.json");
  }

  lockDirFor(runId) {
    return this.pathFor(runId).replace(/\.json$/, ".lock");
  }

  _at() {
    return this.now().toISOString();
  }

  _serialize(runId, operation) {
    const id = safeId(runId, "run_id");
    const previous = this.tails.get(id) ?? Promise.resolve();
    const next = previous.then(operation);
    this.tails.set(id, next.catch(() => undefined));
    return next;
  }

  async _withRunLock(runId, operation) {
    await mkdir(this.dir, { recursive: true });
    const lockDir = this.lockDirFor(runId);
    const ownerFile = join(lockDir, "owner");
    const owner = randomUUID();
    const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        await mkdir(lockDir);
        try {
          await writeFile(ownerFile, owner, { encoding: "utf8", mode: 0o600 });
        } catch (error) {
          await rm(lockDir, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const info = await stat(lockDir);
          if (Date.now() - info.mtimeMs > FILE_LOCK_STALE_MS) {
            await rm(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch (inspectionError) {
          if (inspectionError?.code === "ENOENT") continue;
          throw inspectionError;
        }
        if (Date.now() >= deadline) throw new Error("pipeline_run_store_busy");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
      }
    }
    try {
      return await operation();
    } finally {
      const currentOwner = await readFile(ownerFile, "utf8").catch(() => "");
      if (currentOwner === owner) await rm(lockDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async _readRaw(runId, { repair = false } = {}) {
    const id = safeId(runId, "run_id");
    let snapshot = null;
    let snapshotMissing = false;
    let snapshotCorrupt = false;
    try {
      const parsed = JSON.parse(await readFile(this.pathFor(id), "utf8"));
      if (validSnapshot(parsed, id)) snapshot = parsed;
      else snapshotCorrupt = true;
    } catch (error) {
      if (error?.code === "ENOENT") snapshotMissing = true;
      else if (error instanceof SyntaxError) snapshotCorrupt = true;
      else throw error;
    }

    let headMissing = false;
    if (snapshot) {
      try {
        const head = JSON.parse(await readFile(this.headPathFor(id), "utf8"));
        if (validJournalHead(head, snapshot)) {
          let journalSize;
          try {
            journalSize = (await stat(this.journalPathFor(id))).size;
          } catch {
            throw new Error("pipeline_run_state_corrupt");
          }
          if (journalSize < head.journalBytes) throw new Error("pipeline_run_state_corrupt");
          if (repair && journalSize > head.journalBytes) {
            await truncate(this.journalPathFor(id), head.journalBytes);
          }
          return clone(snapshot);
        }
      } catch (error) {
        if (error?.code === "ENOENT") headMissing = true;
        else if (error instanceof SyntaxError) {
          // Recover from the authenticated journal below.
        } else throw error;
      }
    }

    let rawJournal;
    try {
      rawJournal = await readFile(this.journalPathFor(id), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        if (snapshot && headMissing) {
          if (snapshot.journalVersion === JOURNAL_EVENT_VERSION) {
            throw new Error("pipeline_run_state_corrupt");
          }
          return clone(snapshot);
        }
        if (snapshotCorrupt) throw new Error("pipeline_run_state_corrupt");
        if (snapshotMissing) return null;
        throw new Error("pipeline_run_state_corrupt");
      }
      throw error;
    }

    const recovered = recoverJournalState(rawJournal, id);
    if (snapshot && snapshot.sequence > recovered.state.sequence) {
      throw new Error("pipeline_run_state_corrupt");
    }
    if (repair) {
      await truncate(this.journalPathFor(id), recovered.committedBytes);
      await atomicWrite(this.pathFor(id), recovered.state);
      await atomicWrite(
        this.headPathFor(id),
        makeJournalHead(recovered.lastRow, recovered.state, recovered.committedBytes),
      );
    }
    return clone(recovered.state);
  }

  async _commit(state, type, payload = {}, previousState = null) {
    const sensitive = this.getSensitiveValues();
    const at = this._at();
    const next = JSON.parse(JSON.stringify({
      ...state,
      journalVersion: JOURNAL_EVENT_VERSION,
      sequence: Number(previousState?.sequence ?? state.sequence ?? 0) + 1,
      updatedAt: at,
    }));
    const safePayload = publicValue(payload, sensitive);
    const base = {
      schemaVersion: SCHEMA_VERSION,
      eventVersion: JOURNAL_EVENT_VERSION,
      runId: next.runId,
      sequence: next.sequence,
      type: boundedText(type, 160),
      payload: safePayload,
      payloadDigest: digestValue(safePayload),
      at,
      resultDigest: digestValue(next),
    };
    let row;
    if (previousState == null) {
      row = { ...base, kind: "checkpoint", checkpoint: next };
    } else {
      const delta = buildDelta(previousState, next);
      if (delta.length > MAX_JOURNAL_DELTA_OPERATIONS) {
        throw new Error("pipeline_journal_event_too_large");
      }
      row = {
        ...base,
        kind: "delta",
        baseSequence: previousState.sequence,
        previousDigest: digestValue(previousState),
        delta,
      };
    }
    row.eventDigest = digestValue(row);
    const encoded = JSON.stringify(row);
    const maxBytes = row.kind === "checkpoint" ? MAX_JOURNAL_CHECKPOINT_BYTES : MAX_JOURNAL_DELTA_BYTES;
    if (Buffer.byteLength(encoded) > maxBytes) throw new Error("pipeline_journal_event_too_large");
    validateJournalRow(row, next.runId, Buffer.byteLength(encoded));
    await mkdir(this.dir, { recursive: true });
    if (previousState) {
      let head;
      try {
        head = JSON.parse(await readFile(this.headPathFor(next.runId), "utf8"));
      } catch {
        throw new Error("pipeline_run_state_corrupt");
      }
      if (!validJournalHead(head, previousState)) throw new Error("pipeline_run_state_corrupt");
      let journalSize;
      try {
        journalSize = (await stat(this.journalPathFor(next.runId))).size;
      } catch {
        throw new Error("pipeline_run_state_corrupt");
      }
      if (journalSize < head.journalBytes) throw new Error("pipeline_run_state_corrupt");
      if (journalSize > head.journalBytes) await truncate(this.journalPathFor(next.runId), head.journalBytes);
    }
    await appendFile(this.journalPathFor(next.runId), `\n${encoded}\n`, { encoding: "utf8", mode: 0o600 });
    const journalBytes = (await stat(this.journalPathFor(next.runId))).size;
    await this.onJournalAppend({ runId: next.runId, sequence: next.sequence });
    await atomicWrite(this.pathFor(next.runId), next);
    await atomicWrite(this.headPathFor(next.runId), makeJournalHead(row, next, journalBytes));
    return clone(next);
  }

  async create({
    runId = randomUUID(),
    pipelineId,
    definitionRevision,
    definitionDigest,
    runtimeFingerprint,
    workspaceBaselineDigest,
    workspaceBaselineObservedAt,
    goal = "",
    workspace,
    attachedSessionIds = [],
    stages = [],
    budget = {},
  } = {}) {
    const id = safeId(runId, "run_id");
    return this._serialize(id, () => this._withRunLock(id, async () => {
      if (await this._readRaw(id, { repair: false })) throw new Error("pipeline_run_exists");
      const sensitive = this.getSensitiveValues();
      const pipeline = safeId(pipelineId, "pipeline_id", 160);
      const revision = safeId(definitionRevision, "definition_revision", 300);
      const definitionHash = safeId(definitionDigest, "definition_digest", 128);
      const runtimeHash = safeId(runtimeFingerprint, "runtime_fingerprint", 128);
      const baselineHash = safeId(workspaceBaselineDigest, "workspace_baseline_digest", 128);
      const baselineObservedAt = iso(workspaceBaselineObservedAt, "");
      if (
        !/^[a-f0-9]{64}$/.test(definitionHash)
        || !/^[a-f0-9]{64}$/.test(runtimeHash)
        || !/^[a-f0-9]{64}$/.test(baselineHash)
        || !baselineObservedAt
      ) {
        throw new Error("pipeline_runtime_fingerprint_invalid");
      }
      const workspaceValue = boundedText(workspace, 32_000).trim();
      if (!workspaceValue) throw new Error("pipeline_workspace_invalid");
      const at = this._at();
      const state = {
        schemaVersion: SCHEMA_VERSION,
        journalVersion: JOURNAL_EVENT_VERSION,
        sequence: 0,
        runId: id,
        pipelineId: pipeline,
        definitionRevision: revision,
        definitionDigest: definitionHash,
        runtimeFingerprint: runtimeHash,
        workspaceBaselineDigest: baselineHash,
        workspaceBaselineObservedAt: baselineObservedAt,
        workspaceCheckpointDigest: baselineHash,
        workspaceCheckpointObservedAt: baselineObservedAt,
        goal: publicText(goal, sensitive),
        workspace: workspaceValue,
        workspaceHash: workspaceHash(workspaceValue),
        attachedSessionIds: normalizeSessionIds(attachedSessionIds),
        stages: normalizeStages(stages, sensitive),
        artifacts: [],
        approvals: [],
        budget: publicValue(budget && typeof budget === "object" ? budget : {}, sensitive),
        status: "queued",
        createdAt: at,
        updatedAt: at,
        startedAt: null,
        finishedAt: null,
        interruption: null,
      };
      if (
        state.runId !== id
        || state.pipelineId !== pipeline
        || state.definitionRevision !== revision
        || state.definitionDigest !== definitionHash
        || state.runtimeFingerprint !== runtimeHash
        || state.workspaceBaselineDigest !== baselineHash
        || state.workspaceBaselineObservedAt !== baselineObservedAt
      ) {
        throw new Error("pipeline_identity_contains_sensitive_value");
      }
      return this._commit(state, "run.created", { pipelineId: pipeline, definitionRevision: revision });
    }));
  }

  async load(runId) {
    const id = safeId(runId, "run_id");
    return this._serialize(id, () => this._withRunLock(id, () => this._readRaw(id, { repair: true })));
  }

  async list() {
    await this.flush();
    await mkdir(this.dir, { recursive: true });
    const groups = new Map();
    for (const name of await readdir(this.dir)) {
      if (!/^[a-f0-9]{64}(?:\.json|\.jsonl|\.head\.json)$/.test(name)) continue;
      const key = name.slice(0, 64);
      const group = groups.get(key) ?? { snapshotPath: null, journalPath: null, headPath: null };
      groups.set(key, group);
      const path = join(this.dir, name);
      if (name.endsWith(".head.json")) group.headPath = path;
      else if (name.endsWith(".json")) group.snapshotPath = path;
      else group.journalPath = path;
    }

    const values = [];
    for (const [hash, group] of groups.entries()) {
      let snapshot = null;
      if (group.snapshotPath) {
        try {
          const parsed = JSON.parse(await readFile(group.snapshotPath, "utf8"));
          if (
            typeof parsed?.runId === "string"
            && createHash("sha256").update(parsed.runId).digest("hex") === hash
            && validSnapshot(parsed, parsed.runId)
          ) snapshot = parsed;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      if (snapshot) {
        let head = null;
        let headMissing = false;
        try {
          if (!group.headPath) headMissing = true;
          else head = JSON.parse(await readFile(group.headPath, "utf8"));
        } catch (error) {
          if (error?.code === "ENOENT") headMissing = true;
          else if (!(error instanceof SyntaxError)) throw error;
        }
        if (validJournalHead(head, snapshot)) {
          if (!group.journalPath) throw new Error("pipeline_run_state_corrupt");
          const journalSize = (await stat(group.journalPath)).size;
          if (journalSize < head.journalBytes) throw new Error("pipeline_run_state_corrupt");
          // The atomic snapshot plus its small integrity head is canonical. In
          // the healthy polling path list() never opens the append-only journal.
          values.push(snapshot);
          continue;
        }
        if (headMissing && !group.journalPath) {
          if (snapshot.journalVersion === JOURNAL_EVENT_VERSION) {
            throw new Error("pipeline_run_state_corrupt");
          }
          values.push(snapshot);
          continue;
        }
      }
      if (!group.journalPath) throw new Error("pipeline_run_state_corrupt");
      const raw = await readFile(group.journalPath, "utf8");
      const runId = runIdFromJournal(raw, hash);
      const recovered = await this._serialize(
        runId,
        () => this._withRunLock(runId, () => this._readRaw(runId, { repair: true })),
      );
      if (!recovered) throw new Error("pipeline_run_state_corrupt");
      values.push(recovered);
    }
    return values.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async _mutate(runId, type, updater, payload = {}) {
    const id = safeId(runId, "run_id");
    return this._serialize(id, () => this._withRunLock(id, async () => {
      const current = await this._readRaw(id, { repair: true });
      if (!current) throw new Error("pipeline_run_not_found");
      if (TERMINAL_RUN_STATUSES.has(current.status) && !String(type).startsWith("run.")) {
        throw new Error("pipeline_run_terminal");
      }
      const next = await updater(clone(current), this._at(), this.getSensitiveValues());
      if (JSON.stringify(next) === JSON.stringify(current)) return clone(current);
      if (
        next.definitionRevision !== current.definitionRevision
        || next.definitionDigest !== current.definitionDigest
        || next.runtimeFingerprint !== current.runtimeFingerprint
        || next.workspaceBaselineDigest !== current.workspaceBaselineDigest
        || next.workspaceBaselineObservedAt !== current.workspaceBaselineObservedAt
        || next.pipelineId !== current.pipelineId
        || next.runId !== current.runId
      ) {
        throw new Error("pipeline_definition_revision_immutable");
      }
      return this._commit(next, type, payload, current);
    }));
  }

  transition(runId, status, details = {}) {
    if (!RUN_STATUSES.has(status)) throw new Error("pipeline_status_invalid");
    return this._mutate(runId, `run.${status}`, (state, at, sensitive) => {
      if (state.status === status) return state;
      if (!RUN_TRANSITIONS[state.status]?.has(status)) throw new Error("pipeline_status_transition_invalid");
      if (TERMINAL_RUN_STATUSES.has(status)) {
        const unresolvedWrite = state.stages.some((stage) => (
          isWriteStage(stage) && (stage.status === "running" || stage.status === "uncertain" || stage.uncertain)
        ));
        if (unresolvedWrite) throw new Error("pipeline_write_resolution_required");
        if (state.stages.some((stage) => stage.status === "running")) {
          throw new Error("pipeline_stage_active");
        }
        if (
          status === "completed"
          && state.stages.some((stage) => stage.status !== "completed" || !hasDurableCompletionReceipt(stage))
        ) {
          throw new Error("pipeline_completion_gate_failed");
        }
      }
      state.status = status;
      state.startedAt ??= status === "running" ? at : null;
      if (TERMINAL_RUN_STATUSES.has(status)) state.finishedAt = at;
      state.lastTransition = { status, at, details: publicValue(details, sensitive) };
      return state;
    }, details);
  }

  start(runId) { return this.transition(runId, "running"); }
  pause(runId, details = {}) { return this.transition(runId, "paused", details); }
  cancel(runId, details = {}) {
    return this._mutate(runId, "run.cancel_requested", (state, at, sensitive) => {
      if (state.status === "cancelled") return state;
      if (TERMINAL_RUN_STATUSES.has(state.status)) throw new Error("pipeline_status_transition_invalid");
      const unresolvedWrite = state.stages.some((stage) => (
        isWriteStage(stage) && (stage.status === "running" || stage.status === "uncertain" || stage.uncertain)
      ));
      state.status = unresolvedWrite ? "interrupted" : "cancelled";
      state.finishedAt = unresolvedWrite ? null : at;
      state.interruption = unresolvedWrite ? { reason: "cancelled_during_write", at } : state.interruption;
      state.lastTransition = {
        status: state.status,
        at,
        details: publicValue({ ...details, cancelRequested: true }, sensitive),
      };
      state.stages = state.stages.map((stage) => stage.status !== "running" ? stage : {
        ...stage,
        status: isWriteStage(stage) ? "uncertain" : "interrupted",
        uncertain: isWriteStage(stage),
        finishedAt: at,
      });
      return state;
    }, details);
  }

  resume(runId, options = {}) {
    return this._mutate(runId, "run.resumed", (state, at, sensitive) => {
      if (state.status !== "paused" && state.status !== "interrupted") throw new Error("pipeline_resume_invalid");
      const uncertain = state.stages.filter((stage) => stage.status === "uncertain" || stage.uncertain === true);
      let checkpointMarker = null;
      state.stages = state.stages.map((stage) => {
        if (!uncertain.includes(stage)) return stage;
        const marker = resolutionForStage(options, stage.id, uncertain.length);
        if (marker == null) throw new Error("pipeline_write_resolution_required");
        const resolved = applyResolution(stage, marker, sensitive, at, this.isVerifiedResolution);
        if (["applied", "abandoned"].includes(resolved.resolution?.outcome)) {
          if (checkpointMarker && checkpointMarker.workspaceDigest !== resolved.resolution.marker?.workspaceDigest) {
            throw new Error("pipeline_write_resolution_conflict");
          }
          checkpointMarker = resolved.resolution.marker;
        }
        return resolved;
      });
      if (checkpointMarker) {
        const digest = checkpointMarker.workspaceDigest;
        const observedAt = iso(checkpointMarker.observedAt, "");
        if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest) || !observedAt) {
          throw new Error("pipeline_write_resolution_invalid");
        }
        state.workspaceCheckpointDigest = digest;
        state.workspaceCheckpointObservedAt = observedAt;
      }
      state.status = "running";
      state.finishedAt = null;
      state.interruption = null;
      state.lastTransition = { status: "running", at, details: { resumed: true } };
      return state;
    }, { resolutionProvided: Boolean(options?.resolutionMarker || options?.resolutionMarkers) });
  }

  attachSession(runId, sessionId) {
    const id = safeId(sessionId, "session_id", 300);
    return this._mutate(runId, "session.attached", (state) => {
      if (!state.attachedSessionIds.includes(id)) state.attachedSessionIds.push(id);
      return state;
    }, { sessionId: id });
  }

  updateStage(runId, stageId, update = {}) {
    const id = safeId(stageId, "stage_id", 160);
    return this._mutate(runId, "stage.updated", (state, at, sensitive) => {
      if (state.status !== "running") throw new Error("pipeline_stage_run_inactive");
      const index = state.stages.findIndex((stage) => stage.id === id);
      if (index < 0) throw new Error("pipeline_stage_not_found");
      const current = state.stages[index];
      const expectedStatus = update.expectedStatus;
      if (expectedStatus !== undefined && !STAGE_STATUSES.has(expectedStatus)) {
        throw new Error("pipeline_stage_status_invalid");
      }
      // The coordinator uses this compare-and-set guard to durably claim a
      // stage before an outbound provider call. A stale contender observes the
      // current snapshot without mutating it.
      if (expectedStatus !== undefined && current.status !== expectedStatus) return state;
      const executionClaimId = update.executionClaimId;
      if (
        executionClaimId !== undefined
        && (typeof executionClaimId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(executionClaimId))
      ) {
        throw new Error("pipeline_stage_claim_invalid");
      }
      const expectedExecutionClaimId = update.expectedExecutionClaimId;
      if (expectedExecutionClaimId !== undefined && current.executionClaimId !== expectedExecutionClaimId) {
        throw new Error("pipeline_stage_claim_lost");
      }
      if (update.metadata && typeof update.metadata === "object" && Object.hasOwn(update.metadata, "retry")) {
        throw new Error("pipeline_stage_retry_immutable");
      }
      let status = update.status ?? current.status;
      let actionReceipt = null;
      let truthGateReceipt = null;
      let resolvingUncertain = false;
      if (!STAGE_STATUSES.has(status)) throw new Error("pipeline_stage_status_invalid");
      if (status === "skipped" && status !== current.status) {
        throw new Error("pipeline_stage_skip_forbidden");
      }
      if (current.kind === "approval" && status !== current.status) {
        throw new Error("pipeline_approval_api_required");
      }
      if (
        current.kind === "truth-gate"
        && status === "completed"
        && !this.isVerifiedTruthGate(update.truthGateReceipt)
      ) {
        throw new Error("pipeline_truth_gate_receipt_required");
      }
      if (current.kind === "truth-gate" && status === "completed") {
        truthGateReceipt = canonicalReceipt(
          update.truthGateReceipt,
          sensitive,
          "pipeline_truth_gate_receipt_invalid",
        );
      }
      if (
        isWriteStage(current)
        && current.status === "running"
        && status === "completed"
        && !this.isVerifiedActionReceipt(update.actionReceipt)
      ) {
        throw new Error("pipeline_action_receipt_required");
      }
      if (isWriteStage(current) && current.status === "running" && status === "completed") {
        actionReceipt = canonicalReceipt(
          update.actionReceipt,
          sensitive,
          "pipeline_action_receipt_invalid",
        );
      }
      if (
        current.kind === "department"
        && status === "completed"
        && current.artifactIds.length === 0
      ) {
        throw new Error("pipeline_department_artifact_required");
      }
      if (
        isWriteStage(current)
        && current.status === "running"
        && ["blocked", "budget_paused", "failed", "cancelled", "interrupted"].includes(status)
      ) {
        status = "uncertain";
      }
      if (current.status === "pending" && status === "running") {
        const dependenciesReady = current.dependsOn.every((dependencyId) => (
          state.stages.find((stage) => stage.id === dependencyId)?.status === "completed"
        ));
        if (!dependenciesReady) throw new Error("pipeline_stage_dependencies_incomplete");
      }
      if ((current.status === "uncertain" || current.uncertain) && status !== "uncertain") {
        if (update.resolutionMarker == null) throw new Error("pipeline_write_resolution_required");
        const resolved = applyResolution(current, update.resolutionMarker, sensitive, at, this.isVerifiedResolution);
        if (status === "running" && resolved.status !== "interrupted") {
          throw new Error("pipeline_write_resolution_outcome_invalid");
        }
        if ((status === "completed" || status === "failed") && resolved.status !== status) {
          throw new Error("pipeline_write_resolution_outcome_invalid");
        }
        state.stages[index] = resolved;
        resolvingUncertain = true;
      }
      if (
        current.status !== status
        && !resolvingUncertain
        && !STAGE_TRANSITIONS[current.status]?.has(status)
      ) {
        throw new Error("pipeline_stage_transition_invalid");
      }
      let base = state.stages[index];
      if (status === "running" && current.status !== "running") {
        if (
          isWriteStage(base)
          && (base.resolution?.outcome === "applied" || base.resolution?.outcome === "abandoned")
        ) {
          throw new Error("pipeline_write_resolution_outcome_invalid");
        }
        const configuredAttempts = Number(base.metadata?.retry?.maxAttempts);
        const maxAttempts = Number.isInteger(configuredAttempts) && configuredAttempts > 0
          ? configuredAttempts
          : 1;
        const crashRetryAuthorized = (
          isWriteStage(base)
          && base.status === "interrupted"
          && base.resolution?.outcome === "retry"
          && base.resolution.retryAuthorizedAt
          && !base.resolution.retryConsumedAt
        );
        if (base.attempts >= maxAttempts && !crashRetryAuthorized) {
          throw new Error("pipeline_stage_retry_exhausted");
        }
        if (base.attempts > 0) {
          const consumed = state.budget?.consumed && typeof state.budget.consumed === "object"
            ? state.budget.consumed
            : {};
          const repairCycles = Number(consumed.repairCycles ?? 0);
          const maxRepairCycles = state.budget?.limits?.maxRepairCycles;
          if (!Number.isSafeInteger(repairCycles) || repairCycles < 0) {
            throw new Error("pipeline_budget_usage_invalid");
          }
          if (Number.isFinite(maxRepairCycles) && repairCycles >= maxRepairCycles) {
            throw new Error("pipeline_budget_exhausted");
          }
          const nextRepairCycles = repairCycles + 1;
          const repairBudgetExhausted = Number.isFinite(maxRepairCycles) && nextRepairCycles >= maxRepairCycles;
          state.budget = {
            ...state.budget,
            consumed: { ...consumed, repairCycles: nextRepairCycles },
            exhausted: state.budget?.exhausted === true || repairBudgetExhausted,
            ...(repairBudgetExhausted ? { exhaustedAt: state.budget?.exhaustedAt ?? at } : {}),
          };
        }
        if (crashRetryAuthorized) {
          base = {
            ...base,
            resolution: { ...base.resolution, retryConsumedAt: at },
          };
          state.stages[index] = base;
        }
      }
      let workspaceDigestBefore = base.workspaceDigestBefore;
      if (isWriteStage(base) && status === "running" && base.status !== "running") {
        workspaceDigestBefore = update.workspaceDigestBefore ?? workspaceDigestBefore;
        if (typeof workspaceDigestBefore !== "string" || !/^[a-f0-9]{64}$/.test(workspaceDigestBefore)) {
          throw new Error("pipeline_workspace_baseline_required");
        }
        if (workspaceDigestBefore !== state.workspaceCheckpointDigest) {
          throw new Error("pipeline_workspace_changed");
        }
      }
      const next = {
        ...base,
        status,
        attempts: base.attempts + (status === "running" && base.status !== "running" ? 1 : 0),
        startedAt: status === "running" ? at : base.startedAt,
        finishedAt: ["completed", "failed", "skipped", "cancelled", "interrupted", "uncertain"].includes(status) ? at : null,
        executionClaimId: executionClaimId ?? base.executionClaimId ?? null,
        uncertain: status === "uncertain" ? true : base.uncertain,
        workspaceDigestBefore,
        output: update.output !== undefined ? publicValue(update.output, sensitive) : base.output,
        error: update.error !== undefined ? publicValue(update.error, sensitive) : base.error,
        metadata: update.metadata && typeof update.metadata === "object"
          ? publicValue({ ...base.metadata, ...update.metadata }, sensitive)
          : base.metadata,
      };
      state.stages[index] = next;
      if (isWriteStage(current) && current.status === "running" && status === "completed") {
        const digest = actionReceipt?.workspaceDigest;
        const observedAt = iso(actionReceipt?.observedAt, "");
        if (
          typeof digest !== "string"
          || !/^[a-f0-9]{64}$/.test(digest)
          || !observedAt
          || actionReceipt?.workspaceDigestBefore !== workspaceDigestBefore
        ) {
          throw new Error("pipeline_action_receipt_invalid");
        }
        state.workspaceCheckpointDigest = digest;
        state.workspaceCheckpointObservedAt = observedAt;
        state.stages[index].actionReceipt = actionReceipt;
        state.stages[index].actionReceiptDigest = digestValue(actionReceipt);
      }
      if (current.kind === "truth-gate" && status === "completed") {
        const digest = truthGateReceipt?.workspaceDigest;
        const observedAt = iso(truthGateReceipt?.observedAt, "");
        const expectedActionDigests = upstreamActionReceiptDigests(state, current);
        const receiptActionDigests = Array.isArray(truthGateReceipt?.actionReceiptDigests)
          ? [...truthGateReceipt.actionReceiptDigests].map((value) => String(value).toLowerCase()).sort()
          : [];
        if (
          typeof digest !== "string"
          || !/^[a-f0-9]{64}$/.test(digest)
          || !observedAt
          || expectedActionDigests.length === 0
          || !validReceiptDigestList(truthGateReceipt?.actionReceiptDigests)
          || !sameDigestSet(expectedActionDigests, receiptActionDigests)
        ) {
          throw new Error("pipeline_truth_gate_receipt_invalid");
        }
        state.workspaceCheckpointDigest = digest;
        state.workspaceCheckpointObservedAt = observedAt;
        state.stages[index].truthGateReceipt = truthGateReceipt;
        state.stages[index].truthGateReceiptDigest = digestValue(truthGateReceipt);
      }
      return state;
    }, {
      stageId: id,
      status: update.status,
      ...(update.actionReceipt && typeof update.actionReceipt === "object"
        ? { actionReceiptDigest: digestValue(update.actionReceipt) }
        : {}),
      ...(update.truthGateReceipt && typeof update.truthGateReceipt === "object"
        ? { truthGateReceiptDigest: digestValue(update.truthGateReceipt) }
        : {}),
      ...(update.resolutionMarker && typeof update.resolutionMarker === "object"
        ? { resolutionReceiptDigest: digestValue(update.resolutionMarker) }
        : {}),
    });
  }

  async claimStage(runId, stageId, { expectedStatus = "pending", workspaceDigestBefore } = {}) {
    if (!STAGE_STATUSES.has(expectedStatus)) throw new Error("pipeline_stage_status_invalid");
    const executionClaimId = randomUUID();
    const run = await this.updateStage(runId, stageId, {
      status: "running",
      expectedStatus,
      executionClaimId,
      ...(workspaceDigestBefore !== undefined ? { workspaceDigestBefore } : {}),
    });
    const stage = run.stages.find((candidate) => candidate.id === stageId);
    return {
      run,
      executionClaimId,
      claimed: stage?.status === "running" && stage.executionClaimId === executionClaimId,
    };
  }

  recordArtifact(runId, artifact = {}) {
    return this._mutate(runId, "artifact.recorded", async (state, _at, sensitive) => {
      if (state.artifacts.length >= MAX_RUN_ARTIFACTS) throw new Error("pipeline_artifact_limit");
      const stageId = safeId(artifact.stageId, "artifact_stage_id", 160);
      const stageIndex = state.stages.findIndex((stage) => stage.id === stageId);
      if (stageIndex < 0) throw new Error("pipeline_stage_not_found");
      const record = await canonicalArtifactEnvelope(artifact, {
        runId: state.runId,
        stage: state.stages[stageIndex],
        sensitiveValues: sensitive,
      });
      if (state.artifacts.some((item) => item.id === record.id)) throw new Error("pipeline_artifact_exists");
      state.artifacts.push(record);
      state.stages[stageIndex].artifactIds.push(record.id);
      return state;
    }, { stageId: artifact.stageId });
  }

  /**
   * Charge a failed department and close its claimed stage in one mutation.
   * A provider failure is still real budget usage, but it must never create a
   * hand-off artifact or turn the failed stage into a successful one.
   */
  failDepartmentWithUsage(runId, stageId, error = {}, budgetUsage = {}, expectedExecutionClaimId = undefined) {
    const id = safeId(stageId, "stage_id", 160);
    return this._mutate(runId, "department.failed", (state, at, sensitive) => {
      if (state.status !== "running") throw new Error("pipeline_stage_run_inactive");
      const stageIndex = state.stages.findIndex((stage) => stage.id === id);
      if (stageIndex < 0) throw new Error("pipeline_stage_not_found");
      const stage = state.stages[stageIndex];
      if (stage.kind !== "department") throw new Error("pipeline_department_stage_required");
      if (stage.status !== "running") throw new Error("pipeline_stage_transition_invalid");
      if (expectedExecutionClaimId !== undefined && stage.executionClaimId !== expectedExecutionClaimId) {
        throw new Error("pipeline_stage_claim_lost");
      }
      applyBudgetDelta(state, budgetUsage, at);
      state.stages[stageIndex] = {
        ...stage,
        status: "failed",
        error: publicValue(error, sensitive),
        finishedAt: at,
      };
      return state;
    }, {
      stageId: id,
      budgetCharged: true,
    });
  }

  /**
   * Persist a department hand-off and its completed stage in one journal
   * mutation. A pause/cancel cannot otherwise land between recordArtifact()
   * and updateStage(), leaving a stale result eligible for a later retry.
   */
  completeDepartmentWithArtifact(runId, stageId, artifact = {}, budgetUsage = undefined, expectedExecutionClaimId = undefined) {
    const id = safeId(stageId, "stage_id", 160);
    return this._mutate(runId, "department.completed", async (state, at, sensitive) => {
      if (state.status !== "running") throw new Error("pipeline_stage_run_inactive");
      const stageIndex = state.stages.findIndex((stage) => stage.id === id);
      if (stageIndex < 0) throw new Error("pipeline_stage_not_found");
      const stage = state.stages[stageIndex];
      if (stage.kind !== "department") throw new Error("pipeline_department_stage_required");
      if (stage.status !== "running") throw new Error("pipeline_stage_transition_invalid");
      if (expectedExecutionClaimId !== undefined && stage.executionClaimId !== expectedExecutionClaimId) {
        throw new Error("pipeline_stage_claim_lost");
      }
      if (stage.artifactIds.length > 0) throw new Error("pipeline_department_artifact_exists");
      if (state.artifacts.length >= MAX_RUN_ARTIFACTS) throw new Error("pipeline_artifact_limit");
      const record = await canonicalArtifactEnvelope(artifact, {
        runId: state.runId,
        stage,
        sensitiveValues: sensitive,
      });
      if (state.artifacts.some((item) => item.id === record.id)) throw new Error("pipeline_artifact_exists");
      if (budgetUsage !== undefined) {
        applyBudgetDelta(state, budgetUsage, at);
      }
      state.artifacts.push(record);
      state.stages[stageIndex] = {
        ...stage,
        status: "completed",
        artifactIds: [...stage.artifactIds, record.id],
        finishedAt: at,
      };
      return state;
    }, {
      stageId: id,
      artifactId: typeof artifact?.id === "string" ? artifact.id : undefined,
      ...(budgetUsage !== undefined ? { budgetCharged: true } : {}),
    });
  }

  updateBudget(runId, patch = {}) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("pipeline_budget_invalid");
    if (Object.keys(patch).some((key) => !["consumed", "unmeteredCalls"].includes(key))) {
      throw new Error("pipeline_budget_limits_immutable");
    }
    return this._mutate(runId, "budget.updated", (state, at) => {
      const integerFields = [
        "inputTokens",
        "outputTokens",
        "totalTokens",
        "calls",
        "wallTimeMs",
        "repairCycles",
        "assistanceRequests",
      ];
      const fields = [...integerFields, "costUsd"];
      const previous = state.budget?.consumed
        && typeof state.budget.consumed === "object"
        && !Array.isArray(state.budget.consumed)
        ? state.budget.consumed
        : {};
      if (
        patch.consumed !== undefined
        && (!patch.consumed || typeof patch.consumed !== "object" || Array.isArray(patch.consumed))
      ) {
        throw new Error("pipeline_budget_usage_invalid");
      }
      const supplied = patch.consumed ?? {};
      if (Object.keys(supplied).some((field) => !fields.includes(field))) {
        throw new Error("pipeline_budget_usage_invalid");
      }
      const consumed = { ...previous };
      for (const field of fields) {
        if (!Object.hasOwn(supplied, field)) continue;
        const value = supplied[field];
        const prior = Number(previous[field] ?? 0);
        if (
          !Number.isFinite(value)
          || value < prior
          || value < 0
          || (integerFields.includes(field) && !Number.isSafeInteger(value))
        ) {
          throw new Error(
            Number.isFinite(value) && value >= 0 && value < prior
              ? "pipeline_budget_non_monotonic"
              : "pipeline_budget_usage_invalid",
          );
        }
        consumed[field] = value;
      }
      if (
        Object.hasOwn(consumed, "totalTokens")
        && Number(consumed.totalTokens) < Number(consumed.inputTokens ?? 0) + Number(consumed.outputTokens ?? 0)
      ) {
        throw new Error("pipeline_budget_total_invalid");
      }
      const unmeteredCalls = patch.unmeteredCalls ?? state.budget?.unmeteredCalls ?? 0;
      if (!Number.isSafeInteger(unmeteredCalls) || unmeteredCalls < 0) {
        throw new Error("pipeline_budget_usage_invalid");
      }
      if (unmeteredCalls < Number(state.budget?.unmeteredCalls ?? 0)) {
        throw new Error("pipeline_budget_non_monotonic");
      }
      const limits = state.budget?.limits ?? {};
      const usage = {
        inputTokens: Number(consumed.inputTokens ?? 0),
        outputTokens: Number(consumed.outputTokens ?? 0),
        totalTokens: Object.hasOwn(consumed, "totalTokens")
          ? Number(consumed.totalTokens)
          : Number(consumed.inputTokens ?? 0) + Number(consumed.outputTokens ?? 0),
        calls: Number(consumed.calls ?? 0) + unmeteredCalls,
        wallTimeMs: Number(consumed.wallTimeMs ?? 0),
        repairCycles: Number(consumed.repairCycles ?? 0),
        assistanceRequests: Number(consumed.assistanceRequests ?? 0),
        costUsd: Number(consumed.costUsd ?? 0),
      };
      const limitByField = {
        inputTokens: limits.maxInputTokens,
        outputTokens: limits.maxOutputTokens,
        totalTokens: limits.maxTotalTokens,
        calls: limits.maxCalls,
        wallTimeMs: limits.maxWallTimeMs,
        repairCycles: limits.maxRepairCycles,
        assistanceRequests: limits.maxAssistanceRequests,
        costUsd: limits.maxCostUsd,
      };
      const overage = {};
      let exhausted = false;
      let overdrawn = false;
      for (const [field, used] of Object.entries(usage)) {
        const limit = limitByField[field];
        if (!Number.isFinite(limit)) continue;
        if (used >= limit) exhausted = true;
        if (used > limit) {
          overdrawn = true;
          overage[field] = used - limit;
        }
      }
      exhausted ||= state.budget?.exhausted === true;
      overdrawn ||= state.budget?.overdrawn === true;
      state.budget = {
        ...state.budget,
        consumed,
        unmeteredCalls,
        exhausted,
        overdrawn,
        overage,
        ...(exhausted ? { exhaustedAt: state.budget?.exhaustedAt ?? at } : {}),
        ...(overdrawn ? { overdrawnAt: state.budget?.overdrawnAt ?? at } : {}),
      };
      return state;
    });
  }

  recordApproval(runId, approval = {}) {
    return this._mutate(runId, "approval.recorded", (state, at, sensitive) => {
      const status = String(approval.status ?? "requested");
      if (!new Set(["requested", "approved", "rejected", "cancelled", "expired"]).has(status)) throw new Error("pipeline_approval_status_invalid");
      const id = optionalId(approval.id, "approval_id", 200) || randomUUID();
      if (state.approvals.some((item) => item.id === id && item.status === status)) return state;
      if (state.approvals.length >= MAX_RUN_APPROVALS) throw new Error("pipeline_approval_limit");
      if (!["running", "paused", "awaiting_approval"].includes(state.status)) {
        throw new Error("pipeline_approval_transition_invalid");
      }
      const stageId = safeId(approval.stageId, "approval_stage_id", 160);
      const stageIndex = state.stages.findIndex((stage) => stage.id === stageId);
      const stage = state.stages[stageIndex];
      if (!stage || stage.kind !== "approval") throw new Error("pipeline_approval_stage_invalid");
      const dependenciesReady = stage.dependsOn.every((dependencyId) => {
        const dependency = state.stages.find((candidate) => candidate.id === dependencyId);
        return dependency?.status === "completed";
      });
      if (!dependenciesReady) throw new Error("pipeline_approval_dependencies_incomplete");
      const decided = state.approvals.some((item) => (
        item.stageId === stageId && ["approved", "rejected", "cancelled", "expired"].includes(item.status)
      ));
      if (decided || !["pending", "awaiting_approval"].includes(stage.status)) {
        throw new Error("pipeline_approval_transition_invalid");
      }
      if (status === "requested") {
        if (stage.status !== "pending" || state.approvals.some((item) => item.stageId === stageId && item.status === "requested")) {
          throw new Error("pipeline_approval_transition_invalid");
        }
        stage.status = "awaiting_approval";
        stage.attempts += 1;
        stage.startedAt = at;
      } else {
        stage.status = status === "approved" ? "completed" : status === "rejected" ? "failed" : "cancelled";
        stage.startedAt ??= at;
        stage.attempts = Math.max(1, stage.attempts);
        stage.finishedAt = at;
      }
      const record = {
        id,
        stageId,
        kind: optionalId(approval.kind, "approval_kind", 120) || "stage",
        status,
        actor: publicText(approval.actor, sensitive, 500),
        reason: publicText(approval.reason, sensitive, 8_000),
        evidence: publicValue(Array.isArray(approval.evidence) ? approval.evidence : [], sensitive),
        metadata: publicValue(approval.metadata && typeof approval.metadata === "object" ? approval.metadata : {}, sensitive),
        createdAt: iso(approval.createdAt, at),
        recordedAt: at,
      };
      state.approvals.push(record);
      return state;
    }, { status: approval.status ?? "requested" });
  }

  async recoverInterrupted() {
    const recovered = [];
    for (const run of await this.list()) {
      if (TERMINAL_RUN_STATUSES.has(run.status)) continue;
      const hasActiveStage = run.stages.some((stage) => stage.status === "running");
      if (run.status !== "running" && !hasActiveStage) continue;
      await this._mutate(run.runId, "run.interrupted", (state, at) => {
        const activeAtCommit = state.stages.some((stage) => stage.status === "running");
        if (TERMINAL_RUN_STATUSES.has(state.status) || (state.status !== "running" && !activeAtCommit)) {
          return state;
        }
        const previousStatus = state.status;
        state.status = "interrupted";
        state.finishedAt = null;
        state.interruption = { reason: "gateway_restart", previousStatus, at };
        state.lastTransition = {
          status: "interrupted",
          at,
          details: { reason: "gateway_restart", previousStatus },
        };
        state.stages = state.stages.map((stage) => stage.status !== "running" ? stage : {
          ...stage,
          status: isWriteStage(stage) ? "uncertain" : "interrupted",
          uncertain: isWriteStage(stage),
          finishedAt: at,
        });
        return state;
      }, { reason: "gateway_restart" });
      recovered.push(run.runId);
    }
    return recovered.sort();
  }

  async readJournal(runId, options = {}) {
    const id = safeId(runId, "run_id");
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new Error("pipeline_journal_page_invalid");
    }
    const afterSequence = options.afterSequence ?? 0;
    const limit = options.limit ?? JOURNAL_DEFAULT_LIMIT;
    if (
      !Number.isSafeInteger(afterSequence)
      || afterSequence < 0
      || !Number.isSafeInteger(limit)
      || limit < 1
      || limit > JOURNAL_MAX_LIMIT
    ) throw new Error("pipeline_journal_page_invalid");
    await (this.tails.get(id) ?? Promise.resolve());
    const path = this.journalPathFor(id);
    const missingJournal = async () => {
      try {
        const snapshot = JSON.parse(await readFile(this.pathFor(id), "utf8"));
        if (validSnapshot(snapshot, id) && snapshot.journalVersion === JOURNAL_EVENT_VERSION) {
          throw new Error("pipeline_run_state_corrupt");
        }
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        if (error instanceof SyntaxError) throw new Error("pipeline_run_state_corrupt");
        throw error;
      }
      return [];
    };
    let head = null;
    try {
      head = JSON.parse(await readFile(this.headPathFor(id), "utf8"));
      if (!validJournalHeadShape(head, id)) throw new Error("pipeline_run_state_corrupt");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        if (error instanceof SyntaxError) throw new Error("pipeline_run_state_corrupt");
        throw error;
      }
    }
    let endsWithNewline;
    try {
      endsWithNewline = await fileEndsWithNewline(path, head?.journalBytes ?? null);
    } catch (error) {
      if (error?.code === "ENOENT" && !head) return missingJournal();
      if (error?.code === "ENOENT") throw new Error("pipeline_run_state_corrupt");
      throw error;
    }

    const stream = createReadStream(path, {
      encoding: "utf8",
      ...(head ? { end: head.journalBytes - 1 } : {}),
    });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const events = [];
    let expectedSequence = 1;
    let malformedTail = false;
    let pageLimitReached = false;
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        if (malformedTail) throw new Error("pipeline_run_state_corrupt");
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          malformedTail = true;
          continue;
        }
        validateJournalRow(row, id, Buffer.byteLength(line));
        if (row.sequence !== expectedSequence) throw new Error("pipeline_run_state_corrupt");
        expectedSequence += 1;
        if (row.sequence <= afterSequence) continue;
        events.push(publicJournalEvent(row));
        if (events.length >= limit) {
          pageLimitReached = true;
          break;
        }
      }
      if (malformedTail && endsWithNewline) throw new Error("pipeline_run_state_corrupt");
      if (!pageLimitReached && head && expectedSequence - 1 !== head.sequence) {
        throw new Error("pipeline_run_state_corrupt");
      }
      if (events.length) {
        const last = events.at(-1);
        last.page = {
          hasMore: head ? last.sequence < head.sequence : pageLimitReached,
          nextAfterSequence: last.sequence,
          limit,
        };
      }
      return events;
    } catch (error) {
      if (error?.code === "ENOENT" && !head) return missingJournal();
      if (error?.code === "ENOENT") throw new Error("pipeline_run_state_corrupt");
      throw error;
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  async flush() {
    await Promise.all([...this.tails.values()]);
  }
}

export { SCHEMA_VERSION as PIPELINE_RUN_SCHEMA_VERSION };
