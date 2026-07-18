import { basename, join } from "node:path";
import type { MemoryDoc, MemoryStore } from "../data/ports.js";
import { createStores, createStoresAsync, type Stores } from "../data/index.js";
import type { MemoryIndexConfig } from "./index-backend.js";
import { loadProjectIndex } from "../intel/project-index.js";
import { normalizeWorkspaceTag, sameWorkspaceTag } from "./workspace-id.js";

export type MemoryGraphGroup = "project" | "code" | "document" | "decision" | "plan" | "handoff" | "session" | "memory";

export interface MemoryGraphNode {
  id: string;
  group: MemoryGraphGroup;
  title: string;
  path?: string;
  subtitle?: string;
  preview?: string;
  updatedAt?: string;
}

export interface MemoryGraphEdge {
  source: string;
  target: string;
  type: "imports" | "contains" | "references";
}

export interface WorkspaceMemoryGraph {
  version: 1;
  generatedAt: string;
  workspace: string;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  stats: { code: number; documents: number; decisions: number; sessions: number; edges: number; truncated: boolean };
}

function groupFor(doc: MemoryDoc): MemoryGraphGroup {
  if (doc.sourceRef === "tier-a:imported-doc" || doc.sourceRef === "vault:markdown") return "document";
  if (doc.kind === "decision") return "decision";
  if (doc.kind === "plan") return "plan";
  if (doc.kind === "handoff") return "handoff";
  if (doc.scope === "session" || doc.sourceRef?.startsWith("session:")) return "session";
  return "memory";
}

export async function buildWorkspaceMemoryGraph(input: {
  workspace: string;
  memory?: MemoryStore | null;
  maxCodeNodes?: number;
  maxDocs?: number;
  maxEdges?: number;
}): Promise<WorkspaceMemoryGraph> {
  const workspace = normalizeWorkspaceTag(input.workspace);
  const codeLimit = Math.max(50, Math.min(2_000, input.maxCodeNodes ?? 700));
  const docLimit = Math.max(20, Math.min(1_000, input.maxDocs ?? 300));
  const edgeLimit = Math.max(100, Math.min(5_000, input.maxEdges ?? 1_500));
  const project = await loadProjectIndex(workspace);
  const codeNodes = (project?.nodes ?? []).slice(0, codeLimit);
  const codePaths = new Set(codeNodes.map((node) => node.path));
  const nodes: MemoryGraphNode[] = [{
    id: "project:root",
    group: "project",
    title: basename(workspace) || "Project",
    subtitle: workspace,
  }];
  nodes.push(...codeNodes.map((node) => ({
    id: `code:${node.path}`,
    group: "code" as const,
    title: basename(node.path),
    path: node.path,
    subtitle: node.language,
  })));

  let docs: MemoryDoc[] = [];
  if (input.memory) {
    try {
      docs = (await input.memory.listDocs({ scope: "project" }))
        .filter((doc) => !doc.workspace || sameWorkspaceTag(doc.workspace, workspace))
        .slice(0, docLimit);
    } catch {
      docs = [];
    }
  }
  for (const doc of docs) {
    nodes.push({
      id: `memory:${doc.id}`,
      group: groupFor(doc),
      title: doc.title || basename(doc.path),
      path: doc.path,
      subtitle: doc.sourceRef || doc.kind,
      preview: doc.body.replace(/\s+/g, " ").trim().slice(0, 280),
      updatedAt: doc.updatedAt,
    });
  }

  const edges: MemoryGraphEdge[] = [];
  for (const edge of (project?.edges ?? []).slice(0, edgeLimit)) {
    if (!codePaths.has(edge.from) || !codePaths.has(edge.to)) continue;
    edges.push({ source: `code:${edge.from}`, target: `code:${edge.to}`, type: "imports" });
  }
  const entryCandidates = (project?.entryCandidates ?? [])
    .filter((path) => Boolean(path) && codePaths.has(path));
  for (const path of entryCandidates.slice(0, 40)) {
    edges.push({ source: "project:root", target: `code:${path}`, type: "contains" });
  }
  for (const doc of docs) {
    const docId = `memory:${doc.id}`;
    edges.push({ source: "project:root", target: docId, type: "contains" });
    for (const path of entryCandidates.slice(0, 40)) {
      if (doc.body.includes(path)) edges.push({ source: docId, target: `code:${path}`, type: "references" });
    }
  }

  const boundedEdges = edges.slice(0, edgeLimit);
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    workspace,
    nodes,
    edges: boundedEdges,
    stats: {
      code: codeNodes.length,
      documents: nodes.filter((node) => node.group === "document").length,
      decisions: nodes.filter((node) => node.group === "decision").length,
      sessions: nodes.filter((node) => node.group === "session").length,
      edges: boundedEdges.length,
      truncated: Boolean(project?.truncated || (project?.nodes.length ?? 0) > codeNodes.length || docs.length >= docLimit),
    },
  };
}

export async function getWorkspaceMemoryGraph(input: {
  workspace: string;
  config?: MemoryIndexConfig;
}): Promise<WorkspaceMemoryGraph> {
  let stores: Stores | null = null;
  try {
    if (input.config?.enabled !== false && input.config?.backend !== "off") {
      const baseDir = join(normalizeWorkspaceTag(input.workspace), ".kyrei", "index");
      stores = input.config?.backend === "postgres" && input.config.connectionString
        ? await createStoresAsync({ baseDir, backend: "postgres", connectionString: input.config.connectionString })
        : createStores(baseDir);
    }
    return await buildWorkspaceMemoryGraph({
      workspace: input.workspace,
      ...(stores?.memory ? { memory: stores.memory } : {}),
    });
  } finally {
    if (stores) {
      try {
        await stores.close();
      } catch {
        // A read-only graph request must not mask its result with cleanup errors.
      }
    }
  }
}
