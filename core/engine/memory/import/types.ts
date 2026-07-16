/**
 * Canonical intermediate model for multi-platform conversation import.
 * @see .kiro/specs/session-memory-import/
 */

export const IMPORT_TRANSCRIPT_SCHEMA_VERSION = 1 as const;

export type ImportSourceId =
  | "kyrei"
  | "opencode"
  | "claude-code"
  | "claude-ai"
  | "chatgpt"
  | "cursor"
  | "kiro"
  | "hermes"
  | "aider"
  | "generic"
  | "unknown";

export type ImportMessageRole = "user" | "assistant" | "system" | "tool" | "unknown";

export interface ImportedMessage {
  readonly role: ImportMessageRole;
  /** Plain text only. */
  readonly text: string;
  readonly at?: string;
  readonly parts?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}

export interface ImportedTranscript {
  readonly schemaVersion: typeof IMPORT_TRANSCRIPT_SCHEMA_VERSION;
  readonly source: ImportSourceId;
  readonly sourceId?: string;
  readonly title?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly workspaceHint?: string;
  readonly messages: readonly ImportedMessage[];
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface ImportDetectResult {
  readonly adapterId: string;
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly candidates?: ReadonlyArray<{ adapterId: string; confidence: number }>;
}

export interface ImportOptions {
  readonly adapterId?: string;
  readonly workspace: string;
  readonly ltmDir?: string;
  readonly writeHandoff?: boolean;
  readonly writeLtm?: boolean;
  readonly createSession?: boolean;
  readonly includeTranscriptExcerpt?: boolean;
  readonly llmDistill?: boolean;
  readonly dedupe?: boolean;
  readonly dedupeMode?: "skip" | "refresh";
  readonly sessionTitle?: string;
  /** Rebuild hybrid FTS/vector projection after import (default true). */
  readonly reindex?: boolean;
  /** Optional index backend override for post-import reindex. */
  readonly index?: {
    readonly enabled?: boolean;
    readonly backend?: "sqlite" | "postgres" | "off";
    readonly connectionString?: string;
  };
}

export interface ImportReport {
  readonly adapterId: string;
  readonly source: ImportSourceId;
  readonly messageCount: number;
  readonly redactionCount: number;
  readonly contentDigest: string;
  readonly handoffPath?: string;
  readonly handoffId?: string;
  readonly ltmCheckpointId?: string;
  readonly ltmSkipped?: boolean;
  readonly sessionId?: string;
  readonly deduped?: boolean;
  readonly warnings: readonly string[];
  readonly durationMs: number;
}

export interface ImportRawInput {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly text?: string;
}

export interface ImportAdapter {
  readonly id: string;
  readonly source: ImportSourceId;
  detect(input: ImportRawInput): number;
  parse(input: ImportRawInput): ImportedTranscript;
}

/** Hard limits (design §3 / R3). */
export const IMPORT_MAX_BYTES = 32 * 1024 * 1024;
export const IMPORT_MAX_MESSAGES = 10_000;
export const IMPORT_MAX_TEXT_CHARS = 100_000;
export const IMPORT_DETECT_THRESHOLD = 0.6;
