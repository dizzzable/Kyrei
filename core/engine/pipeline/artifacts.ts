import { createHash } from "node:crypto";
import type {
  ArtifactCheck,
  ArtifactClaim,
  ArtifactContradiction,
  ArtifactEnvelope,
  EvidenceRef,
} from "./types.js";

export type ArtifactValidationIssueCode =
  | "invalid_schema_version"
  | "invalid_timestamp"
  | "invalid_evidence"
  | "invalid_digest"
  | "invalid_check_status"
  | "invalid_artifact_kind"
  | "invalid_metric"
  | "invalid_structure"
  | "unknown_field"
  | "artifact_too_large"
  | "collection_too_large"
  | "field_too_large"
  | "blank_field"
  | "duplicate_claim_id"
  | "duplicate_evidence_id"
  | "duplicate_check_id"
  | "duplicate_contradiction_id"
  | "dangling_evidence_ref"
  | "dangling_claim_ref"
  | "invalid_contradiction";

export interface ArtifactValidationIssue {
  readonly code: ArtifactValidationIssueCode;
  readonly field: string;
  readonly id?: string;
  readonly referencedId?: string;
}

export interface ArtifactValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ArtifactValidationIssue[];
}

export class ArtifactValidationError extends Error {
  readonly issues: readonly ArtifactValidationIssue[];

  constructor(issues: readonly ArtifactValidationIssue[]) {
    super(`Invalid artifact envelope (${issues.length} issue${issues.length === 1 ? "" : "s"})`);
    this.name = "ArtifactValidationError";
    this.issues = issues;
  }
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_COLLECTION_ITEMS = 2_000;
const MAX_REFERENCES_PER_ITEM = 2_000;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_TEXT_LENGTH = 1_000_000;
const MAX_ARTIFACT_SERIALIZED_BYTES = 512 * 1_024;
const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_NODES = 20_000;

const ARTIFACT_KINDS = new Set([
  "department",
  "action",
  "verification",
  "improvement",
  "assistance",
]);
const ROOT_KEYS = new Set([
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
const CLAIM_KEYS = new Set(["id", "statement", "evidenceIds"]);
const CHECK_KEYS = new Set(["id", "status", "evidenceIds", "workspaceDigest", "testDigest"]);
const CONTRADICTION_KEYS = new Set(["id", "claimIds", "summary", "resolved", "resolution"]);
const PROVENANCE_KEYS = new Set(["providerId", "modelId", "policyDigest"]);
const METRIC_KEYS = new Set([
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "providerCalls",
  "durationMs",
]);
const EVIDENCE_BASE_KEYS = ["id", "kind", "origin", "summary", "capturedAt", "workspaceDigest"];
const EVIDENCE_KEYS = new Map<string, ReadonlySet<string>>([
  ["file", new Set([...EVIDENCE_BASE_KEYS, "path", "contentDigest"])],
  ["command", new Set([...EVIDENCE_BASE_KEYS, "commandLabel", "exitCode", "outputDigest"])],
  ["test", new Set([
    ...EVIDENCE_BASE_KEYS,
    "checkId",
    "command",
    "cwd",
    "exitCode",
    "passed",
    "testDigest",
    "outputDigest",
  ])],
  ["diagnostic", new Set([...EVIDENCE_BASE_KEYS, "tool", "outputDigest"])],
  ["url", new Set([...EVIDENCE_BASE_KEYS, "url", "contentDigest"])],
  ["artifact", new Set([...EVIDENCE_BASE_KEYS, "artifactId", "artifactDigest"])],
]);

type JsonRecord = Record<string, unknown>;

interface IndexedRecord {
  readonly index: number;
  readonly value: JsonRecord;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function recordId(value: JsonRecord): string {
  return typeof value.id === "string" ? value.id : "";
}

function validateText(
  value: unknown,
  field: string,
  issues: ArtifactValidationIssue[],
  id?: string,
  maximumLength = MAX_TEXT_LENGTH,
): value is string {
  if (!hasText(value)) {
    issues.push({ code: "blank_field", field, ...(id ? { id } : {}) });
    return false;
  }
  if (value.length > maximumLength) {
    issues.push({ code: "field_too_large", field, ...(id ? { id } : {}) });
    return false;
  }
  return true;
}

function validateDigest(
  value: unknown,
  field: string,
  issues: ArtifactValidationIssue[],
  id?: string,
): value is string {
  if (validDigest(value)) return true;
  issues.push({ code: "invalid_digest", field, ...(id ? { id } : {}) });
  return false;
}

function rejectUnknownKeys(
  value: JsonRecord,
  allowed: ReadonlySet<string>,
  prefix: string,
  issues: ArtifactValidationIssue[],
  id?: string,
): void {
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    issues.push({
      code: "unknown_field",
      field: prefix ? `${prefix}.${key}` : key,
      ...(id ? { id } : {}),
    });
  }
}

function readTextCollection(
  value: unknown,
  field: string,
  issues: ArtifactValidationIssue[],
): readonly string[] {
  if (!Array.isArray(value)) {
    issues.push({ code: "invalid_structure", field });
    return [];
  }
  if (value.length > MAX_COLLECTION_ITEMS) {
    issues.push({ code: "collection_too_large", field });
  }
  const result: string[] = [];
  for (const [index, item] of value.slice(0, MAX_COLLECTION_ITEMS).entries()) {
    if (validateText(item, `${field}[${index}]`, issues)) result.push(item);
  }
  return result;
}

function validateNonNegativeInteger(
  value: unknown,
  field: string,
  issues: ArtifactValidationIssue[],
): value is number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return true;
  issues.push({ code: "invalid_metric", field });
  return false;
}

function readCollection(
  artifact: JsonRecord,
  field: string,
  issues: ArtifactValidationIssue[],
): readonly IndexedRecord[] {
  const value = artifact[field];
  if (!Array.isArray(value)) {
    issues.push({ code: "invalid_structure", field });
    return [];
  }
  if (value.length > MAX_COLLECTION_ITEMS) {
    issues.push({ code: "collection_too_large", field });
  }
  const records: IndexedRecord[] = [];
  for (const [index, item] of value.slice(0, MAX_COLLECTION_ITEMS).entries()) {
    if (!isRecord(item)) {
      issues.push({ code: "invalid_structure", field: `${field}[${index}]` });
      continue;
    }
    records.push({ index, value: item });
  }
  return records;
}

function readReferences(
  value: unknown,
  field: string,
  id: string,
  issues: ArtifactValidationIssue[],
): readonly string[] {
  if (!Array.isArray(value)) {
    issues.push({ code: "invalid_structure", field, ...(id ? { id } : {}) });
    return [];
  }
  if (value.length > MAX_REFERENCES_PER_ITEM) {
    issues.push({ code: "collection_too_large", field, ...(id ? { id } : {}) });
  }
  const references: string[] = [];
  for (const reference of value.slice(0, MAX_REFERENCES_PER_ITEM)) {
    if (!hasText(reference) || reference.length > MAX_IDENTIFIER_LENGTH) {
      issues.push({ code: "blank_field", field, ...(id ? { id } : {}) });
      continue;
    }
    references.push(reference);
  }
  return references;
}

function invalidEvidence(issues: ArtifactValidationIssue[], id: string, field: string): void {
  issues.push({ code: "invalid_evidence", field, ...(id ? { id } : {}) });
}

function collectDuplicates(
  values: readonly IndexedRecord[],
  code:
    | "duplicate_claim_id"
    | "duplicate_evidence_id"
    | "duplicate_check_id"
    | "duplicate_contradiction_id",
  field: string,
  issues: ArtifactValidationIssue[],
): Set<string> {
  const ids = new Set<string>();
  const reported = new Set<string>();
  for (const { value } of values) {
    if (!validateText(value.id, `${field}.id`, issues, undefined, MAX_IDENTIFIER_LENGTH)) {
      continue;
    }
    if (ids.has(value.id) && !reported.has(value.id)) {
      issues.push({ code, field, id: value.id });
      reported.add(value.id);
    }
    ids.add(value.id);
  }
  return ids;
}

/**
 * Validate untrusted JSON without assuming its TypeScript shape. Every path is
 * bounded, so malformed or oversized arrays are rejected rather than walked
 * indefinitely.
 */
export function validateArtifactEnvelope(artifact: unknown): ArtifactValidationResult {
  const issues: ArtifactValidationIssue[] = [];
  if (!isRecord(artifact)) {
    return {
      valid: false,
      issues: [{ code: "invalid_structure", field: "artifact" }],
    };
  }

  let serialized: string;
  try {
    const value = JSON.stringify(artifact);
    if (typeof value !== "string") throw new TypeError("not JSON serializable");
    serialized = value;
  } catch {
    return {
      valid: false,
      issues: [{ code: "invalid_structure", field: "artifact.serialized" }],
    };
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_ARTIFACT_SERIALIZED_BYTES) {
    return {
      valid: false,
      issues: [{ code: "artifact_too_large", field: "artifact" }],
    };
  }

  rejectUnknownKeys(artifact, ROOT_KEYS, "", issues);

  if (artifact.schemaVersion !== 1) {
    issues.push({ code: "invalid_schema_version", field: "schemaVersion" });
  }

  const artifactId = typeof artifact.id === "string" ? artifact.id : undefined;
  if (!validTimestamp(artifact.createdAt)) {
    issues.push({
      code: "invalid_timestamp",
      field: "createdAt",
      ...(artifactId ? { id: artifactId } : {}),
    });
  }
  for (const field of ["id", "runId", "stageId", "producerId"] as const) {
    validateText(artifact[field], field, issues, undefined, MAX_IDENTIFIER_LENGTH);
  }
  if (typeof artifact.kind !== "string" || !ARTIFACT_KINDS.has(artifact.kind)) {
    issues.push({ code: "invalid_artifact_kind", field: "kind" });
  }
  validateText(artifact.createdAt, "createdAt", issues);
  validateText(artifact.summary, "summary", issues);
  validateDigest(artifact.workspaceDigest, "workspaceDigest", issues, artifactId);
  const inputDigests = readTextCollection(artifact.inputDigests, "inputDigests", issues);
  for (const [index, value] of inputDigests.entries()) {
    validateDigest(value, `inputDigests[${index}]`, issues, artifactId);
  }
  readTextCollection(artifact.assumptions, "assumptions", issues);
  readTextCollection(artifact.uncertainties, "uncertainties", issues);
  readTextCollection(artifact.unchecked, "unchecked", issues);

  if (!isRecord(artifact.provenance)) {
    issues.push({ code: "invalid_structure", field: "provenance" });
  } else {
    rejectUnknownKeys(artifact.provenance, PROVENANCE_KEYS, "provenance", issues);
    validateText(artifact.provenance.providerId, "provenance.providerId", issues, undefined, MAX_IDENTIFIER_LENGTH);
    validateText(artifact.provenance.modelId, "provenance.modelId", issues, undefined, MAX_IDENTIFIER_LENGTH);
    validateDigest(artifact.provenance.policyDigest, "provenance.policyDigest", issues, artifactId);
  }

  if (!isRecord(artifact.metrics)) {
    issues.push({ code: "invalid_structure", field: "metrics" });
  } else {
    rejectUnknownKeys(artifact.metrics, METRIC_KEYS, "metrics", issues);
    const inputTokens = artifact.metrics.inputTokens;
    const outputTokens = artifact.metrics.outputTokens;
    const totalTokens = artifact.metrics.totalTokens;
    const inputTokensValid = validateNonNegativeInteger(
      inputTokens,
      "metrics.inputTokens",
      issues,
    );
    const outputTokensValid = validateNonNegativeInteger(
      outputTokens,
      "metrics.outputTokens",
      issues,
    );
    const totalTokensValid = validateNonNegativeInteger(
      totalTokens,
      "metrics.totalTokens",
      issues,
    );
    validateNonNegativeInteger(artifact.metrics.providerCalls, "metrics.providerCalls", issues);
    validateNonNegativeInteger(artifact.metrics.durationMs, "metrics.durationMs", issues);
    if (
      inputTokensValid
      && outputTokensValid
      && totalTokensValid
      && totalTokens !== inputTokens + outputTokens
    ) {
      issues.push({ code: "invalid_metric", field: "metrics.totalTokens" });
    }
  }

  const claims = readCollection(artifact, "claims", issues);
  const evidence = readCollection(artifact, "evidence", issues);
  const checks = readCollection(artifact, "checks", issues);
  const contradictions = readCollection(artifact, "contradictions", issues);

  const claimIds = collectDuplicates(claims, "duplicate_claim_id", "claims", issues);
  const evidenceIds = collectDuplicates(evidence, "duplicate_evidence_id", "evidence", issues);
  collectDuplicates(checks, "duplicate_check_id", "checks", issues);
  collectDuplicates(
    contradictions,
    "duplicate_contradiction_id",
    "contradictions",
    issues,
  );

  for (const { index, value } of evidence) {
    const id = recordId(value);
    rejectUnknownKeys(
      value,
      EVIDENCE_KEYS.get(typeof value.kind === "string" ? value.kind : "") ?? new Set(EVIDENCE_BASE_KEYS),
      `evidence[${index}]`,
      issues,
      id,
    );
    validateText(value.summary, "evidence.summary", issues, id);
    if (!validTimestamp(value.capturedAt)) {
      invalidEvidence(issues, id, "evidence.capturedAt");
    }
    if (value.origin !== "observed" && value.origin !== "reported") {
      invalidEvidence(issues, id, "evidence.origin");
    }
    if (value.workspaceDigest !== undefined) {
      validateDigest(value.workspaceDigest, "evidence.workspaceDigest", issues, id);
    }
    if (value.origin === "observed" && value.kind !== "url" && value.workspaceDigest === undefined) {
      validateDigest(value.workspaceDigest, "evidence.workspaceDigest", issues, id);
    }

    switch (value.kind) {
      case "file":
        validateText(value.path, "evidence.file.path", issues, id);
        validateDigest(value.contentDigest, "evidence.file.contentDigest", issues, id);
        break;
      case "command":
        validateText(value.commandLabel, "evidence.command.commandLabel", issues, id);
        if (!Number.isSafeInteger(value.exitCode)) {
          invalidEvidence(issues, id, "evidence.command.exitCode");
        }
        validateDigest(value.outputDigest, "evidence.command.outputDigest", issues, id);
        break;
      case "test":
        validateText(value.checkId, "evidence.test.checkId", issues, id, MAX_IDENTIFIER_LENGTH);
        validateText(value.command, "evidence.test.command", issues, id);
        validateText(value.cwd, "evidence.test.cwd", issues, id);
        if (!Number.isSafeInteger(value.exitCode)) {
          invalidEvidence(issues, id, "evidence.test.exitCode");
        }
        if (typeof value.passed !== "boolean") {
          invalidEvidence(issues, id, "evidence.test.passed");
        }
        validateDigest(value.testDigest, "evidence.test.testDigest", issues, id);
        validateDigest(value.outputDigest, "evidence.test.outputDigest", issues, id);
        if (value.workspaceDigest === undefined && value.origin !== "observed") {
          validateDigest(value.workspaceDigest, "evidence.test.workspaceDigest", issues, id);
        }
        break;
      case "diagnostic":
        validateText(value.tool, "evidence.diagnostic.tool", issues, id);
        validateDigest(value.outputDigest, "evidence.diagnostic.outputDigest", issues, id);
        break;
      case "url":
        if (validateText(value.url, "evidence.url.url", issues, id)) {
          try {
            const url = new URL(value.url);
            if (url.protocol !== "http:" && url.protocol !== "https:") {
              invalidEvidence(issues, id, "evidence.url");
            }
          } catch {
            invalidEvidence(issues, id, "evidence.url");
          }
        }
        if (value.contentDigest !== undefined) {
          validateDigest(value.contentDigest, "evidence.url.contentDigest", issues, id);
        }
        break;
      case "artifact":
        validateText(value.artifactId, "evidence.artifact.artifactId", issues, id, MAX_IDENTIFIER_LENGTH);
        validateDigest(value.artifactDigest, "evidence.artifact.artifactDigest", issues, id);
        break;
      default:
        invalidEvidence(issues, id, "evidence.kind");
    }
  }

  for (const { index, value } of claims) {
    const id = recordId(value);
    rejectUnknownKeys(value, CLAIM_KEYS, `claims[${index}]`, issues, id);
    validateText(value.statement, "claims.statement", issues, id);
    for (const evidenceId of readReferences(value.evidenceIds, "claims.evidenceIds", id, issues)) {
      if (!evidenceIds.has(evidenceId)) {
        issues.push({
          code: "dangling_evidence_ref",
          field: "claims.evidenceIds",
          ...(id ? { id } : {}),
          referencedId: evidenceId,
        });
      }
    }
  }

  for (const { index, value } of checks) {
    const id = recordId(value);
    rejectUnknownKeys(value, CHECK_KEYS, `checks[${index}]`, issues, id);
    if (value.status !== "passed" && value.status !== "failed" && value.status !== "not_run") {
      issues.push({ code: "invalid_check_status", field: "checks.status", ...(id ? { id } : {}) });
    }
    validateDigest(value.workspaceDigest, "checks.workspaceDigest", issues, id);
    if (value.testDigest !== undefined) {
      validateDigest(value.testDigest, "checks.testDigest", issues, id);
    }
    for (const evidenceId of readReferences(value.evidenceIds, "checks.evidenceIds", id, issues)) {
      if (!evidenceIds.has(evidenceId)) {
        issues.push({
          code: "dangling_evidence_ref",
          field: "checks.evidenceIds",
          ...(id ? { id } : {}),
          referencedId: evidenceId,
        });
      }
    }
  }

  for (const { index, value } of contradictions) {
    const id = recordId(value);
    rejectUnknownKeys(value, CONTRADICTION_KEYS, `contradictions[${index}]`, issues, id);
    const referencedClaims = readReferences(
      value.claimIds,
      "contradictions.claimIds",
      id,
      issues,
    );
    validateText(value.summary, "contradictions.summary", issues, id);
    if (typeof value.resolved !== "boolean" || referencedClaims.length < 2) {
      issues.push({
        code: "invalid_contradiction",
        field: typeof value.resolved !== "boolean"
          ? "contradictions.resolved"
          : "contradictions.claimIds",
        ...(id ? { id } : {}),
      });
    }
    if (value.resolved === true && !hasText(value.resolution)) {
      issues.push({
        code: "invalid_contradiction",
        field: "contradictions.resolution",
        ...(id ? { id } : {}),
      });
    }
    for (const claimId of referencedClaims) {
      if (!claimIds.has(claimId)) {
        issues.push({
          code: "dangling_claim_ref",
          field: "contradictions.claimIds",
          ...(id ? { id } : {}),
          referencedId: claimId,
        });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

export function assertValidArtifactEnvelope(
  artifact: unknown,
): asserts artifact is ArtifactEnvelope {
  const validation = validateArtifactEnvelope(artifact);
  if (!validation.valid) throw new ArtifactValidationError(validation.issues);
}

function canonicalJson(
  value: unknown,
  seen: WeakSet<object>,
  state: { nodes: number },
  depth: number,
): string {
  state.nodes += 1;
  if (state.nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) {
    throw new TypeError("Evidence exceeds canonicalization limits");
  }
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Evidence contains a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("Evidence contains a non-JSON value");
  }
  if (seen.has(value)) throw new TypeError("Evidence contains a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_COLLECTION_ITEMS) {
        throw new TypeError("Evidence array exceeds canonicalization limits");
      }
      return `[${value.map((item) => canonicalJson(item, seen, state, depth + 1)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Evidence must contain plain JSON objects");
    }
    const record = value as JsonRecord;
    const keys = Object.keys(record).sort();
    if (keys.length > MAX_COLLECTION_ITEMS) {
      throw new TypeError("Evidence object exceeds canonicalization limits");
    }
    return `{${keys.map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(record[key], seen, state, depth + 1)}`
    )).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** SHA-256 of the complete evidence JSON with recursively sorted object keys. */
export function canonicalEvidenceDigest(evidence: EvidenceRef): string {
  const canonical = canonicalJson(evidence, new WeakSet<object>(), { nodes: 0 }, 0);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function cloneClaim(claim: ArtifactClaim): ArtifactClaim {
  return {
    id: claim.id,
    statement: claim.statement,
    evidenceIds: [...claim.evidenceIds],
  };
}

function cloneEvidence(evidence: EvidenceRef): EvidenceRef {
  const base = {
    id: evidence.id,
    kind: evidence.kind,
    origin: evidence.origin,
    summary: evidence.summary,
    capturedAt: evidence.capturedAt,
    ...(evidence.workspaceDigest !== undefined
      ? { workspaceDigest: evidence.workspaceDigest }
      : {}),
  };
  switch (evidence.kind) {
    case "file":
      return {
        ...base,
        kind: "file",
        path: evidence.path,
        contentDigest: evidence.contentDigest,
      };
    case "command":
      return {
        ...base,
        kind: "command",
        commandLabel: evidence.commandLabel,
        exitCode: evidence.exitCode,
        outputDigest: evidence.outputDigest,
      };
    case "test":
      return {
        ...base,
        kind: "test",
        workspaceDigest: evidence.workspaceDigest,
        checkId: evidence.checkId,
        command: evidence.command,
        cwd: evidence.cwd,
        exitCode: evidence.exitCode,
        passed: evidence.passed,
        testDigest: evidence.testDigest,
        outputDigest: evidence.outputDigest,
      };
    case "diagnostic":
      return {
        ...base,
        kind: "diagnostic",
        tool: evidence.tool,
        outputDigest: evidence.outputDigest,
      };
    case "url":
      return {
        ...base,
        kind: "url",
        url: evidence.url,
        ...(evidence.contentDigest !== undefined
          ? { contentDigest: evidence.contentDigest }
          : {}),
      };
    case "artifact":
      return {
        ...base,
        kind: "artifact",
        artifactId: evidence.artifactId,
        artifactDigest: evidence.artifactDigest,
      };
  }
}

function cloneCheck(check: ArtifactCheck): ArtifactCheck {
  return {
    id: check.id,
    status: check.status,
    evidenceIds: [...check.evidenceIds],
    workspaceDigest: check.workspaceDigest,
    ...(check.testDigest !== undefined ? { testDigest: check.testDigest } : {}),
  };
}

function cloneContradiction(contradiction: ArtifactContradiction): ArtifactContradiction {
  return {
    id: contradiction.id,
    claimIds: [...contradiction.claimIds],
    summary: contradiction.summary,
    resolved: contradiction.resolved,
    ...(contradiction.resolution !== undefined
      ? { resolution: contradiction.resolution }
      : {}),
  };
}

/** Defensive-copy and validate an artifact at a department boundary. */
export function createArtifactEnvelope(artifact: unknown): ArtifactEnvelope {
  assertValidArtifactEnvelope(artifact);
  return {
    schemaVersion: 1,
    id: artifact.id,
    kind: artifact.kind,
    runId: artifact.runId,
    stageId: artifact.stageId,
    producerId: artifact.producerId,
    createdAt: artifact.createdAt,
    summary: artifact.summary,
    workspaceDigest: artifact.workspaceDigest,
    inputDigests: [...artifact.inputDigests],
    assumptions: [...artifact.assumptions],
    uncertainties: [...artifact.uncertainties],
    unchecked: [...artifact.unchecked],
    provenance: {
      providerId: artifact.provenance.providerId,
      modelId: artifact.provenance.modelId,
      policyDigest: artifact.provenance.policyDigest,
    },
    metrics: {
      inputTokens: artifact.metrics.inputTokens,
      outputTokens: artifact.metrics.outputTokens,
      totalTokens: artifact.metrics.totalTokens,
      providerCalls: artifact.metrics.providerCalls,
      durationMs: artifact.metrics.durationMs,
    },
    claims: artifact.claims.map(cloneClaim),
    evidence: artifact.evidence.map(cloneEvidence),
    checks: artifact.checks.map(cloneCheck),
    contradictions: artifact.contradictions.map(cloneContradiction),
  };
}

export function indexEvidence(
  artifact: ArtifactEnvelope,
): ReadonlyMap<string, EvidenceRef> {
  return new Map(artifact.evidence.map((evidence) => [evidence.id, evidence]));
}
