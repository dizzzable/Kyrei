/**
 * Project Tier A workspace memory into a MemoryStore FTS/index projection.
 *
 * Files (LTM JSONL, plan, MEMORY.md, handoffs) remain the source of truth.
 * The index is rebuildable and never exclusive: if SQLite/Postgres is down,
 * memory_search still falls back to direct file reads.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryDoc, MemoryStore, VectorStore } from "../data/ports.js";
import { createLtmBridge } from "./ltm-bridge.js";
import { createPlanStore } from "../orchestration/plan.js";
import { getEmbedAdapter, embedText, isZeroVector } from "./embed-adapter.js";

export interface ReindexProjectMemoryOptions {
  workspace: string;
  memory: MemoryStore;
  /** Optional vector projection (lexical embed by default). */
  vectors?: VectorStore;
  ltmEnabled?: boolean;
  planningEnabled?: boolean;
  /** Cap handoff files scanned (newest first). */
  maxHandoffs?: number;
  /** Cap decisions projected. */
  maxDecisions?: number;
}

export interface ReindexProjectMemoryResult {
  upserted: number;
  vectorsUpserted: number;
  sources: string[];
  backendNote?: string;
}

function contentHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 24);
}

async function readIf(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function doc(partial: Omit<MemoryDoc, "contentHash" | "updatedAt"> & { body: string }): MemoryDoc {
  return {
    ...partial,
    contentHash: contentHash(partial.body),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Full reproject of durable local memory into the given MemoryStore.
 * Fail-open per source; returns how many docs were upserted.
 */
export async function reindexProjectMemory(
  opts: ReindexProjectMemoryOptions,
): Promise<ReindexProjectMemoryResult> {
  const { workspace, memory, vectors } = opts;
  const sources: string[] = [];
  let upserted = 0;
  let vectorsUpserted = 0;
  const pendingVectors: Array<{
    ownerType: string;
    ownerId: string;
    chunkIndex: number;
    model: string;
    embedding: Float32Array;
    contentHash: string;
  }> = [];

  const upsert = async (d: MemoryDoc): Promise<void> => {
    await memory.upsertDoc(d);
    upserted += 1;
    if (vectors) {
      const text = `${d.title ?? ""}\n${d.body}`.trim();
      try {
        const embedding = await embedText(text);
        if (!isZeroVector(embedding)) {
          pendingVectors.push({
            ownerType: "memory_doc",
            ownerId: d.id,
            chunkIndex: 0,
            model: getEmbedAdapter().modelId,
            embedding,
            contentHash: d.contentHash,
          });
        }
      } catch {
        /* fail-open: skip vector for this doc */
      }
    }
  };

  // MEMORY.md + notes.md
  {
    const path = join(workspace, ".kyrei", "memory", "MEMORY.md");
    const body = await readIf(path);
    if (body?.trim()) {
      await upsert(
        doc({
          id: `proj:memory:MEMORY.md`,
          scope: "project",
          kind: "memory",
          path: ".kyrei/memory/MEMORY.md",
          workspace,
          title: "MEMORY.md",
          body,
          sourceRef: "tier-a:memory",
        }),
      );
      sources.push("memory");
    }
    const notesPath = join(workspace, ".kyrei", "memory", "notes.md");
    const notes = await readIf(notesPath);
    if (notes?.trim()) {
      await upsert(
        doc({
          id: `proj:memory:notes.md`,
          scope: "project",
          kind: "notes",
          path: ".kyrei/memory/notes.md",
          workspace,
          title: "notes.md",
          body: notes,
          sourceRef: "tier-a:notes",
        }),
      );
      sources.push("notes");
    }
  }

  // Light code-graph projection (entry candidates only — untrusted navigation hints).
  {
    try {
      const indexPath = join(workspace, ".kyrei", "intel", "project-index.json");
      const raw = await readIf(indexPath);
      if (raw?.trim()) {
        const parsed = JSON.parse(raw) as {
          entryCandidates?: Array<{ path?: string; reason?: string }>;
          languages?: Record<string, number>;
          fileCount?: number;
        };
        const entries = Array.isArray(parsed.entryCandidates) ? parsed.entryCandidates.slice(0, 24) : [];
        if (entries.length || parsed.fileCount) {
          const lines = [
            `Project graph snapshot (import-level, may be stale): ${parsed.fileCount ?? "?"} files`,
            parsed.languages ? `Languages: ${Object.keys(parsed.languages).slice(0, 12).join(", ")}` : "",
            "Entry candidates:",
            ...entries.map((e) => `- ${e.path ?? "?"}${e.reason ? ` — ${e.reason}` : ""}`),
          ].filter(Boolean);
          await upsert(
            doc({
              id: "proj:intel:entry-candidates",
              scope: "project",
              kind: "notes",
              path: ".kyrei/intel/project-index.json#entries",
              workspace,
              title: "code graph entries",
              body: lines.join("\n"),
              sourceRef: "tier-a:graph-lite",
            }),
          );
          sources.push("graph");
        }
      }
    } catch {
      /* optional / invalid json */
    }
  }

  // Handoffs
  {
    const dir = join(workspace, ".kyrei", "handoff");
    let names: string[] = [];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith(".md")).sort().reverse();
    } catch {
      names = [];
    }
    const limit = opts.maxHandoffs ?? 40;
    let count = 0;
    for (const name of names.slice(0, limit)) {
      const body = await readIf(join(dir, name));
      if (!body?.trim()) continue;
      await upsert(
        doc({
          id: `proj:handoff:${name}`,
          scope: "project",
          kind: "handoff",
          path: `.kyrei/handoff/${name}`,
          workspace,
          title: name,
          body,
          sourceRef: "tier-a:handoff",
        }),
      );
      count += 1;
    }
    if (count) sources.push("handoff");
  }

  // Plan-as-files
  if (opts.planningEnabled !== false) {
    try {
      const plan = createPlanStore(workspace);
      const roadmap = (await plan.readRoadmap()).trim();
      const state = await plan.readState();
      if (roadmap) {
        await upsert(
          doc({
            id: "proj:plan:roadmap",
            scope: "project",
            kind: "plan",
            path: ".kyrei/plan/ROADMAP.md",
            workspace,
            title: "ROADMAP.md",
            body: roadmap,
            sourceRef: "tier-a:plan",
          }),
        );
        sources.push("plan");
      }
      if (state) {
        const phase = (await plan.readPhase(state.currentPhase)).trim();
        const body = [
          `roadmapId: ${state.roadmapId}`,
          `currentPhase: ${state.currentPhase}`,
          `updatedAt: ${state.updatedAt}`,
          phase ? `\n## Phase ${state.currentPhase}\n${phase}` : "",
        ].join("\n");
        await upsert(
          doc({
            id: "proj:plan:state",
            scope: "project",
            kind: "plan",
            path: ".kyrei/plan/STATE.json",
            workspace,
            title: `plan phase ${state.currentPhase}`,
            body,
            sourceRef: "tier-a:plan",
          }),
        );
        if (!sources.includes("plan")) sources.push("plan");
      }
    } catch {
      /* plan optional */
    }
  }

  // LTM decisions + runtime recall
  if (opts.ltmEnabled !== false) {
    const ltmDir = join(workspace, "ltm");
    try {
      const bridge = createLtmBridge(ltmDir);
      const decisions = await bridge.listDecisions({ includeInvalidated: true });
      const maxDec = opts.maxDecisions ?? 200;
      for (const d of decisions.slice(0, maxDec)) {
        const status = d.validTo ? "superseded" : "active";
        const body = [
          d.decision,
          d.rationale ? `Rationale: ${d.rationale}` : "",
          d.tags.length ? `Tags: ${d.tags.join(", ")}` : "",
          `Status: ${status}`,
        ]
          .filter(Boolean)
          .join("\n");
        await upsert(
          doc({
            id: `proj:decision:${d.id}`,
            scope: "project",
            kind: "decision",
            path: `ltm/store/decisions.jsonl#${d.id}`,
            workspace,
            title: d.id,
            body,
            sourceRef: "tier-a:decision",
            frontmatter: { validTo: d.validTo, tags: d.tags },
          }),
        );
      }
      if (decisions.length) sources.push("decision");

      const { lastRecall, activeContext } = await bridge.recall();
      if (lastRecall.trim()) {
        await upsert(
          doc({
            id: "proj:ltm:last-recall",
            scope: "project",
            kind: "checkpoint",
            path: "ltm/runtime/last-recall.md",
            workspace,
            title: "LTM last-recall",
            body: lastRecall,
            sourceRef: "tier-a:ltm-recall",
          }),
        );
        sources.push("ltm_recall");
      }
      if (activeContext) {
        const body = JSON.stringify(activeContext, null, 2);
        await upsert(
          doc({
            id: "proj:ltm:active-context",
            scope: "project",
            kind: "checkpoint",
            path: "ltm/runtime/active-context.json",
            workspace,
            title: "LTM active-context",
            body,
            sourceRef: "tier-a:ltm-context",
          }),
        );
      }
    } catch {
      /* ltm optional */
    }
  }

  if (vectors && pendingVectors.length) {
    try {
      // Batch upsert keeps sqlite transactions cheap.
      const batch = 64;
      for (let i = 0; i < pendingVectors.length; i += batch) {
        const slice = pendingVectors.slice(i, i + batch);
        await vectors.upsert(slice);
        vectorsUpserted += slice.length;
      }
    } catch (error) {
      console.warn("[kyrei memory-index] vector projection failed:", error);
    }
  }

  return { upserted, vectorsUpserted, sources };
}
