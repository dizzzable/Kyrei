import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { MemoryDoc, MemoryStore } from "../data/ports.js";
import { createStores, createStoresAsync, type Stores } from "../data/index.js";
import { loadProjectIndex } from "../intel/project-index.js";
import type { WorkspaceMemoryGraph, MemoryGraphGroup } from "./graph-view.js";
import type { MemoryIndexConfig } from "./index-backend.js";
import {
  type MemoryAtlasEdge,
  type MemoryAtlasEvolutionMetadata,
  type MemoryAtlasNode,
  type MemoryAtlasNodeKind,
  type MemoryAtlasSnapshot,
  type MemoryAtlasSourceDescriptor,
  type MemoryAtlasSourcePayload,
  type MemoryAtlasSkillMetadata,
  type MemoryAtlasTreeNode,
} from "./atlas-types.js";
import { normalizeWorkspaceTag, sameWorkspaceTag } from "./workspace-id.js";

export interface OptionalMemoryAtlasSource {
  descriptor: Pick<MemoryAtlasSourceDescriptor, "id" | "label" | "capability">;
  load: () => Promise<MemoryAtlasSourcePayload>;
}

export interface BuildMemoryAtlasInput {
  workspace: string;
  memory?: MemoryStore | null;
  skills?: readonly MemoryAtlasSkillMetadata[];
  evolution?: readonly MemoryAtlasEvolutionMetadata[];
  optionalSources?: readonly OptionalMemoryAtlasSource[];
  maxCodeNodes?: number;
  maxDocs?: number;
  maxEdges?: number;
  now?: () => Date;
}

export interface GetWorkspaceMemoryAtlasInput extends Omit<BuildMemoryAtlasInput, "memory"> {
  config?: MemoryIndexConfig;
}

function memoryKind(doc: MemoryDoc): MemoryAtlasNodeKind {
  if (doc.sourceRef === "tier-a:imported-doc" || doc.sourceRef === "vault:markdown") return "document";
  if (doc.kind === "decision") return "decision";
  if (doc.kind === "plan") return "plan";
  if (doc.kind === "handoff") return "handoff";
  if (doc.scope === "session" || doc.sourceRef?.startsWith("session:")) return "session";
  return "memory";
}

function normalizedPath(path: string | undefined): string {
  return String(path ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
}

function treeSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

function addTreePath(
  tree: Map<string, MemoryAtlasTreeNode>,
  sourceId: string,
  sourceLabel: string,
  path: string,
  nodeId: string,
  itemLabel: string,
): void {
  const rootId = `tree:${treeSegment(sourceId)}`;
  if (!tree.has(rootId)) {
    tree.set(rootId, { id: rootId, sourceId, kind: "source", label: sourceLabel, childCount: 0 });
  }
  const segments = normalizedPath(path).split("/").filter(Boolean);
  const folders = segments.slice(0, -1);
  let parentId = rootId;
  let accumulated = "";
  for (const folder of folders) {
    accumulated = accumulated ? `${accumulated}/${folder}` : folder;
    const id = `${rootId}:${accumulated.split("/").map(treeSegment).join(":")}`;
    if (!tree.has(id)) {
      tree.set(id, { id, sourceId, kind: "folder", label: folder, parentId, path: accumulated, childCount: 0 });
    }
    parentId = id;
  }
  const itemId = `${rootId}:item:${createHash("sha1").update(nodeId).digest("hex").slice(0, 12)}`;
  tree.set(itemId, {
    id: itemId,
    sourceId,
    kind: "item",
    label: itemLabel,
    parentId,
    path: normalizedPath(path),
    nodeId,
    childCount: 0,
  });
}

function finalizeTree(tree: Map<string, MemoryAtlasTreeNode>): MemoryAtlasTreeNode[] {
  const counts = new Map<string, number>();
  for (const node of tree.values()) {
    if (node.parentId) counts.set(node.parentId, (counts.get(node.parentId) ?? 0) + 1);
  }
  return [...tree.values()]
    .map((node) => ({ ...node, childCount: counts.get(node.id) ?? 0 }))
    .sort((left, right) => (left.parentId ?? "").localeCompare(right.parentId ?? "") || left.label.localeCompare(right.label));
}

async function memoryDocs(memory: MemoryStore | null | undefined, workspace: string): Promise<{
  docs: MemoryDoc[];
  failedScopes: string[];
}> {
  if (!memory) return { docs: [], failedScopes: [] };
  const docs: MemoryDoc[] = [];
  const failedScopes: string[] = [];
  for (const scope of ["project", "session"] as const) {
    try {
      const scoped = await memory.listDocs({ scope });
      docs.push(...scoped.filter((doc) => !doc.workspace || sameWorkspaceTag(doc.workspace, workspace)));
    } catch {
      failedScopes.push(scope);
    }
  }
  const unique = new Map(docs.map((doc) => [doc.id, doc]));
  return { docs: [...unique.values()], failedScopes };
}

export async function buildMemoryAtlas(input: BuildMemoryAtlasInput): Promise<MemoryAtlasSnapshot> {
  const workspace = normalizeWorkspaceTag(input.workspace);
  const generatedAt = (input.now?.() ?? new Date()).toISOString();
  const codeLimit = Math.max(50, Math.min(2_000, input.maxCodeNodes ?? 700));
  const docLimit = Math.max(20, Math.min(2_000, input.maxDocs ?? 500));
  const edgeLimit = Math.max(100, Math.min(5_000, input.maxEdges ?? 1_500));
  const project = await loadProjectIndex(workspace);
  const allCodeNodes = project?.nodes ?? [];
  const codeNodes = allCodeNodes.slice(0, codeLimit);
  const codePaths = new Set(codeNodes.map((node) => node.path));
  const nodes: MemoryAtlasNode[] = [{
    id: "project:root",
    sourceId: "project",
    kind: "project",
    title: basename(workspace) || "Project",
    subtitle: workspace,
  }];
  const edges: MemoryAtlasEdge[] = [];
  const tree = new Map<string, MemoryAtlasTreeNode>();
  tree.set("tree:code", { id: "tree:code", sourceId: "code", kind: "source", label: "Code", childCount: 0 });
  const sources: MemoryAtlasSourceDescriptor[] = [{
    id: "code",
    label: "Code",
    capability: "browse",
    health: project ? "ready" : "degraded",
    ...(project ? {} : { reason: "project_index_unavailable" }),
    generatedAt,
  }];

  for (const node of codeNodes) {
    const id = `code:${node.path}`;
    nodes.push({ id, sourceId: "code", kind: "code", title: basename(node.path), path: node.path, subtitle: node.language });
    addTreePath(tree, "code", "Code", node.path, id, basename(node.path));
  }
  for (const edge of (project?.edges ?? [])) {
    if (!codePaths.has(edge.from) || !codePaths.has(edge.to)) continue;
    edges.push({ source: `code:${edge.from}`, target: `code:${edge.to}`, type: "imports", sourceId: "code" });
  }
  for (const path of (project?.entryCandidates ?? []).filter((path) => codePaths.has(path)).slice(0, 40)) {
    edges.push({ source: "project:root", target: `code:${path}`, type: "contains", sourceId: "project" });
  }

  const loadedMemory = await memoryDocs(input.memory, workspace);
  const allDocs = loadedMemory.docs;
  const docs = allDocs.slice(0, docLimit);
  sources.push({
    id: "memory",
    label: "Memory",
    capability: "browse",
    health: loadedMemory.failedScopes.length ? (docs.length ? "degraded" : "unavailable") : "ready",
    ...(loadedMemory.failedScopes.length ? { reason: `scope_load_failed:${loadedMemory.failedScopes.join(",")}` } : {}),
    generatedAt,
    truncated: allDocs.length > docs.length,
    omitted: Math.max(0, allDocs.length - docs.length),
  });
  sources.push({
    id: "documents",
    label: "Documents",
    capability: "browse",
    health: loadedMemory.failedScopes.length ? "degraded" : "ready",
    ...(loadedMemory.failedScopes.length ? { reason: `memory_scope_load_failed:${loadedMemory.failedScopes.join(",")}` } : {}),
    generatedAt,
  });
  sources.push({
    id: "sessions",
    label: "Sessions",
    capability: "browse",
    health: loadedMemory.failedScopes.includes("session") ? "degraded" : "ready",
    ...(loadedMemory.failedScopes.includes("session") ? { reason: "session_scope_load_failed" } : {}),
    generatedAt,
  });
  const entryCandidates = (project?.entryCandidates ?? []).filter((path) => codePaths.has(path)).slice(0, 40);
  for (const doc of docs) {
    const id = `memory:${doc.id}`;
    const kind = memoryKind(doc);
    nodes.push({
      id,
      sourceId: kind === "session" ? "sessions" : "memory",
      kind,
      title: doc.title || basename(doc.path),
      path: doc.path,
      subtitle: doc.sourceRef || doc.kind,
      preview: doc.body.replace(/\s+/g, " ").trim().slice(0, 280),
      updatedAt: doc.updatedAt,
      digest: doc.contentHash,
    });
    const sourceId = kind === "session" ? "sessions" : kind === "document" ? "documents" : "memory";
    const sourceLabel = kind === "session" ? "Sessions" : kind === "document" ? "Documents" : "Memory";
    const displayPath = kind === "document"
      ? normalizedPath(doc.path).replace(/^\.kyrei\/memory\//, "")
      : normalizedPath(doc.path);
    addTreePath(tree, sourceId, sourceLabel, displayPath || `${doc.id}.md`, id, doc.title || basename(doc.path));
    edges.push({ source: "project:root", target: id, type: "contains", sourceId });
    for (const path of entryCandidates) {
      if (doc.body.includes(path)) edges.push({ source: id, target: `code:${path}`, type: "references", sourceId });
    }
  }

  const skills = [...(input.skills ?? [])];
  sources.push({ id: "skills", label: "Skills", capability: "browse", health: "ready", generatedAt });
  for (const skill of skills) {
    const id = `skill:${skill.id}`;
    const root = normalizedPath(skill.rootKind || "other");
    const path = `${root}/${normalizedPath(skill.path || `${skill.name}/SKILL.md`)}`;
    nodes.push({
      id,
      entityId: skill.id,
      sourceId: "skills",
      kind: "skill",
      title: skill.name,
      path: skill.path,
      subtitle: skill.rootKind,
      preview: skill.description?.slice(0, 280),
      digest: skill.digest,
      enabled: skill.enabled,
      compatible: skill.compatible,
    });
    addTreePath(tree, "skills", "Skills", path, id, skill.name);
    edges.push({ source: "project:root", target: id, type: "contains", sourceId: "skills" });
    for (const document of skill.linkedDocuments ?? []) {
      const documentId = `skill-document:${createHash("sha1").update(`${skill.id}:${document.id}`).digest("hex").slice(0, 20)}`;
      const documentPath = normalizedPath(document.path || document.title || document.id);
      nodes.push({
        id: documentId,
        sourceId: "skills",
        kind: "document",
        title: document.title || basename(documentPath) || document.id,
        path: document.path,
        subtitle: `Linked to ${skill.name}`,
        preview: "Linked Skill reference metadata. Content is loaded only on demand.",
      });
      addTreePath(
        tree,
        "skills",
        "Skills",
        `${root}/${normalizedPath(skill.name)}/linked/${documentPath}`,
        documentId,
        document.title || basename(documentPath) || document.id,
      );
      edges.push({ source: id, target: documentId, type: "contains", sourceId: "skills" });
    }
  }

  const evolution = [...(input.evolution ?? [])];
  sources.push({ id: "evolution", label: "Evolution", capability: "browse", health: "ready", generatedAt });
  for (const candidate of evolution) {
    const id = `evolution:${candidate.id}`;
    const path = `${candidate.status}/${candidate.targetKind}/${candidate.id}`;
    nodes.push({
      id,
      entityId: candidate.id,
      sourceId: "evolution",
      kind: "evolution",
      title: candidate.title,
      path,
      subtitle: `${candidate.status} · ${candidate.risk} · ${candidate.targetKind}:${candidate.targetId}`,
      preview: candidate.summary?.slice(0, 280),
      updatedAt: candidate.updatedAt,
      digest: candidate.digest,
    });
    addTreePath(tree, "evolution", "Evolution", path, id, candidate.title);
    edges.push({ source: "project:root", target: id, type: "contains", sourceId: "evolution" });
  }

  for (const optional of input.optionalSources ?? []) {
    const optionalRootId = `tree:${treeSegment(optional.descriptor.id)}`;
    if (!tree.has(optionalRootId)) {
      tree.set(optionalRootId, {
        id: optionalRootId,
        sourceId: optional.descriptor.id,
        kind: "source",
        label: optional.descriptor.label,
        childCount: 0,
      });
    }
    try {
      const payload = await optional.load();
      nodes.push(...(payload.nodes ?? []));
      edges.push(...(payload.edges ?? []));
      for (const item of payload.tree ?? []) tree.set(item.id, item);
      sources.push({
        ...optional.descriptor,
        health: payload.health ?? "ready",
        ...(payload.reason ? { reason: payload.reason } : {}),
        generatedAt,
        truncated: payload.truncated,
        omitted: payload.omitted,
      });
    } catch {
      sources.push({ ...optional.descriptor, health: "unavailable", reason: "source_load_failed", generatedAt });
    }
  }

  const boundedEdges = edges.slice(0, edgeLimit);
  const truncationReasons = [
    ...(Boolean(project?.truncated) ? ["project_index_truncated"] : []),
    ...(allCodeNodes.length > codeNodes.length ? [`code_nodes:${allCodeNodes.length - codeNodes.length}`] : []),
    ...(allDocs.length > docs.length ? [`memory_docs:${allDocs.length - docs.length}`] : []),
    ...(edges.length > boundedEdges.length ? [`edges:${edges.length - boundedEdges.length}`] : []),
    ...sources.filter((source) => source.truncated).map((source) => `source:${source.id}:${source.omitted ?? 0}`),
  ];
  const snapshotSeed = JSON.stringify({ workspace, generatedAt, nodes: nodes.map((node) => node.id), sources });
  return {
    version: 2,
    snapshotId: createHash("sha256").update(snapshotSeed).digest("hex").slice(0, 24),
    generatedAt,
    workspace,
    sources,
    tree: finalizeTree(tree),
    nodes,
    edges: boundedEdges,
    stats: {
      nodes: nodes.length,
      edges: boundedEdges.length,
      code: nodes.filter((node) => node.kind === "code").length,
      documents: nodes.filter((node) => node.kind === "document").length,
      decisions: nodes.filter((node) => node.kind === "decision").length,
      sessions: nodes.filter((node) => node.kind === "session").length,
      skills: nodes.filter((node) => node.kind === "skill").length,
      evolution: nodes.filter((node) => node.kind === "evolution").length,
      truncated: truncationReasons.length > 0,
      truncationReasons,
    },
  };
}

function v1Group(kind: MemoryAtlasNodeKind): MemoryGraphGroup | undefined {
  return kind === "skill" || kind === "evolution" ? undefined : kind;
}

export function memoryAtlasToGraphV1(atlas: MemoryAtlasSnapshot): WorkspaceMemoryGraph {
  const nodes = atlas.nodes.flatMap((node) => {
    const group = v1Group(node.kind);
    return group ? [{
      id: node.id,
      group,
      title: node.title,
      path: node.path,
      subtitle: node.subtitle,
      preview: node.preview,
      updatedAt: node.updatedAt,
    }] : [];
  });
  const ids = new Set(nodes.map((node) => node.id));
  const edges = atlas.edges
    .filter((edge) => ids.has(edge.source) && ids.has(edge.target) && edge.type !== "related")
    .map((edge) => ({ source: edge.source, target: edge.target, type: edge.type as "imports" | "contains" | "references" }));
  return {
    version: 1,
    generatedAt: atlas.generatedAt,
    workspace: atlas.workspace,
    nodes,
    edges,
    stats: {
      code: atlas.stats.code,
      documents: atlas.stats.documents,
      decisions: atlas.stats.decisions,
      sessions: atlas.stats.sessions,
      edges: edges.length,
      truncated: atlas.stats.truncated,
    },
  };
}

export async function getWorkspaceMemoryAtlas(input: GetWorkspaceMemoryAtlasInput): Promise<MemoryAtlasSnapshot> {
  let stores: Stores | null = null;
  try {
    if (input.config?.enabled !== false && input.config?.backend !== "off") {
      const baseDir = join(normalizeWorkspaceTag(input.workspace), ".kyrei", "index");
      stores = input.config?.backend === "postgres" && input.config.connectionString
        ? await createStoresAsync({ baseDir, backend: "postgres", connectionString: input.config.connectionString })
        : createStores(baseDir);
    }
    return await buildMemoryAtlas({
      ...input,
      ...(stores?.memory ? { memory: stores.memory } : {}),
    });
  } finally {
    if (stores) {
      try {
        await stores.close();
      } catch {
        // Atlas is read-only; cleanup failure must not discard a valid snapshot.
      }
    }
  }
}
