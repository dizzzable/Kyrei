/**
 * Wave B1 — content-aware tool-output compression (Headroom-shaped).
 *
 * Pure + optional CCR: shrink JSON / logs / diffs / source before the model
 * pays tokens; full body remains recallable via retrieve(hash).
 *
 * Design:
 * - Local-first, reversible (never invent content; only drop redundancy).
 * - Shape detection is best-effort; unknown text falls back to head+tail.
 * - Safe for any tool string (run_command, read_file, web, MCP, …).
 */

import { createHash } from "node:crypto";
import type { CcrStore } from "./ccr.js";
import { skimTextForFocus } from "./goal-skim.js";

export type ToolContentKind =
  | "json"
  | "log"
  | "stack"
  | "diff"
  | "code"
  | "markdown"
  | "text";

export interface CompressOptions {
  /** Hard cap for model-visible text (chars). */
  maxChars: number;
  /** Prefer this many chars of head when head/tail splitting. */
  headRatio?: number;
  /** Optional CCR for full-body storage when truncated. */
  ccr?: CcrStore;
  /** Tool name for stub context (optional). */
  toolName?: string;
  /** Path or other target for stub context (optional). */
  target?: string;
  /**
   * Wave D1: goal/focus string for line-level skim (code/text).
   * When set, prefer match-preserving skim over blind head/tail.
   */
  focus?: string;
  /** When false, skip goal skim even if focus is set. Default true. */
  goalSkim?: boolean;
}

export interface CompressResult {
  text: string;
  kind: ToolContentKind;
  originalChars: number;
  compressed: boolean;
  /** Present when full original was stored for retrieve(). */
  hash?: string;
  ratio: number;
}

function shortHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);
}

/** Best-effort content classification. */
export function detectToolContentKind(text: string): ToolContentKind {
  const sample = text.slice(0, 4_000).trim();
  if (!sample) return "text";

  if (
    (sample.startsWith("{") && sample.includes("}"))
    || (sample.startsWith("[") && sample.includes("]"))
  ) {
    try {
      JSON.parse(sample.length < text.length ? text : sample);
      return "json";
    } catch {
      // trailing junk / NDJSON — still treat as JSON-ish if many braces
      if ((sample.match(/[{[]/g)?.length ?? 0) > 3) return "json";
    }
  }

  const lines = text.split("\n");
  const sampleLines = lines.slice(0, 80);
  const diffHits = sampleLines.filter((l) => /^(diff --git|@@ |\+\+\+ |--- |[+-](?![+-]))/.test(l)).length;
  if (diffHits >= 3) return "diff";

  const stackHits = sampleLines.filter((l) =>
    /^\s*at\s+\S+/.test(l)
    || /Traceback \(most recent call last\)/.test(l)
    || /^\s*File ".+", line \d+/.test(l)
    || /Exception|Error:|Caused by:/.test(l),
  ).length;
  if (stackHits >= 2) return "stack";

  const logHits = sampleLines.filter((l) =>
    /^\d{4}-\d{2}-\d{2}[T ]/.test(l)
    || /^(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b/i.test(l)
    || /^\[[\d.:]+\]/.test(l)
    || /\b(error|warn|exception|failed)\b/i.test(l),
  ).length;
  if (logHits >= Math.min(8, Math.ceil(sampleLines.length * 0.35))) return "log";

  const mdHits = sampleLines.filter((l) =>
    /^#{1,6}\s/.test(l) || /^```/.test(l) || /^\s*[-*]\s+/.test(l) || /^\|/.test(l),
  ).length;
  if (mdHits >= 4) return "markdown";

  const codeHits = sampleLines.filter((l) =>
    /^(import |export |from |const |let |var |function |class |def |package |using |#include )/
      .test(l)
    || /[{};]\s*$/.test(l),
  ).length;
  if (codeHits >= Math.min(6, Math.ceil(sampleLines.length * 0.25))) return "code";

  return "text";
}

function headTail(text: string, maxChars: number, headRatio = 0.6): string {
  if (text.length <= maxChars) return text;
  const headBudget = Math.max(80, Math.floor(maxChars * headRatio));
  const tailBudget = Math.max(40, maxChars - headBudget - 40);
  const head = text.slice(0, headBudget);
  const tail = text.slice(text.length - tailBudget);
  return `${head}\n…\n${tail}`;
}

/** Compact JSON: drop empty, bound arrays, keep key order. */
export function compressJson(text: string, maxChars: number): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // NDJSON / multi-json: keep lines that parse, cap rows
    const lines = text.split("\n").filter((l) => l.trim());
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
      try {
        const compact = JSON.stringify(JSON.parse(line));
        if (used + compact.length + 1 > maxChars) break;
        kept.push(compact);
        used += compact.length + 1;
      } catch {
        if (used + line.length + 1 > maxChars) break;
        kept.push(line.slice(0, 400));
        used += Math.min(line.length, 400) + 1;
      }
    }
    const body = kept.join("\n");
    return body.length < text.length
      ? `${body}\n… [json lines ${kept.length}/${lines.length}]`
      : headTail(text, maxChars);
  }

  const prune = (node: unknown, depth: number): unknown => {
    if (node == null) return node;
    if (typeof node === "string") {
      return node.length > 400 ? `${node.slice(0, 400)}…` : node;
    }
    if (typeof node !== "object") return node;
    if (Array.isArray(node)) {
      const maxItems = depth === 0 ? 40 : 12;
      const slice = node.slice(0, maxItems).map((item) => prune(item, depth + 1));
      if (node.length > maxItems) {
        return [...slice, `… +${node.length - maxItems} more`];
      }
      return slice;
    }
    const out: Record<string, unknown> = {};
    const entries = Object.entries(node as Record<string, unknown>);
    const maxKeys = depth === 0 ? 60 : 20;
    for (const [k, v] of entries.slice(0, maxKeys)) {
      if (v === "" || v === null || v === undefined) continue;
      out[k] = prune(v, depth + 1);
    }
    if (entries.length > maxKeys) out["…"] = `+${entries.length - maxKeys} keys`;
    return out;
  };

  try {
    let compact = JSON.stringify(prune(value, 0), null, 2);
    if (compact.length > maxChars) compact = headTail(compact, maxChars, 0.7);
    return compact;
  } catch {
    return headTail(text, maxChars);
  }
}

/** Keep errors/warnings + last N lines of noisy logs. */
export function compressLog(text: string, maxChars: number): string {
  const lines = text.split("\n");
  if (text.length <= maxChars) return text;
  const interesting = lines.filter((l) =>
    /\b(error|err|warn|warning|fatal|exception|fail|failed|panic|critical)\b/i.test(l)
    || /^\s*at\s+/.test(l)
    || /Traceback|Caused by/.test(l),
  );
  const tailN = 40;
  const tail = lines.slice(-tailN);
  const head = lines.slice(0, 12);
  const uniq = [...new Set([...head, ...interesting.slice(0, 60), "…", ...tail])];
  let body = uniq.join("\n");
  if (body.length > maxChars) body = headTail(body, maxChars, 0.45);
  return `[log compressed: ${lines.length} lines → highlight errors + head/tail]\n${body}`;
}

/** Stack traces: exception header + top frames + tail. */
export function compressStack(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  const frames = lines.filter((l) => /^\s*at\s+/.test(l) || /File ".+", line \d+/.test(l));
  const header = lines.slice(0, 15);
  const top = frames.slice(0, 25);
  const body = [...header, ...(top.length ? ["--- frames ---", ...top] : []), ...lines.slice(-8)].join("\n");
  return body.length <= maxChars ? body : headTail(body, maxChars, 0.55);
}

/** Unified diffs: file headers + hunks, drop pure context if needed. */
export function compressDiff(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  // Prefer changed lines + headers over pure context
  const preferred = lines.filter((l) =>
    /^(diff --git|index |--- |\+\+\+ |@@ )/.test(l)
    || (/^[+-]/.test(l) && !/^[+-]{3}/.test(l)),
  );
  let body = (preferred.length > 8 ? preferred : lines).join("\n");
  if (body.length > maxChars) body = headTail(body, maxChars, 0.5);
  return `[diff compressed: ${lines.length} lines]\n${body}`;
}

/** Source: keep imports + outline (signatures) + head/tail. */
export function compressCode(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  const outline = lines
    .map((l, i) => ({ l, i: i + 1 }))
    .filter(({ l }) =>
      /^(export |import |from |class |function |def |interface |type |enum |struct |impl |fn |pub |private |public |protected |async |const \w+ = (async )?\(|module\.exports)/
        .test(l.trim())
      || /^\s*(export )?(async )?(function|class|const|let|var|type|interface)\b/.test(l),
    )
    .slice(0, 80)
    .map(({ l, i }) => `${i}| ${l.trim().slice(0, 160)}`);
  const head = lines.slice(0, 40).map((l, i) => `${i + 1}| ${l}`);
  const tail = lines.slice(-20).map((l, i) => `${lines.length - 20 + i + 1}| ${l}`);
  const body = [
    `[code outline: ${lines.length} lines, hash=${shortHash(text)}]`,
    "### outline",
    ...outline,
    "### head",
    ...head,
    "### tail",
    ...tail,
  ].join("\n");
  return body.length <= maxChars ? body : headTail(body, maxChars, 0.65);
}

export function compressMarkdown(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // Keep headings + first paragraph under each + lists
  const lines = text.split("\n");
  const kept: string[] = [];
  let underHeading = 0;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) || /^```/.test(line)) {
      kept.push(line);
      underHeading = 0;
      continue;
    }
    if (/^\s*[-*+]\s+|^\s*\d+\.\s+/.test(line)) {
      kept.push(line.slice(0, 200));
      continue;
    }
    if (line.trim() && underHeading < 2) {
      kept.push(line.slice(0, 240));
      underHeading += 1;
    }
  }
  let body = kept.join("\n");
  if (body.length < 80) body = headTail(text, maxChars);
  else if (body.length > maxChars) body = headTail(body, maxChars, 0.7);
  return body;
}

function shapeCompress(
  text: string,
  kind: ToolContentKind,
  maxChars: number,
  focus?: string,
  goalSkim = true,
): string {
  if (goalSkim !== false && focus?.trim() && (kind === "code" || kind === "text" || kind === "markdown")) {
    const skimmed = skimTextForFocus(text, { maxChars, focus });
    if (skimmed.skimmed) return skimmed.text;
  }
  switch (kind) {
    case "json":
      return compressJson(text, maxChars);
    case "log":
      return compressLog(text, maxChars);
    case "stack":
      return compressStack(text, maxChars);
    case "diff":
      return compressDiff(text, maxChars);
    case "code":
      return compressCode(text, maxChars);
    case "markdown":
      return compressMarkdown(text, maxChars);
    default:
      return headTail(text, maxChars);
  }
}

function stubPrefix(opts: {
  kind: ToolContentKind;
  originalChars: number;
  hash?: string;
  toolName?: string;
  target?: string;
}): string {
  const bits = [
    `kind=${opts.kind}`,
    `chars=${opts.originalChars}`,
    opts.toolName ? `tool=${opts.toolName}` : "",
    opts.target ? `target=${opts.target}` : "",
    opts.hash ? `retrieve("${opts.hash}")` : "",
  ].filter(Boolean);
  return `[tool-compress ${bits.join(" ")}]\n`;
}

/**
 * Compress tool output for the model. Stores full text in CCR when truncated
 * and a store is provided (reversible).
 */
export async function compressToolOutput(
  input: string,
  options: CompressOptions,
): Promise<CompressResult> {
  const text = String(input ?? "");
  const maxChars = Math.max(200, Math.floor(options.maxChars));
  const kind = detectToolContentKind(text);
  const originalChars = text.length;

  if (originalChars <= maxChars) {
    return {
      text,
      kind,
      originalChars,
      compressed: false,
      ratio: 1,
    };
  }

  // Reserve room for stub prefix + hash line.
  const budget = Math.max(200, maxChars - 160);
  let shaped = shapeCompress(
    text,
    kind,
    budget,
    options.focus,
    options.goalSkim !== false,
  );
  if (shaped.length > budget) shaped = headTail(shaped, budget, options.headRatio ?? 0.6);

  let hash: string | undefined;
  if (options.ccr) {
    try {
      hash = await options.ccr.put(text);
    } catch {
      hash = undefined;
    }
  }

  const prefix = stubPrefix({
    kind,
    originalChars,
    hash,
    toolName: options.toolName,
    target: options.target,
  });
  let out = prefix + shaped;
  if (out.length > maxChars) out = out.slice(0, maxChars);

  return {
    text: out,
    kind,
    originalChars,
    compressed: true,
    ...(hash ? { hash } : {}),
    ratio: out.length / originalChars,
  };
}

/** Sync path when CCR is not needed (live tool clip). */
export function compressToolOutputSync(
  input: string,
  options: Omit<CompressOptions, "ccr">,
): CompressResult {
  const text = String(input ?? "");
  const maxChars = Math.max(200, Math.floor(options.maxChars));
  const kind = detectToolContentKind(text);
  const originalChars = text.length;
  if (originalChars <= maxChars) {
    return { text, kind, originalChars, compressed: false, ratio: 1 };
  }
  const budget = Math.max(200, maxChars - 120);
  let shaped = shapeCompress(
    text,
    kind,
    budget,
    options.focus,
    options.goalSkim !== false,
  );
  if (shaped.length > budget) shaped = headTail(shaped, budget, options.headRatio ?? 0.6);
  const contentHash = shortHash(text);
  const prefix = stubPrefix({
    kind,
    originalChars,
    toolName: options.toolName,
    target: options.target,
  }) + `(content_hash=${contentHash}; full body not archived — re-run tool if needed)\n`;
  let out = prefix + shaped;
  if (out.length > maxChars) out = out.slice(0, maxChars);
  return {
    text: out,
    kind,
    originalChars,
    compressed: true,
    ratio: out.length / originalChars,
  };
}
