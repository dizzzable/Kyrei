/**
 * Session → durable memory curator (Hermes post-turn learning analogue).
 *
 * On archive (or on demand), distill a chat into local memory directories:
 * - notes.md        — scratch / session learnings (main role)
 * - MEMORY.md       — durable project facts (writer role, append-only section)
 * - LTM checkpoint  — decisions / next actions / open threads
 * - optional handoff — resume packet under .kyrei/handoff/
 *
 * Default apply mode is **safe**: notes + LTM only. MEMORY.md requires apply_all
 * or an explicit proposal apply. Never silent full rewrite of MEMORY.md.
 */

import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { generateText, type LanguageModel } from "ai";
import { writeMemory } from "./writer.js";
import { createLtmBridge } from "./ltm-bridge.js";
import { writeHandoff, type HandoffArtifact } from "./handoff.js";
import {
  DEFAULT_CAPTURE_THRESHOLD,
  extractCaptureSignals,
  type CaptureKind,
} from "./capture-signals.js";
import { jaccardSimilarity } from "./recall-pipeline.js";

function jaccardish(a: string, b: string): number {
  return jaccardSimilarity(a, b);
}

/**
 * When LLM distill succeeds, re-inject pinned capture signals into the
 * ltm_checkpoint payload so allergy/hard prefs are not dropped.
 */
export function mergePinnedCaptureIntoProposals(
  heuristic: CuratorProposal[],
  llm: CuratorProposal[],
  transcript: string,
): CuratorProposal[] {
  const capture = extractCaptureSignals(transcript);
  if (!capture.pinned.length) return llm;
  return llm.map((p) => {
    if (p.target !== "ltm_checkpoint") return p;
    try {
      const payload = JSON.parse(p.content) as {
        decisions?: Array<{ decision?: string; pinned?: boolean; kind?: string; rationale?: string }>;
        recordDecisions?: boolean;
        [key: string]: unknown;
      };
      const decisions = Array.isArray(payload.decisions) ? [...payload.decisions] : [];
      for (const pin of capture.pinned) {
        const text = pin.line.slice(0, 280);
        const exists = decisions.some((d) => {
          const dec = String(d.decision ?? "");
          return dec === text || jaccardish(dec, text) >= 0.85;
        });
        if (!exists) {
          decisions.push({
            decision: text,
            rationale: "Pinned capture signal (merged after LLM distill)",
            pinned: true,
            kind: pin.kind,
          });
        } else {
          for (const d of decisions) {
            if (jaccardish(String(d.decision ?? ""), text) >= 0.85) {
              d.pinned = true;
              if (!d.kind) d.kind = pin.kind;
            }
          }
        }
      }
      payload.decisions = decisions;
      payload.recordDecisions = true;
      return { ...p, content: JSON.stringify(payload, null, 2) };
    } catch {
      return p;
    }
  });
}

export type CuratorApplyMode = "propose" | "apply_safe" | "apply_all";
export type CuratorTarget = "notes" | "memory" | "ltm_checkpoint" | "handoff";
/** Which model to use for the optional LLM pass (gateway resolves credentials). */
export type CuratorModelSource = "worker" | "session" | "default";

export interface CuratorProposal {
  target: CuratorTarget;
  content: string;
  rationale?: string;
}

export interface SessionCuratorConfig {
  enabled: boolean;
  /** Fire after soft-archive (gateway). Default true (recommended). */
  autoOnArchive: boolean;
  /**
   * propose — write proposal file only (review UI)
   * apply_safe — notes append + LTM checkpoint (+ optional handoff file) — recommended default
   * apply_all — apply_safe + MEMORY.md append section
   */
  applyMode: CuratorApplyMode;
  maxTranscriptChars: number;
  /** Prefer LLM distill when a LanguageModel is provided. */
  useLlm: boolean;
  /**
   * Prefer worker (small) assignment for LLM pass, else session model, else app default.
   * Recommended: worker.
   */
  modelSource: CuratorModelSource;
}

export const DEFAULT_CURATOR_CONFIG: SessionCuratorConfig = {
  enabled: true,
  autoOnArchive: true,
  applyMode: "apply_safe",
  maxTranscriptChars: 24_000,
  useLlm: true,
  modelSource: "worker",
};

export function curatorProposalDir(workspace: string): string {
  return join(workspace, ".kyrei", "memory", "curator");
}

export interface CurateSessionInput {
  sessionId: string;
  workspace: string;
  title?: string;
  messages: ReadonlyArray<{
    role?: string;
    content?: string;
    text?: string;
    parts?: readonly unknown[];
  }>;
  config?: Partial<SessionCuratorConfig>;
  /** Optional small model for structured distill. Fail-open to heuristic. */
  model?: LanguageModel;
  abortSignal?: AbortSignal;
  /** When true, force applyMode for this call (e.g. Settings button). */
  applyModeOverride?: CuratorApplyMode;
}

export interface CurateSessionResult {
  ok: boolean;
  sessionId: string;
  via: "heuristic" | "llm" | "heuristic_fallback";
  proposals: CuratorProposal[];
  applied: CuratorTarget[];
  proposalPath?: string;
  handoffPath?: string;
  error?: string;
  summary?: string;
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function flattenMessage(m: CurateSessionInput["messages"][number]): string {
  if (typeof m.text === "string" && m.text.trim()) return m.text.trim();
  if (typeof m.content === "string" && m.content.trim()) return m.content.trim();
  if (!Array.isArray(m.parts)) return "";
  const chunks: string[] = [];
  for (const part of m.parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if ((p.type === "text" || p.type === "reasoning") && typeof p.text === "string") {
      chunks.push(p.text);
    }
  }
  return chunks.join("\n").trim();
}

export function transcriptFromMessages(
  messages: CurateSessionInput["messages"],
  maxChars: number,
): string {
  const lines: string[] = [];
  for (const m of messages) {
    const role = m.role === "user" || m.role === "assistant" || m.role === "system" || m.role === "tool"
      ? m.role
      : "assistant";
    if (role === "tool") continue;
    const body = flattenMessage(m);
    if (!body) continue;
    lines.push(`${role.toUpperCase()}: ${body}`);
  }
  const full = lines.join("\n\n");
  if (full.length <= maxChars) return full;
  return full.slice(full.length - maxChars);
}

const DECISION_RE = /^(decided|decision|we (?:will|chose|pick)|going with|выбрали|решени[ея]|договорились)\b/i;
const NEXT_RE = /^(todo|next|should|need to|FIXME|TODO|далее|нужно|следующ)/i;
const FACT_RE = /^(uses?|prefer|always|never|project|stack|convention|default|важно|проект|стек|конвенци)/i;
const DONE_RE = /^(done|fixed|implemented|merged|completed|сделано|готово|исправлено)\b/i;

/** Pure heuristic proposals — no network. Wave H: capture-signal scoring + pins. */
export function heuristicCurateProposals(
  transcript: string,
  sessionId: string,
  title?: string,
  opts: { captureThreshold?: number } = {},
): CuratorProposal[] {
  const proposals: CuratorProposal[] = [];
  const lines = transcript.split(/\n+/).map((l) => l.replace(/^(USER|ASSISTANT|SYSTEM):\s*/i, "").trim());
  const threshold = opts.captureThreshold ?? DEFAULT_CAPTURE_THRESHOLD;
  const capture = extractCaptureSignals(transcript, threshold);

  const decisions: string[] = [];
  const nexts: string[] = [];
  const facts: string[] = [];
  const done: string[] = [];
  for (const line of lines) {
    if (line.length < 8 || line.length > 400) continue;
    const bare = line.replace(/^[-*•]\s*/, "");
    if (DECISION_RE.test(bare)) decisions.push(clip(bare, 280));
    else if (NEXT_RE.test(bare)) nexts.push(clip(bare, 280));
    else if (FACT_RE.test(bare)) facts.push(clip(bare, 280));
    else if (DONE_RE.test(bare)) done.push(clip(bare, 280));
  }

  // Merge high-score capture signals into buckets (MemoHood cheap gate).
  for (const s of capture.durable) {
    const text = clip(s.line, 280);
    if (s.kind === "decision" || s.kind === "correction") {
      if (!decisions.includes(text)) decisions.push(text);
    } else if (s.kind === "event" && s.reasons.includes("done")) {
      if (!done.includes(text)) done.push(text);
    } else if (s.kind === "event" && s.reasons.includes("next")) {
      if (!nexts.includes(text)) nexts.push(text);
    } else {
      if (!facts.includes(text)) facts.push(text);
    }
  }

  const uniq = (arr: string[]) => [...new Set(arr)].slice(0, 12);
  const d = uniq(decisions);
  const n = uniq(nexts);
  const f = uniq(facts);
  const dn = uniq(done);
  const pinnedLines = capture.pinned.map((s) => clip(s.line, 280));

  const label = title?.trim() || sessionId;
  const notesBody = [
    `## Session archive: ${label}`,
    `_curated ${new Date().toISOString()} · ${sessionId}_`,
    "",
    ...(dn.length ? ["### Done", ...dn.map((x) => `- ${x}`), ""] : []),
    ...(d.length ? ["### Decisions", ...d.map((x) => `- ${x}`), ""] : []),
    ...(n.length ? ["### Next", ...n.map((x) => `- ${x}`), ""] : []),
    ...(f.length ? ["### Notes", ...f.map((x) => `- ${x}`), ""] : []),
    ...(pinnedLines.length ? ["### Pinned", ...pinnedLines.map((x) => `- ${x}`), ""] : []),
  ].join("\n").trim();

  if (notesBody.length > 80) {
    proposals.push({
      target: "notes",
      content: notesBody,
      rationale: "Scratch pad: session outcomes and open work",
    });
  }

  if (f.length || d.length || pinnedLines.length) {
    const mem = [
      `## From session ${label} (${sessionId.slice(0, 12)}…)`,
      ...[...pinnedLines.map((x) => `📌 ${x}`), ...f, ...d].slice(0, 12).map((x) =>
        x.startsWith("📌") || x.startsWith("-") ? `- ${x.replace(/^- /, "")}` : `- ${x}`,
      ),
    ].join("\n");
    proposals.push({
      target: "memory",
      content: mem,
      rationale: "Durable project facts / decisions for MEMORY.md",
    });
  }

  const decisionPayloads = d.slice(0, 8).map((decision) => {
    const sig = capture.signals.find((s) => s.line === decision || decision.includes(s.line.slice(0, 40)));
    return {
      decision,
      rationale: "Extracted from archived session transcript",
      pinned: sig?.pinned === true || pinnedLines.includes(decision),
      kind: (sig?.kind ?? "decision") as CaptureKind,
    };
  });
  // Ensure pinned facts become LTM decisions even if not in d.
  for (const p of capture.pinned.slice(0, 5)) {
    const text = clip(p.line, 280);
    if (!decisionPayloads.some((x) => x.decision === text)) {
      decisionPayloads.push({
        decision: text,
        rationale: "Pinned capture signal",
        pinned: true,
        kind: p.kind,
      });
    }
  }

  const ltmPayload = {
    summary: clip(
      [label, dn[0], d[0], n[0]].filter(Boolean).join(" · ") || `Archived session ${sessionId}`,
      500,
    ),
    decisions: decisionPayloads,
    openThreads: n.slice(0, 8),
    nextActions: n.slice(0, 8),
    changedFiles: [] as string[],
    sessionId,
    /** Wave H: also write bi-temporal decision rows (with SUPERSEDE when near-dupe). */
    recordDecisions: true,
  };
  proposals.push({
    target: "ltm_checkpoint",
    content: JSON.stringify(ltmPayload, null, 2),
    rationale: "LTM checkpoint + ranked decisions for hybrid recall",
  });

  proposals.push({
    target: "handoff",
    content: JSON.stringify({
      intent: clip(label, 200),
      done: dn.slice(0, 10),
      nextActions: n.slice(0, 10),
      openQuestions: [] as string[],
      keyFiles: [] as Array<{ path: string; why: string }>,
    }),
    rationale: "Resume handoff under .kyrei/handoff/",
  });

  return proposals;
}

async function llmCurateProposals(
  transcript: string,
  sessionId: string,
  title: string | undefined,
  model: LanguageModel,
  abortSignal?: AbortSignal,
): Promise<CuratorProposal[] | null> {
  try {
    const { text } = await generateText({
      model,
      maxRetries: 0,
      maxOutputTokens: 1_200,
      ...(abortSignal ? { abortSignal } : {}),
      messages: [
        {
          role: "system",
          content: [
            "You are a memory curator for a local coding agent.",
            "Extract ONLY durable, non-secret facts from the transcript.",
            "Reply with ONE JSON object:",
            '{"notes":string[],"memory":string[],"decisions":string[],"nextActions":string[],"summary":string}',
            "notes = scratch learnings; memory = long-lived project facts; decisions = explicit choices;",
            "nextActions = remaining work. Max 8 items each. Empty arrays ok. No secrets/API keys.",
          ].join(" "),
        },
        {
          role: "user",
          content: `Session: ${title || sessionId}\n\nTRANSCRIPT:\n${transcript.slice(0, 20_000)}`,
        },
      ],
    });
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]!) as {
      notes?: unknown;
      memory?: unknown;
      decisions?: unknown;
      nextActions?: unknown;
      summary?: unknown;
    };
    const asList = (v: unknown) =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string" && x.trim().length >= 4).map((x) => clip(x, 280)).slice(0, 8)
        : [];
    const notes = asList(parsed.notes);
    const memory = asList(parsed.memory);
    const decisions = asList(parsed.decisions);
    const nextActions = asList(parsed.nextActions);
    const summary = typeof parsed.summary === "string" ? clip(parsed.summary, 400) : "";
    const label = title?.trim() || sessionId;
    const proposals: CuratorProposal[] = [];
    if (notes.length || decisions.length || nextActions.length) {
      proposals.push({
        target: "notes",
        content: [
          `## Session archive: ${label}`,
          `_LLM curated ${new Date().toISOString()} · ${sessionId}_`,
          summary ? `\n${summary}\n` : "",
          ...(notes.length ? ["### Notes", ...notes.map((x) => `- ${x}`)] : []),
          ...(decisions.length ? ["### Decisions", ...decisions.map((x) => `- ${x}`)] : []),
          ...(nextActions.length ? ["### Next", ...nextActions.map((x) => `- ${x}`)] : []),
        ].filter(Boolean).join("\n"),
        rationale: "LLM-curated session notes",
      });
    }
    if (memory.length || decisions.length) {
      proposals.push({
        target: "memory",
        content: [
          `## From session ${label}`,
          ...[...memory, ...decisions].slice(0, 10).map((x) => `- ${x}`),
        ].join("\n"),
        rationale: "LLM-curated durable facts",
      });
    }
    proposals.push({
      target: "ltm_checkpoint",
      content: JSON.stringify({
        summary: summary || `Archived: ${label}`,
        decisions: decisions.map((decision) => ({
          decision,
          rationale: "LLM curated from archived session",
        })),
        openThreads: nextActions,
        nextActions,
        changedFiles: [],
        sessionId,
      }, null, 2),
    });
    proposals.push({
      target: "handoff",
      content: JSON.stringify({
        intent: clip(summary || label, 200),
        done: notes.slice(0, 5),
        nextActions,
        openQuestions: [],
        keyFiles: [],
      }),
    });
    return proposals.length ? proposals : null;
  } catch {
    return null;
  }
}

async function readIf(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Apply already-built proposals (from live curate or a saved proposal JSON).
 * Exported for review-UI apply without re-running distill.
 */
export async function applyCuratorProposals(
  workspace: string,
  sessionId: string,
  proposals: CuratorProposal[],
  mode: CuratorApplyMode,
): Promise<{ applied: CuratorTarget[]; handoffPath?: string }> {
  const applied: CuratorTarget[] = [];
  let handoffPath: string | undefined;
  if (mode === "propose") return { applied };

  const allowMemory = mode === "apply_all";
  const notesPath = join(workspace, ".kyrei", "memory", "notes.md");
  const memoryPath = join(workspace, ".kyrei", "memory", "MEMORY.md");
  const ltmDir = join(workspace, "ltm");

  for (const p of proposals) {
    if (p.target === "notes") {
      const prev = await readIf(notesPath);
      const body = prev.trim() ? `${prev.trimEnd()}\n\n${p.content.trim()}\n` : `${p.content.trim()}\n`;
      await writeMemory("main", notesPath, body);
      applied.push("notes");
    } else if (p.target === "memory" && allowMemory) {
      const prev = await readIf(memoryPath);
      const body = prev.trim() ? `${prev.trimEnd()}\n\n${p.content.trim()}\n` : `${p.content.trim()}\n`;
      await writeMemory("writer", memoryPath, body);
      applied.push("memory");
    } else if (p.target === "ltm_checkpoint") {
      try {
        const payload = JSON.parse(p.content) as {
          summary?: string;
          decisions?: Array<{
            decision: string;
            rationale?: string;
            pinned?: boolean;
            kind?: CaptureKind;
          }>;
          openThreads?: string[];
          nextActions?: string[];
          changedFiles?: string[];
          sessionId?: string;
          recordDecisions?: boolean;
        };
        const ltm = createLtmBridge(ltmDir);
        const sid = payload.sessionId || sessionId;
        await ltm.appendCheckpoint({
          summary: payload.summary || `Archived session ${sessionId}`,
          changedFiles: payload.changedFiles ?? [],
          decisions: (payload.decisions ?? []).map((d) => ({
            decision: d.decision,
            rationale: d.rationale ?? "",
          })),
          openThreads: payload.openThreads ?? [],
          nextActions: payload.nextActions ?? [],
          sessionId: sid,
        });
        // Wave H: promote durable decisions into bi-temporal ledger with SUPERSEDE.
        if (payload.recordDecisions !== false) {
          for (const d of (payload.decisions ?? []).slice(0, 12)) {
            const text = String(d.decision ?? "").trim();
            if (text.length < 8) continue;
            try {
              // Corrections need a lower find threshold — real rewrites often score ~0.5.
              const findThreshold = d.kind === "correction" ? 0.42 : 0.72;
              const similar = await ltm.findSimilarActiveDecision(text, findThreshold);
              const sim = similar ? jaccardish(similar.decision, text) : 0;
              if (similar && sim >= 0.92 && d.kind !== "correction") {
                // Near-exact duplicate — skip (no spam). Corrections always rewrite.
                continue;
              }
              if (similar && (d.kind === "correction" || sim >= 0.5)) {
                await ltm.supersedeDecision({
                  supersedesId: similar.id,
                  decision: text,
                  rationale: d.rationale ?? `Supersedes ${similar.id} from curator`,
                  sessionId: sid,
                  pinned: d.pinned === true,
                  kind: d.kind ?? "decision",
                  tags: d.pinned ? ["pinned", "curator"] : ["curator"],
                });
              } else {
                await ltm.addDecision({
                  decision: text,
                  rationale: d.rationale ?? "Curator session archive",
                  sessionId: sid,
                  pinned: d.pinned === true,
                  kind: d.kind ?? "decision",
                  tags: d.pinned ? ["pinned", "curator"] : ["curator"],
                });
              }
            } catch {
              /* one bad decision must not block checkpoint */
            }
          }
        }
        try {
          await ltm.refreshRuntimeSnapshot();
        } catch {
          /* optional */
        }
        applied.push("ltm_checkpoint");
      } catch {
        /* skip bad payload */
      }
    } else if (p.target === "handoff") {
      try {
        let parsed: {
          intent?: string;
          done?: string[];
          nextActions?: string[];
          openQuestions?: string[];
          keyFiles?: Array<{ path: string; why: string }>;
          decisions?: Array<{ decision: string; rationale: string }>;
        } = {};
        try {
          parsed = JSON.parse(p.content) as typeof parsed;
        } catch {
          parsed = { intent: p.content.slice(0, 200) };
        }
        const artifact: HandoffArtifact = {
          id: `handoff_curator_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          createdAt: new Date().toISOString(),
          sessionId,
          trigger: "explicit",
          intent: (parsed.intent || `Archived session ${sessionId}`).slice(0, 500),
          constraints: [],
          done: (parsed.done ?? []).slice(0, 20),
          nextActions: (parsed.nextActions ?? []).slice(0, 20),
          keyFiles: (parsed.keyFiles ?? []).slice(0, 20),
          decisions: (parsed.decisions ?? []).slice(0, 20),
          openQuestions: (parsed.openQuestions ?? []).slice(0, 10),
        };
        handoffPath = await writeHandoff(workspace, artifact);
        applied.push("handoff");
      } catch {
        /* optional */
      }
    }
  }
  return { applied, handoffPath };
}

/**
 * Curate one session into local memory catalogs.
 */
export async function curateSession(input: CurateSessionInput): Promise<CurateSessionResult> {
  const cfg: SessionCuratorConfig = {
    ...DEFAULT_CURATOR_CONFIG,
    ...(input.config ?? {}),
  };
  if (!cfg.enabled) {
    return {
      ok: false,
      sessionId: input.sessionId,
      via: "heuristic",
      proposals: [],
      applied: [],
      error: "curator_disabled",
    };
  }
  if (!input.workspace) {
    return {
      ok: false,
      sessionId: input.sessionId,
      via: "heuristic",
      proposals: [],
      applied: [],
      error: "no_workspace",
    };
  }

  const transcript = transcriptFromMessages(input.messages, cfg.maxTranscriptChars);
  if (transcript.trim().length < 40) {
    return {
      ok: true,
      sessionId: input.sessionId,
      via: "heuristic",
      proposals: [],
      applied: [],
      summary: "Transcript too short to curate",
    };
  }

  let via: CurateSessionResult["via"] = "heuristic";
  let proposals = heuristicCurateProposals(transcript, input.sessionId, input.title);
  if (cfg.useLlm && input.model) {
    const llm = await llmCurateProposals(
      transcript,
      input.sessionId,
      input.title,
      input.model,
      input.abortSignal,
    );
    if (llm?.length) {
      // Preserve Wave H pins from capture signals even when LLM replaces heuristics.
      proposals = mergePinnedCaptureIntoProposals(proposals, llm, transcript);
      via = "llm";
    } else {
      via = "heuristic_fallback";
    }
  }

  const applyMode = input.applyModeOverride ?? cfg.applyMode;
  const proposalDir = curatorProposalDir(input.workspace);
  await mkdir(proposalDir, { recursive: true });
  const proposalPath = join(
    proposalDir,
    `proposal-${input.sessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48)}-${Date.now().toString(36)}.json`,
  );
  const envelope = {
    sessionId: input.sessionId,
    title: input.title,
    via,
    applyMode,
    at: new Date().toISOString(),
    status: applyMode === "propose" ? "pending" : "applied",
    proposals,
  };
  await writeFile(proposalPath, JSON.stringify(envelope, null, 2), "utf8");

  const { applied, handoffPath } = await applyCuratorProposals(
    input.workspace,
    input.sessionId,
    proposals,
    applyMode,
  );

  if (applied.length && applyMode !== "propose") {
    try {
      await writeFile(
        proposalPath,
        JSON.stringify({ ...envelope, status: "applied", appliedAt: new Date().toISOString(), applied }, null, 2),
        "utf8",
      );
    } catch {
      /* best effort */
    }
  }

  return {
    ok: true,
    sessionId: input.sessionId,
    via,
    proposals,
    applied,
    proposalPath,
    ...(handoffPath ? { handoffPath } : {}),
    summary: `Curated ${proposals.length} proposal(s); applied [${applied.join(", ") || "none"}] via ${via}`,
  };
}

export interface StoredCuratorProposalFile {
  fileName: string;
  path: string;
  sessionId: string;
  title?: string;
  via?: string;
  applyMode?: string;
  status?: string;
  at?: string;
  applied?: string[];
  proposalCount: number;
  proposals: CuratorProposal[];
}

/** List recent proposal JSON files under .kyrei/memory/curator/ (newest first). */
export async function listCuratorProposals(
  workspace: string,
  opts: { limit?: number } = {},
): Promise<StoredCuratorProposalFile[]> {
  const dir = curatorProposalDir(workspace);
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.startsWith("proposal-") && n.endsWith(".json"));
  } catch {
    return [];
  }
  names.sort().reverse();
  const limit = Math.min(100, Math.max(1, opts.limit ?? 40));
  const out: StoredCuratorProposalFile[] = [];
  for (const fileName of names.slice(0, limit)) {
    const path = join(dir, fileName);
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as {
        sessionId?: string;
        title?: string;
        via?: string;
        applyMode?: string;
        status?: string;
        at?: string;
        applied?: string[];
        proposals?: CuratorProposal[];
      };
      const proposals = Array.isArray(raw.proposals) ? raw.proposals : [];
      out.push({
        fileName,
        path,
        sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "unknown",
        title: typeof raw.title === "string" ? raw.title : undefined,
        via: typeof raw.via === "string" ? raw.via : undefined,
        applyMode: typeof raw.applyMode === "string" ? raw.applyMode : undefined,
        status: typeof raw.status === "string" ? raw.status : "pending",
        at: typeof raw.at === "string" ? raw.at : undefined,
        applied: Array.isArray(raw.applied) ? raw.applied.map(String) : undefined,
        proposalCount: proposals.length,
        proposals,
      });
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

/** Apply a saved proposal file (review UI). */
export async function applyStoredCuratorProposal(
  workspace: string,
  proposalPathOrName: string,
  applyMode: Exclude<CuratorApplyMode, "propose"> = "apply_safe",
): Promise<{
  ok: boolean;
  sessionId: string;
  applied: CuratorTarget[];
  handoffPath?: string;
  path: string;
  error?: string;
}> {
  const dir = curatorProposalDir(workspace);
  const path = proposalPathOrName.includes("/") || proposalPathOrName.includes("\\")
    ? proposalPathOrName
    : join(dir, basename(proposalPathOrName));
  // Path jail: must stay under curator dir
  const normDir = dir.replaceAll("\\", "/");
  const normPath = path.replaceAll("\\", "/");
  if (!normPath.startsWith(normDir + "/") && normPath !== normDir) {
    return { ok: false, sessionId: "", applied: [], path, error: "proposal_path_escape" };
  }
  let raw: {
    sessionId?: string;
    proposals?: CuratorProposal[];
  };
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as typeof raw;
  } catch {
    return { ok: false, sessionId: "", applied: [], path, error: "proposal_read_failed" };
  }
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "unknown";
  const proposals = Array.isArray(raw.proposals) ? raw.proposals : [];
  if (!proposals.length) {
    return { ok: false, sessionId, applied: [], path, error: "proposal_empty" };
  }
  try {
    const { applied, handoffPath } = await applyCuratorProposals(
      workspace,
      sessionId,
      proposals,
      applyMode,
    );
    try {
      const prev = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      await writeFile(
        path,
        JSON.stringify({
          ...prev,
          status: "applied",
          appliedAt: new Date().toISOString(),
          applied,
          lastApplyMode: applyMode,
        }, null, 2),
        "utf8",
      );
    } catch {
      /* best effort stamp */
    }
    return { ok: true, sessionId, applied, path, ...(handoffPath ? { handoffPath } : {}) };
  } catch (error) {
    return {
      ok: false,
      sessionId,
      applied: [],
      path,
      error: error instanceof Error ? error.message : "apply_failed",
    };
  }
}
